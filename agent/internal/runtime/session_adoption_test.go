package runtime

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/harness"
	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Pi existing-session handoff (#409, V1).
 *
 * These tests pin the whole local contract against a deterministic fake ACP
 * adapter: the armed adoption binds to the canonical Human-owned Task,
 * session/load happens BEFORE any session/new for that scope, a genuinely new
 * scoped session is never created for an adopted Task (before the load, after
 * it, or after the native session is lost), and the ACP session id never
 * reaches any Room-facing or log surface.
 */

// adoptionLoadCall records one session/load request: exactly which native
// session the Runtime asked the adapter to continue, and for which scope.
type adoptionLoadCall struct {
	scope     string
	sessionID string
	cwd       string
}

// adoptionAdapter is a Pi-named adapter that records the exact order of every
// session lifecycle call per scope. "new:" is recorded only when a scoped
// session is ACTUALLY created (a real session/new), never merely because the
// Runtime re-checked an existing one — that distinction is the invariant under
// test.
type adoptionAdapter struct {
	*fakeAdapter
	recordMu sync.Mutex
	events   []string
	loads    []adoptionLoadCall
	sessions []harness.ACPSessionInfo
	loadErr  error
	listErr  error
}

func newAdoptionAdapter(name string) *adoptionAdapter {
	return &adoptionAdapter{
		fakeAdapter: &fakeAdapter{name: name},
		sessions: []harness.ACPSessionInfo{{
			SessionID: "native-pi-1",
			Cwd:       "/workspace",
			Title:     "Native Pi conversation",
			UpdatedAt: "2026-09-19T10:00:00Z",
		}},
	}
}

func (a *adoptionAdapter) record(event string) {
	a.recordMu.Lock()
	a.events = append(a.events, event)
	a.recordMu.Unlock()
}

func (a *adoptionAdapter) recorded() []string {
	a.recordMu.Lock()
	defer a.recordMu.Unlock()
	return append([]string(nil), a.events...)
}

func (a *adoptionAdapter) loadCalls() []adoptionLoadCall {
	a.recordMu.Lock()
	defer a.recordMu.Unlock()
	return append([]adoptionLoadCall(nil), a.loads...)
}

// count reports how many recorded events start with prefix.
func (a *adoptionAdapter) count(prefix string) int {
	total := 0
	for _, event := range a.recorded() {
		if strings.HasPrefix(event, prefix) {
			total++
		}
	}
	return total
}

// eventIndex returns the position of the first recorded event equal to want.
func (a *adoptionAdapter) eventIndex(want string) int {
	for index, event := range a.recorded() {
		if event == want {
			return index
		}
	}
	return -1
}

func (a *adoptionAdapter) ListSessions(cwd string, cursor string) (harness.ACPSessionPage, error) {
	a.record("list")
	if a.listErr != nil {
		return harness.ACPSessionPage{}, a.listErr
	}
	return harness.ACPSessionPage{Sessions: a.sessions, NextCursor: ""}, nil
}

// LoadSession continues the selected native session in exactly this scope, and
// registers it the same way the real adapter does: a later ensure for the scope
// must find an existing conversation and never issue session/new.
func (a *adoptionAdapter) LoadSession(scope string, sessionID string, cwd string) error {
	a.record("load:" + scope)
	a.recordMu.Lock()
	a.loads = append(a.loads, adoptionLoadCall{scope: scope, sessionID: sessionID, cwd: cwd})
	a.recordMu.Unlock()
	if a.loadErr != nil {
		return a.loadErr
	}
	return a.fakeAdapter.EnsureSessionFor(scope)
}

// EnsureSessionFor records a genuinely new scoped session only when one is
// actually created.
func (a *adoptionAdapter) EnsureSessionFor(scope string) error {
	before := a.fakeAdapter.scopedGenerationSnapshot(scope)
	if err := a.fakeAdapter.EnsureSessionFor(scope); err != nil {
		return err
	}
	if a.fakeAdapter.scopedGenerationSnapshot(scope) != before {
		a.record("new:" + scope)
	}
	return nil
}

func (a *adoptionAdapter) RunTurnFor(scope string, input types.HarnessTurnInput, expectedGeneration int64) (types.HarnessTurnResult, error) {
	a.record("run:" + scope)
	return a.fakeAdapter.RunTurnFor(scope, input, expectedGeneration)
}

// runCount reports how many Harness turns ran for one Task scope.
func (a *adoptionAdapter) runCount(scope string) int {
	_, details := a.fakeAdapter.scopedRunSnapshot()
	return len(details[scope])
}

// logCapture records every structured lifecycle event for the leak assertions.
type logCapture struct {
	mu     sync.Mutex
	events []string
}

func (c *logCapture) log(event string, details map[string]string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, event+" "+fmt.Sprint(details))
}

func (c *logCapture) snapshot() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.events...)
}

type adoptionFixture struct {
	rt      *ResidentRuntime
	adapter *adoptionAdapter
	client  *executionClient
	logs    *logCapture
}

func newAdoptionFixture(t *testing.T, name string) *adoptionFixture {
	t.Helper()
	adapter := newAdoptionAdapter(name)
	client := newExecutionClient()
	logs := &logCapture{}
	rt := NewResidentRuntime(Options{
		InstanceID: "pi-handoff",
		RoomID:     "room-pi-handoff",
		Name:       "Pi",
		Client:     client,
		Adapter:    adapter,
		Log:        logs.log,
	})
	rt.adoptJoin(types.JoinResult{
		ParticipantID:     "agent",
		ParticipantHandle: "room-secret",
		Cursor:            0,
		ExpiresAt:         time.Now().Add(time.Hour).UnixMilli(),
	})
	t.Cleanup(rt.Stop)
	return &adoptionFixture{rt: rt, adapter: adapter, client: client, logs: logs}
}

func setRoster(rt *ResidentRuntime, humans ...string) {
	roster := make([]types.ParticipantRosterEntry, 0, len(humans)+1)
	roster = append(roster, types.ParticipantRosterEntry{ID: "agent", Name: "Pi", Kind: types.KindAgent})
	for _, human := range humans {
		roster = append(roster, types.ParticipantRosterEntry{ID: human, Name: human, Kind: types.KindHuman})
	}
	rt.mu.Lock()
	rt.roster = roster
	rt.mu.Unlock()
}

// taskRequestEvent is one canonical Human -> this Agent Task trigger: the exact
// Room shape every existing Task control treats as Human-owned.
func taskRequestEvent(sequence int64, scope, requestID, humanID string) types.RoomEvent {
	event := scopedEvent(sequence, scope, "instruction for "+requestID)
	event.Type = "action"
	event.Participant = types.ParticipantIdentity{ID: humanID, Name: humanID, Kind: types.KindHuman}
	event.Collab = &types.WireCollabEvent{
		RequestID:           requestID,
		Kind:                types.CollabRequest,
		FromParticipantID:   humanID,
		TargetParticipantID: "agent",
		Summary:             "start " + requestID,
	}
	return event
}

// snapshotProjections copies every published Task execution projection under
// the client's own lock: publication happens on a Runtime-owned goroutine.
func (c *executionClient) snapshotProjections() []types.TaskExecutionProjection {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]types.TaskExecutionProjection(nil), c.projections...)
}

// assertNoSessionIDLeak proves the ACP session identity never reaches a
// Room-facing surface or the lifecycle log.
func assertNoSessionIDLeak(t *testing.T, fixture *adoptionFixture, sessionID string) {
	t.Helper()
	surfaces := map[string]string{
		"room text":       strings.Join(fixture.client.snapshotSent(), "\n"),
		"collab response": fmt.Sprint(fixture.client.snapshotCollabResponses()),
		"projection":      fmt.Sprint(fixture.client.snapshotProjections()),
		"logs":            strings.Join(fixture.logs.snapshot(), "\n"),
		"status":          fmt.Sprint(fixture.rt.Status()),
	}
	for surface, content := range surfaces {
		if strings.Contains(content, sessionID) {
			t.Fatalf("the ACP session id leaked into %s: %s", surface, content)
		}
	}
}

func TestSessionAdoptionBindsTheCanonicalHumanTask(t *testing.T) {
	fixture := newAdoptionFixture(t, "pi")
	rt, adapter, logs := fixture.rt, fixture.adapter, fixture.logs
	setRoster(rt, "human-1")

	if err := rt.ArmSessionAdoption("native-pi-1", "/workspace", "human-1"); err != nil {
		t.Fatalf("arm adoption: %v", err)
	}
	if armed, human := rt.SessionAdoptionState(); !armed || human != "human-1" {
		t.Fatalf("adoption state mismatch: armed=%v human=%q", armed, human)
	}

	waitForDone(t, startTurn(rt, taskRequestEvent(1, "task:req-T", "req-T", "human-1")), "adopted Task turn")

	// The decisive ordering proof: this scope LOADED the selected conversation
	// and never created one of its own — before or after the load.
	loads := adapter.loadCalls()
	if len(loads) != 1 {
		t.Fatalf("the Task scope must load exactly once, got %+v (%v)", loads, adapter.recorded())
	}
	if loads[0].scope != "task:req-T" || loads[0].sessionID != "native-pi-1" || loads[0].cwd != "/workspace" {
		t.Fatalf("the wrong session/scope/cwd was loaded: %+v", loads[0])
	}
	if got := adapter.count("new:task:req-T"); got != 0 {
		t.Fatalf("an adopted Task scope created a fresh session: %v", adapter.recorded())
	}
	loadIndex, runIndex := adapter.eventIndex("load:task:req-T"), adapter.eventIndex("run:task:req-T")
	if loadIndex < 0 || runIndex < loadIndex {
		t.Fatalf("session/load must precede the first Task turn: %v", adapter.recorded())
	}

	// Consumed exactly once; no session identity is retained afterward.
	if armed, _ := rt.SessionAdoptionState(); armed {
		t.Fatal("a bound adoption must not stay armed")
	}
	if scopes := rt.adoptedScopesSnapshot(); len(scopes) != 1 || scopes[0] != "task:req-T" {
		t.Fatalf("adopted scope set mismatch: %v", scopes)
	}

	// A follow-up reuses the adopted conversation and never creates a session.
	waitForDone(t, startTurn(rt, scopedEvent(2, "task:req-T", "follow-up instruction")), "follow-up turn")
	if got := adapter.runCount("task:req-T"); got != 2 {
		t.Fatalf("the follow-up did not run on the same Task scope: %v", adapter.recorded())
	}
	if got := adapter.count("new:task:req-T"); got != 0 {
		t.Fatalf("the follow-up created a fresh session: %v", adapter.recorded())
	}
	if got := len(adapter.loadCalls()); got != 1 {
		t.Fatalf("the follow-up re-loaded the native session: %v", adapter.recorded())
	}

	// The adoption is a local fact, not a Room fact.
	assertNoSessionIDLeak(t, fixture, "native-pi-1")
	found := false
	for _, line := range logs.snapshot() {
		if strings.HasPrefix(line, "session_adopted ") {
			found = true
		}
	}
	if !found {
		t.Fatalf("the adoption was not reported truthfully: %v", logs.snapshot())
	}
}

func TestSessionAdoptionWaitsForTheOwningHuman(t *testing.T) {
	fixture := newAdoptionFixture(t, "pi")
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1", "human-2")

	if err := rt.ArmSessionAdoption("native-pi-1", "", "human-1"); err != nil {
		t.Fatalf("arm adoption: %v", err)
	}

	// A different Human's Task must not consume the adoption: it takes the
	// normal fresh-scope path and the adoption stays armed.
	waitForDone(t, startTurn(rt, taskRequestEvent(1, "task:req-B", "req-B", "human-2")), "other Human's Task")
	if got := adapter.count("load:"); got != 0 {
		t.Fatalf("a different Human's Task consumed the adoption: %v", adapter.recorded())
	}
	if got := adapter.count("new:task:req-B"); got != 1 {
		t.Fatalf("the other Task lost its normal fresh-scope path: %v", adapter.recorded())
	}
	if armed, human := rt.SessionAdoptionState(); !armed || human != "human-1" {
		t.Fatalf("adoption was consumed by the wrong Human: armed=%v human=%q", armed, human)
	}

	// The owning Human's Task consumes it.
	waitForDone(t, startTurn(rt, taskRequestEvent(2, "task:req-A", "req-A", "human-1")), "owning Human's Task")
	if loads := adapter.loadCalls(); len(loads) != 1 || loads[0].scope != "task:req-A" {
		t.Fatalf("the owning Human's Task did not adopt: %+v (%v)", loads, adapter.recorded())
	}
	if got := adapter.count("new:task:req-A"); got != 0 {
		t.Fatalf("an adopted scope created a fresh session: %v", adapter.recorded())
	}
}

func TestSessionAdoptionRequiresOneHumanWhenUnpinned(t *testing.T) {
	fixture := newAdoptionFixture(t, "pi")
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1", "human-2")

	if err := rt.ArmSessionAdoption("native-pi-1", "", ""); err != nil {
		t.Fatalf("arm adoption: %v", err)
	}
	// Two Humans in the Room: an unpinned adoption must not bind either one.
	waitForDone(t, startTurn(rt, taskRequestEvent(1, "task:req-T", "req-T", "human-1")), "ambiguous Task")
	if got := adapter.count("load:"); got != 0 {
		t.Fatalf("an ambiguous Room bound the adoption: %v", adapter.recorded())
	}
	if armed, _ := rt.SessionAdoptionState(); !armed {
		t.Fatal("an unbound adoption must stay armed")
	}

	// With exactly one Human it binds normally.
	setRoster(rt, "human-1")
	waitForDone(t, startTurn(rt, taskRequestEvent(2, "task:req-U", "req-U", "human-1")), "single-Human Task")
	if loads := adapter.loadCalls(); len(loads) != 1 || loads[0].scope != "task:req-U" {
		t.Fatalf("the single-Human Task did not adopt: %+v (%v)", loads, adapter.recorded())
	}
}

func TestSessionAdoptionBindsExactlyOneTask(t *testing.T) {
	fixture := newAdoptionFixture(t, "pi")
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1")
	if err := rt.ArmSessionAdoption("native-pi-1", "", "human-1"); err != nil {
		t.Fatalf("arm adoption: %v", err)
	}

	// Two canonical Tasks are admitted before the serial drain runs: the
	// adoption must be consumed exactly once, by exactly one scope.
	rt.acceptEvent(taskRequestEvent(1, "task:req-A", "req-A", "human-1"))
	rt.acceptEvent(taskRequestEvent(2, "task:req-B", "req-B", "human-1"))
	drained := make(chan struct{})
	go func() {
		rt.drainTurns()
		close(drained)
	}()
	waitFor(t, 2*time.Second, func() bool {
		return adapter.runCount("task:req-A")+adapter.runCount("task:req-B") >= 2
	}, "both Task turns")
	waitForDone(t, drained, "both Task turns to settle")

	if loads := adapter.loadCalls(); len(loads) != 1 {
		t.Fatalf("exactly one Task may adopt, got %+v (%v)", loads, adapter.recorded())
	}
	if got := adapter.count("new:"); got != 1 {
		t.Fatalf("the non-adopted Task must keep its fresh session and the adopted one must not create any: %v", adapter.recorded())
	}
	if armed, _ := rt.SessionAdoptionState(); armed {
		t.Fatal("the adoption must be consumed")
	}
}

func TestSessionAdoptionLoadFailureNeverFallsBackToFreshSession(t *testing.T) {
	fixture := newAdoptionFixture(t, "pi")
	rt, adapter, client := fixture.rt, fixture.adapter, fixture.client
	setRoster(rt, "human-1")
	adapter.loadErr = errors.New("the native session is not resumable")

	if err := rt.ArmSessionAdoption("native-pi-1", "", "human-1"); err != nil {
		t.Fatalf("arm adoption: %v", err)
	}
	waitForDone(t, startTurn(rt, taskRequestEvent(1, "task:req-T", "req-T", "human-1")), "failed adopted Task")

	if loads := len(adapter.loadCalls()); loads != 1 {
		t.Fatalf("the load was not attempted exactly once: %v", adapter.recorded())
	}
	if got := adapter.count("new:task:req-T"); got != 0 {
		t.Fatalf("a failed adoption created a fresh session: %v", adapter.recorded())
	}
	if got := adapter.runCount("task:req-T"); got != 0 {
		t.Fatalf("a Harness turn ran without the adopted session: %v", adapter.recorded())
	}
	if armed, _ := rt.SessionAdoptionState(); armed {
		t.Fatal("a failed adoption must not stay armed")
	}
	// The truthful projection reports the adopted conversation as unavailable,
	// and it never claims a turn.
	lost := waitForExecution(t, client, "req-T", "session lost projection", func(p types.TaskExecutionProjection) bool {
		return p.Availability == types.TaskExecutionAvailabilitySessionLost
	})
	if lost.CurrentTurnSequence != 0 || lost.Phase != "" {
		t.Fatalf("a lost adopted session must not claim a current turn: %+v", lost)
	}

	// A later instruction still fails closed: the Task stays bound to the
	// conversation it could not adopt.
	waitForDone(t, startTurn(rt, scopedEvent(2, "task:req-T", "another instruction")), "later instruction")
	if got := adapter.count("new:task:req-T"); got != 0 {
		t.Fatalf("an adopted Task fell back to a fresh session: %v", adapter.recorded())
	}
	if got := adapter.runCount("task:req-T"); got != 0 {
		t.Fatalf("a replacement conversation ran a Harness turn: %v", adapter.recorded())
	}
	assertNoSessionIDLeak(t, fixture, "native-pi-1")
}

// TestAdoptedTaskFailsClosedAfterSessionLoss is the hard gate: once a Task has
// adopted a native conversation, losing the Harness must never silently
// continue that Task on a fresh one.
func TestAdoptedTaskFailsClosedAfterSessionLoss(t *testing.T) {
	fixture := newAdoptionFixture(t, "pi")
	rt, adapter, client := fixture.rt, fixture.adapter, fixture.client
	setRoster(rt, "human-1")
	if err := rt.ArmSessionAdoption("native-pi-1", "", "human-1"); err != nil {
		t.Fatalf("arm adoption: %v", err)
	}

	// One Free4Chat instruction continues the adopted conversation.
	waitForDone(t, startTurn(rt, taskRequestEvent(1, "task:req-T", "req-T", "human-1")), "adopted continuation")
	if loads := adapter.loadCalls(); len(loads) != 1 {
		t.Fatalf("the adoption did not load: %v", adapter.recorded())
	}

	// The Harness dies.
	adapter.fireFailure(errors.New("harness exited"))
	lost := waitForExecution(t, client, "req-T", "session lost projection", func(p types.TaskExecutionProjection) bool {
		return p.Availability == types.TaskExecutionAvailabilitySessionLost
	})
	if lost.CurrentTurnSequence != 0 {
		t.Fatalf("session loss still claimed a current turn: %+v", lost)
	}

	// The next instruction must NOT create a fresh session for the adopted Task
	// and must NOT run a replacement conversation.
	waitForDone(t, startTurn(rt, scopedEvent(2, "task:req-T", "instruction after loss")), "post-loss instruction")
	if got := adapter.count("new:task:req-T"); got != 0 {
		t.Fatalf("an adopted Task silently created a fresh session: %v", adapter.recorded())
	}
	if got := adapter.runCount("task:req-T"); got != 1 {
		t.Fatalf("an adopted Task ran a replacement conversation: %v", adapter.recorded())
	}
	if got := len(adapter.loadCalls()); got != 1 {
		t.Fatalf("the lost adoption was silently reloaded: %v", adapter.recorded())
	}
	// A normal Task in the same Runtime is unaffected by the loss.
	waitForDone(t, startTurn(rt, taskRequestEvent(3, "task:req-O", "req-O", "human-1")), "unrelated Task")
	if got := adapter.count("new:task:req-O"); got != 1 {
		t.Fatalf("an unrelated Task lost its fresh-scope path: %v", adapter.recorded())
	}
}

func TestSessionHandoffIsPiOnlyAndSinglePending(t *testing.T) {
	fixture := newAdoptionFixture(t, "pi")
	rt := fixture.rt

	if err := rt.ArmSessionAdoption("native-pi-1", "", ""); err != nil {
		t.Fatalf("arm adoption: %v", err)
	}
	if err := rt.ArmSessionAdoption("native-pi-2", "", ""); !errors.Is(err, errSessionAdoptionArmed) {
		t.Fatalf("a second pending adoption must be rejected, got %v", err)
	}
	if err := rt.ClearSessionAdoption(); err != nil {
		t.Fatalf("clear adoption: %v", err)
	}
	if err := rt.ClearSessionAdoption(); !errors.Is(err, errSessionAdoptionNotArmed) {
		t.Fatalf("clearing nothing must fail clearly, got %v", err)
	}
	if err := rt.ArmSessionAdoption("native-pi-2", "", ""); err != nil {
		t.Fatalf("re-arm after clear: %v", err)
	}
	// An unusable identity is rejected locally, before anything is armed.
	for _, invalid := range []string{"", "   ", "bad id", strings.Repeat("x", maxAdoptedSessionIDRunes+1)} {
		if err := rt.ClearSessionAdoption(); err != nil && !errors.Is(err, errSessionAdoptionNotArmed) {
			t.Fatalf("clear adoption: %v", err)
		}
		if err := rt.ArmSessionAdoption(invalid, "", ""); err == nil || errors.Is(err, errSessionAdoptionArmed) {
			t.Fatalf("invalid session id %q must be rejected, got %v", invalid, err)
		}
	}

	// A non-Pi Harness is rejected by name, never by capability advertisement.
	other := newAdoptionFixture(t, "codex")
	if err := other.rt.ArmSessionAdoption("native-1", "", ""); !errors.Is(err, errSessionAdoptionUnsupported) {
		t.Fatalf("non-Pi adoption must be rejected, got %v", err)
	}
	if _, err := other.rt.ListHarnessSessions("", ""); !errors.Is(err, errSessionAdoptionUnsupported) {
		t.Fatalf("non-Pi listing must be rejected, got %v", err)
	}

	// A Pi-named adapter without the session primitives is also rejected.
	plain := NewResidentRuntime(Options{
		InstanceID: "plain-pi",
		RoomID:     "room-plain",
		Name:       "Pi",
		Client:     newExecutionClient(),
		Adapter:    &interruptAdapter{fakeAdapter: &fakeAdapter{name: "pi"}},
	})
	t.Cleanup(plain.Stop)
	if err := plain.ArmSessionAdoption("native-1", "", ""); !errors.Is(err, errSessionAdoptionUnsupported) {
		t.Fatalf("a Pi adapter without session primitives must be rejected, got %v", err)
	}
}

func TestListHarnessSessionsIsBoundedLocalOutput(t *testing.T) {
	fixture := newAdoptionFixture(t, "pi")
	rt, adapter := fixture.rt, fixture.adapter

	page, err := rt.ListHarnessSessions("", "")
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	if len(page.Sessions) != 1 || page.Sessions[0].SessionID != "native-pi-1" {
		t.Fatalf("session descriptors mismatch: %+v", page.Sessions)
	}
	if page.NextCursor != "" {
		t.Fatalf("unexpected cursor: %q", page.NextCursor)
	}
	if adapter.count("list") != 1 {
		t.Fatalf("the adapter must own discovery: %v", adapter.recorded())
	}
	if rt.isStopped() {
		t.Fatal("discovery must not stop the Runtime")
	}
	adapter.listErr = errors.New("discovery unavailable")
	if _, err := rt.ListHarnessSessions("", ""); err == nil {
		t.Fatal("a failing discovery must surface the adapter error")
	}
}

// TestOrdinaryTaskKeepsTheExistingFreshSessionPath is the regression fence for
// the new admission boundary: with no adoption armed, a Task behaves exactly as
// before — one session/new, then the turn.
func TestOrdinaryTaskKeepsTheExistingFreshSessionPath(t *testing.T) {
	fixture := newAdoptionFixture(t, "pi")
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1")

	waitForDone(t, startTurn(rt, taskRequestEvent(1, "task:req-T", "req-T", "human-1")), "ordinary Task turn")
	if got := adapter.count("new:task:req-T"); got != 1 {
		t.Fatalf("an ordinary Task must keep its fresh scoped session: %v", adapter.recorded())
	}
	if got := adapter.count("load:"); got != 0 {
		t.Fatalf("an ordinary Task must not load anything: %v", adapter.recorded())
	}
	waitForDone(t, startTurn(rt, scopedEvent(2, "task:req-T", "follow-up")), "ordinary follow-up")
	if got := adapter.count("new:task:req-T"); got != 1 {
		t.Fatalf("an ordinary follow-up created a second session: %v", adapter.recorded())
	}
}

// TestRoomScopeIsUnaffectedByAdoption proves the existing Room conversation is
// untouched: adoption binds a Task scope, never the Room scope.
func TestRoomScopeIsUnaffectedByAdoption(t *testing.T) {
	fixture := newAdoptionFixture(t, "pi")
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1")
	if err := rt.ArmSessionAdoption("native-pi-1", "", "human-1"); err != nil {
		t.Fatalf("arm adoption: %v", err)
	}

	waitForDone(t, startTurn(rt, scopedEvent(1, roomScope, "room message")), "room turn")
	if adapter.sessionsInt() == 0 {
		t.Fatal("the Room-scope turn did not run")
	}
	if armed, _ := rt.SessionAdoptionState(); !armed {
		t.Fatal("a Room-scope turn must not consume a Task adoption")
	}
	if got := adapter.count("load:"); got != 0 {
		t.Fatalf("a Room-scope turn loaded a Task adoption: %v", adapter.recorded())
	}
}
