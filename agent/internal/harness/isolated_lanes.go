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

const isolatedACPLaneCount = 2

// isolatedLaneAdapter is the bounded surface the lane owner needs from one
// process-backed ACP adapter. It is kept private so this spike does not add a
// second provider abstraction to the Runtime contract.
type isolatedLaneAdapter interface {
	types.HarnessAdapter
	types.ScopedHarnessAdapter
	types.ScopedTurnCanceller
	types.ScopedTurnOwnership
	SessionHandoff
	SessionDiagnostics() []types.HarnessSessionDiagnostic
	SetActivityHandler(ACPActivityHandler)
	SetPermissionResponder(ACPPermissionResponder)
	PermissionRequestLifetime() time.Duration
}

// IsolatedACPAdapter is an opt-in, spike-only owner for exactly two ACP
// adapters. It starts no provider processes until a scope needs a session.
// Production provider policy deliberately continues to use one ACPAdapter
// and serial Task execution until this lane model is approved separately.
//
// A scope remains pinned to its lane for its lifetime. Adopted native session
// ids also remain pinned, so two scopes naming one native session cannot be
// moved onto independent processes and accidentally execute concurrently.
type IsolatedACPAdapter struct {
	mu     sync.Mutex
	loadMu sync.Mutex

	lanes        [isolatedACPLaneCount]isolatedLaneAdapter
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

// NewIsolatedACPAdapter builds two lazy ACP process owners. The factory is
// called once per lane to create lightweight adapters; their provider
// processes are still started only by EnsureSession/EnsureSessionFor.
func NewIsolatedACPAdapter(factory func(lane int) *ACPAdapter) (*IsolatedACPAdapter, error) {
	if factory == nil {
		return nil, errors.New("isolated ACP lane factory is nil")
	}
	return newIsolatedACPAdapter(func(lane int) isolatedLaneAdapter {
		return factory(lane)
	})
}

func newIsolatedACPAdapter(factory func(lane int) isolatedLaneAdapter) (*IsolatedACPAdapter, error) {
	if factory == nil {
		return nil, errors.New("isolated ACP lane factory is nil")
	}
	owner := &IsolatedACPAdapter{
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
	return a.lanes[0].Name() + " (2 isolated lanes)"
}

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
	counts := [isolatedACPLaneCount]int{}
	for _, lane := range a.scopeLane {
		counts[lane]++
	}
	chosen := a.nextLane
	for offset := 1; offset < isolatedACPLaneCount; offset++ {
		candidate := (a.nextLane + offset) % isolatedACPLaneCount
		if counts[candidate] < counts[chosen] {
			chosen = candidate
		}
	}
	a.scopeLane[scope] = chosen
	a.nextLane = (chosen + 1) % isolatedACPLaneCount
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
