package harness

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

// DefaultIsolatedACPLaneCount is the conservative default for callers that
// have not selected a measured provider capacity. The implementation is
// deliberately slice-backed so N is a policy value rather than an A/B
// invariant.
const DefaultIsolatedACPLaneCount = 2

// Kept private for the original two-lane unit fixtures; new code should pass
// an explicit capacity through NewIsolatedACPAdapterWithCapacity.
const isolatedACPLaneCount = DefaultIsolatedACPLaneCount

// isolatedLaneAdapter is the bounded surface the lane owner needs from one
// process-backed ACP adapter. It is kept private so this spike does not add a
// second provider abstraction to the Runtime contract.
type isolatedLaneAdapter interface {
	types.HarnessAdapter
	types.ScopedHarnessAdapter
	types.ScopedProjectHarnessAdapter
	types.ScopedHarnessSessionControls
	types.ScopedTurnCanceller
	types.ScopedTurnOwnership
	SessionHandoff
	SessionDiagnostics() []types.HarnessSessionDiagnostic
	ReapIdle() error
	SetActivityHandler(ACPActivityHandler)
	SetPermissionResponder(ACPPermissionResponder)
	PermissionRequestLifetime() time.Duration
}

// IsolatedACPAdapter is an opt-in owner for a bounded set of ACP adapters. It
// starts no provider processes until a scope needs a session.
// The daemon selects it only for a provider policy that has earned
// cross-session execution; serial or uncertified providers continue to use
// one ACPAdapter.
//
// A scope remains pinned to its lane for its lifetime. Adopted native session
// ids also remain pinned, so two scopes naming one native session cannot be
// moved onto independent processes and accidentally execute concurrently.
type IsolatedACPAdapter struct {
	mu     sync.Mutex
	loadMu sync.Mutex

	lanes        []isolatedLaneAdapter
	capacity     int
	scopeLane    map[string]int
	sessionLane  map[string]int
	sessionScope map[string]string
	nextLane     int
	closed       bool

	onFailure       types.AdapterFailureHandler
	onScopedFailure types.ScopedAdapterFailureHandler
	activityHandler ACPActivityHandler
	permission      ACPPermissionResponder
}

// NewIsolatedACPAdapter builds the default number of lazy ACP process owners.
// The factory is
// called once per lane to create lightweight adapters; their provider
// processes are still started only by EnsureSession/EnsureSessionFor.
func NewIsolatedACPAdapter(factory func(lane int) *ACPAdapter) (*IsolatedACPAdapter, error) {
	return NewIsolatedACPAdapterWithCapacity(DefaultIsolatedACPLaneCount, factory)
}

// NewIsolatedACPAdapterWithCapacity builds exactly capacity lazy ACP process
// owners. Capacity is bounded by the caller's provider/resource policy; this
// constructor never grows it dynamically and never starts a warm pool.
func NewIsolatedACPAdapterWithCapacity(capacity int, factory func(lane int) *ACPAdapter) (*IsolatedACPAdapter, error) {
	if factory == nil {
		return nil, errors.New("isolated ACP lane factory is nil")
	}
	return newIsolatedACPAdapterWithCapacity(capacity, func(lane int) isolatedLaneAdapter {
		return factory(lane)
	})
}

func newIsolatedACPAdapter(factory func(lane int) isolatedLaneAdapter) (*IsolatedACPAdapter, error) {
	return newIsolatedACPAdapterWithCapacity(DefaultIsolatedACPLaneCount, factory)
}

func newIsolatedACPAdapterWithCapacity(capacity int, factory func(lane int) isolatedLaneAdapter) (*IsolatedACPAdapter, error) {
	if factory == nil {
		return nil, errors.New("isolated ACP lane factory is nil")
	}
	if capacity < 1 {
		return nil, errors.New("isolated ACP lane capacity must be positive")
	}
	owner := &IsolatedACPAdapter{
		lanes:        make([]isolatedLaneAdapter, capacity),
		capacity:     capacity,
		scopeLane:    map[string]int{"room": 0},
		sessionLane:  make(map[string]int),
		sessionScope: make(map[string]string),
	}
	for lane := range owner.lanes {
		adapter := factory(lane)
		if adapter == nil {
			return nil, fmt.Errorf("isolated ACP lane %d factory returned nil", lane)
		}
		owner.lanes[lane] = adapter
		adapter.SetActivityHandler(owner.activityHandler)
		adapter.SetPermissionResponder(owner.permission)
		laneID := lane
		adapter.OnFailure(func(err error) { owner.laneFailed(laneID, err) })
	}
	return owner, nil
}

func (a *IsolatedACPAdapter) Name() string {
	return fmt.Sprintf("%s (%d isolated lanes)", a.lanes[0].Name(), a.capacity)
}

// LaneCapacity reports the fixed bounded process-lane policy selected when
// this owner was constructed.
func (a *IsolatedACPAdapter) LaneCapacity() int { return a.capacity }

func (a *IsolatedACPAdapter) Capabilities() *types.HarnessCapabilities {
	return a.lanes[0].Capabilities()
}

func (a *IsolatedACPAdapter) EnsureSession() error {
	return a.lanes[0].EnsureSession()
}

func (a *IsolatedACPAdapter) SessionGeneration() int64 {
	return a.lanes[0].SessionGeneration()
}

func (a *IsolatedACPAdapter) RunTurn(input types.HarnessTurnInput, generation int64) (types.HarnessTurnResult, error) {
	return a.lanes[0].RunTurn(input, generation)
}

func (a *IsolatedACPAdapter) EnsureSessionFor(scope string) error {
	adapter, err := a.adapterForScope(scope, true)
	if err != nil {
		return err
	}
	return adapter.EnsureSessionFor(scope)
}

func (a *IsolatedACPAdapter) EnsureSessionForCwd(scope, cwd string) error {
	adapter, err := a.adapterForScope(scope, true)
	if err != nil {
		return err
	}
	return adapter.EnsureSessionForCwd(scope, cwd)
}

func (a *IsolatedACPAdapter) SessionControlsFor(scope string) *types.HarnessSessionControls {
	adapter, err := a.adapterForScope(scope, scope == "room")
	if err != nil {
		return nil
	}
	return adapter.SessionControlsFor(scope)
}

func (a *IsolatedACPAdapter) SetModeFor(scope, modeID string) error {
	adapter, err := a.adapterForScope(scope, false)
	if err != nil {
		return err
	}
	return adapter.SetModeFor(scope, modeID)
}

func (a *IsolatedACPAdapter) SetConfigOptionFor(scope, configID, value string) error {
	adapter, err := a.adapterForScope(scope, false)
	if err != nil {
		return err
	}
	return adapter.SetConfigOptionFor(scope, configID, value)
}

func (a *IsolatedACPAdapter) SessionGenerationFor(scope string) int64 {
	adapter, err := a.adapterForScope(scope, false)
	if err != nil {
		return 0
	}
	return adapter.SessionGenerationFor(scope)
}

func (a *IsolatedACPAdapter) RunTurnFor(scope string, input types.HarnessTurnInput, generation int64) (types.HarnessTurnResult, error) {
	adapter, err := a.adapterForScope(scope, false)
	if err != nil {
		return types.HarnessTurnResult{}, err
	}
	return adapter.RunTurnFor(scope, input, generation)
}

func (a *IsolatedACPAdapter) CancelTurn() error {
	return a.lanes[0].CancelTurn()
}

func (a *IsolatedACPAdapter) CancelTurnFor(scope string) error {
	adapter, err := a.adapterForScope(scope, false)
	if err != nil {
		return nil
	}
	return adapter.CancelTurnFor(scope)
}

func (a *IsolatedACPAdapter) TurnOwnerFor(scope string) (string, bool) {
	adapter, err := a.adapterForScope(scope, false)
	if err != nil {
		return "", false
	}
	return adapter.TurnOwnerFor(scope)
}

// ListSessions uses lane zero's view of the provider's session store. All
// built-in ACP providers expose one user-local store; loading a selected id
// pins it to the lane chosen for its logical scope.
func (a *IsolatedACPAdapter) ListSessions(options ACPSessionListOptions) (ACPSessionPage, error) {
	return a.lanes[0].ListSessions(options)
}

func (a *IsolatedACPAdapter) LoadSession(scope, sessionID, cwd string) error {
	a.loadMu.Lock()
	defer a.loadMu.Unlock()
	scope = strings.TrimSpace(scope)
	a.mu.Lock()
	if lane, exists := a.sessionLane[sessionID]; exists {
		if owner, bound := a.sessionScope[sessionID]; bound && owner != scope {
			a.scopeLane[scope] = lane
			a.mu.Unlock()
			return errors.New("ACP native session is already bound to another logical scope")
		}
		if current, pinned := a.scopeLane[scope]; pinned && current != lane {
			a.mu.Unlock()
			return errors.New("ACP native session is pinned to another isolated lane")
		}
		a.scopeLane[scope] = lane
		a.mu.Unlock()
		if err := a.lanes[lane].LoadSession(scope, sessionID, cwd); err != nil {
			return err
		}
		return nil
	}
	a.mu.Unlock()

	adapter, err := a.adapterForScope(scope, true)
	if err != nil {
		return err
	}
	if err := adapter.LoadSession(scope, sessionID, cwd); err != nil {
		return err
	}
	a.mu.Lock()
	a.sessionLane[sessionID] = a.scopeLane[scope]
	a.sessionScope[sessionID] = scope
	a.mu.Unlock()
	return nil
}

func (a *IsolatedACPAdapter) SessionDiagnostics() []types.HarnessSessionDiagnostic {
	var diagnostics []types.HarnessSessionDiagnostic
	for lane, adapter := range a.lanes {
		for _, item := range adapter.SessionDiagnostics() {
			diagnostics = append(diagnostics, item)
			a.mu.Lock()
			a.sessionLane[item.SessionID] = lane
			a.sessionScope[item.SessionID] = item.Scope
			a.mu.Unlock()
		}
	}
	sort.Slice(diagnostics, func(i, j int) bool { return diagnostics[i].Scope < diagnostics[j].Scope })
	return diagnostics
}

func (a *IsolatedACPAdapter) SetActivityHandler(handler ACPActivityHandler) {
	a.mu.Lock()
	a.activityHandler = handler
	lanes := a.lanes
	a.mu.Unlock()
	for _, adapter := range lanes {
		adapter.SetActivityHandler(handler)
	}
}

func (a *IsolatedACPAdapter) SetPermissionResponder(responder ACPPermissionResponder) {
	a.mu.Lock()
	a.permission = responder
	lanes := a.lanes
	a.mu.Unlock()
	for _, adapter := range lanes {
		adapter.SetPermissionResponder(responder)
	}
}

func (a *IsolatedACPAdapter) PermissionRequestLifetime() time.Duration {
	return a.lanes[0].PermissionRequestLifetime()
}

func (a *IsolatedACPAdapter) OnFailure(handler types.AdapterFailureHandler) {
	a.mu.Lock()
	a.onFailure = handler
	a.mu.Unlock()
}

func (a *IsolatedACPAdapter) OnScopedFailure(handler types.ScopedAdapterFailureHandler) {
	a.mu.Lock()
	a.onScopedFailure = handler
	a.mu.Unlock()
}

func (a *IsolatedACPAdapter) Close() error {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return nil
	}
	a.closed = true
	lanes := a.lanes
	a.mu.Unlock()
	var failures []error
	for i := len(lanes) - 1; i >= 0; i-- {
		if err := lanes[i].Close(); err != nil {
			failures = append(failures, fmt.Errorf("close ACP lane %d: %w", i, err))
		}
	}
	return errors.Join(failures...)
}

// ReapIdle closes only materialized lanes that have no active turn. Their
// underlying ACP adapters retain exact native-session identities, so a later
// continuation rematerializes with session/load rather than session/new.
func (a *IsolatedACPAdapter) ReapIdle() error {
	a.mu.Lock()
	lanes := append([]isolatedLaneAdapter(nil), a.lanes...)
	a.mu.Unlock()
	var failures []error
	for i, lane := range lanes {
		if err := lane.ReapIdle(); err != nil {
			failures = append(failures, fmt.Errorf("reap ACP lane %d: %w", i, err))
		}
	}
	return errors.Join(failures...)
}

func (a *IsolatedACPAdapter) adapterForScope(scope string, create bool) (isolatedLaneAdapter, error) {
	scope = strings.TrimSpace(scope)
	if scope == "" {
		return nil, errors.New("ACP logical scope is empty")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return nil, errors.New("isolated ACP adapter is closed")
	}
	if lane, ok := a.scopeLane[scope]; ok {
		return a.lanes[lane], nil
	}
	if !create {
		return nil, errors.New("ACP logical scope has no isolated lane")
	}
	counts := make([]int, a.capacity)
	for _, lane := range a.scopeLane {
		counts[lane]++
	}
	chosen := a.nextLane
	for offset := 1; offset < a.capacity; offset++ {
		candidate := (a.nextLane + offset) % a.capacity
		if counts[candidate] < counts[chosen] {
			chosen = candidate
		}
	}
	a.scopeLane[scope] = chosen
	a.nextLane = (chosen + 1) % a.capacity
	return a.lanes[chosen], nil
}

func (a *IsolatedACPAdapter) laneFailed(lane int, err error) {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return
	}
	var scopes []string
	for scope, owner := range a.scopeLane {
		if owner == lane {
			scopes = append(scopes, scope)
		}
	}
	sort.Strings(scopes)
	legacy := a.onFailure
	scoped := a.onScopedFailure
	a.mu.Unlock()
	if scoped != nil {
		scoped(scopes, err)
	}
	if legacy != nil {
		legacy(err)
	}
}

var _ Contract = (*IsolatedACPAdapter)(nil)
var _ types.HarnessSessionDiagnostics = (*IsolatedACPAdapter)(nil)
var _ types.ScopedAdapterFailureNotifier = (*IsolatedACPAdapter)(nil)
