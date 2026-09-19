package runtime

import (
	"strings"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/harness"
	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Task Session Continuation (#409) — Runtime discovery, tokenization, and the
 * EXACT prepared adoption.
 *
 * These tests pin the product contract, not the Pi-specific one:
 *
 *   - global discovery really omits the cwd filter, and an explicit project
 *     really sends the exact original cwd back;
 *   - nothing a browser can see carries a real ACP session id, a real cwd as
 *     identity, or a provider cursor;
 *   - Free4Chat's own disposable workspaces are hidden with path-aware
 *     containment, not a substring test;
 *   - a token belongs to exactly one Human, expires, and is consumed once;
 *   - a prepared adoption binds to its EXACT canonical Task id and to nothing
 *     else, and session/new is never issued for a scope that adopted one.
 */

// discoveryFixture is an adoption fixture whose resident has the launcher's
// product policy enabled and a daemon-owned disposable workspace root set.
type discoveryFixture struct {
	*adoptionFixture
}

func newDiscoveryFixture(t *testing.T, disposableRoot string) *discoveryFixture {
	t.Helper()
	adapter := newAdoptionAdapter("pi")
	client := newExecutionClient()
	logs := &logCapture{}
	rt := NewResidentRuntime(Options{
		InstanceID:              "pi-task-session",
		RoomID:                  "room-task-session",
		Name:                    "Pi",
		Client:                  client,
		Adapter:                 adapter,
		Log:                     logs.log,
		TaskSessionContinuation: true,
		DisposableWorkspaceRoot: disposableRoot,
	})
	rt.adoptJoin(types.JoinResult{
		ParticipantID:     "agent",
		ParticipantHandle: "room-secret",
		Cursor:            0,
		ExpiresAt:         time.Now().Add(time.Hour).UnixMilli(),
	})
	t.Cleanup(rt.Stop)
	return &discoveryFixture{adoptionFixture: &adoptionFixture{
		rt: rt, adapter: adapter, client: client, logs: logs,
	}}
}

// listControl runs one discovery request synchronously.
func (f *discoveryFixture) listControl(human, projectToken, pageToken string) types.ResidentSessionResult {
	return f.rt.runSessionControl(&types.ResidentSessionControl{
		Kind:               types.ResidentSessionControlList,
		RequestID:          "req-list",
		HumanParticipantID: human,
		ProjectToken:       projectToken,
		PageToken:          pageToken,
	})
}

// TestTaskSessionGlobalDiscoveryOmitsTheCwdFilter is the #409 §8 fence: with no
// project selection the Runtime must ask the adapter for a GLOBAL list, not for
// its own workspace directory.
func TestTaskSessionGlobalDiscoveryOmitsTheCwdFilter(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	setRoster(fixture.rt, "human-1")

	result := fixture.listControl("human-1", "", "")
	if result.OK != true {
		t.Fatalf("global discovery failed: %+v", result)
	}
	if got := fixture.adapter.count("list:global"); got != 1 {
		t.Fatalf("global discovery must send no cwd filter: %v", fixture.adapter.recorded())
	}
	if got := fixture.adapter.count("list:/"); got != 0 {
		t.Fatalf("global discovery must never substitute a path: %v", fixture.adapter.recorded())
	}
}

// TestTaskSessionProjectFilterSendsTheExactOriginalCwd proves the browser
// never round-trips a cwd: it sends the opaque project token, and the Runtime
// resolves it locally to the exact original path.
func TestTaskSessionProjectFilterSendsTheExactOriginalCwd(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	setRoster(fixture.rt, "human-1")
	fixture.adapter.sessions = []harness.ACPSessionInfo{
		{SessionID: "native-a", Cwd: "/private/tmp", Title: "tmp work", UpdatedAt: "2026-09-19T10:00:00Z"},
		{SessionID: "native-b", Cwd: "/home/me/project", Title: "project work", UpdatedAt: "2026-09-19T11:00:00Z"},
	}

	recent := fixture.listControl("human-1", "", "")
	if recent.OK != true || len(recent.Sessions) != 2 {
		t.Fatalf("recent discovery failed: %+v", recent)
	}
	var tmpToken string
	for _, row := range recent.Sessions {
		if row.ProjectLabel == "/private/tmp" {
			tmpToken = row.ProjectToken
		}
	}
	if tmpToken == "" {
		t.Fatalf("the project catalog did not expose the tmp project: %+v", recent.Projects)
	}

	filtered := fixture.listControl("human-1", tmpToken, "")
	if filtered.OK != true {
		t.Fatalf("project discovery failed: %+v", filtered)
	}
	if got := fixture.adapter.count("list:/private/tmp"); got != 1 {
		t.Fatalf("the project filter must send the exact original cwd: %v", fixture.adapter.recorded())
	}
	if len(filtered.Sessions) != 1 || filtered.Sessions[0].ProjectLabel != "/private/tmp" {
		t.Fatalf("project filter returned the wrong rows: %+v", filtered.Sessions)
	}
}

// TestTaskSessionResultCarriesNoRealIdentity is the privacy fence: a browser
// result contains opaque tokens and presentation text ONLY.
func TestTaskSessionResultCarriesNoRealIdentity(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	setRoster(fixture.rt, "human-1")
	fixture.adapter.sessions = []harness.ACPSessionInfo{{
		SessionID: "native-secret-id",
		Cwd:       "/home/me/private-project",
		Title:     "Secret conversation",
		UpdatedAt: "2026-09-19T10:00:00Z",
	}}

	result := fixture.listControl("human-1", "", "")
	if result.OK != true || len(result.Sessions) != 1 {
		t.Fatalf("discovery failed: %+v", result)
	}
	row := result.Sessions[0]
	if row.Token == "" || row.ProjectToken == "" {
		t.Fatalf("a row must carry opaque tokens: %+v", row)
	}
	if row.Token == "native-secret-id" || row.ProjectToken == "native-secret-id" {
		t.Fatal("a token must never be the real ACP session id")
	}
	encoded := renderSessionResult(result)
	for _, forbidden := range []string{"native-secret-id"} {
		if strings.Contains(encoded, forbidden) {
			t.Fatalf("the browser-facing result leaked %q: %s", forbidden, encoded)
		}
	}
	// The DISPLAY label is the only place a path may appear, and it is not an
	// identity field: it is never accepted back as a cwd.
	if row.ProjectLabel == "" {
		t.Fatalf("a row must carry a human-facing project label: %+v", row)
	}
	// The real ACP session id stays local and is exactly what a prepare loads.
	selection, found := fixture.rt.taskSessionSessions[row.Token]
	if !found || selection.sessionID != "native-secret-id" {
		t.Fatalf("the session token must resolve locally to the real session: %+v", selection)
	}
	if selection.cwd != "/home/me/private-project" {
		t.Fatalf("the token must resolve locally to the exact cwd: %+v", selection)
	}
}

// TestTaskSessionHidesDisposableWorkspaces proves the product picker hides
// Free4Chat's own throwaway resident sessions using path-aware containment.
func TestTaskSessionHidesDisposableWorkspaces(t *testing.T) {
	root := "/home/me/.free4chat-agent/workspaces"
	fixture := newDiscoveryFixture(t, root)
	setRoster(fixture.rt, "human-1")
	fixture.adapter.sessions = []harness.ACPSessionInfo{
		{SessionID: "resident-1", Cwd: root + "/11111111-2222-3333-4444-555555555555", Title: "throwaway"},
		{SessionID: "resident-2", Cwd: root, Title: "the root itself"},
		{SessionID: "real-1", Cwd: "/private/tmp", Title: "real tmp work"},
		{SessionID: "real-2", Cwd: "/home/me/project", Title: "real project work"},
		// A legitimate user project whose NAME merely contains the same text
		// must survive: the filter is not a substring test.
		{SessionID: "real-3", Cwd: "/home/me/code/free4chat-agent-notebook", Title: "lookalike"},
		// A sibling directory that shares a prefix with the root is NOT inside
		// it, and must also survive.
		{SessionID: "real-4", Cwd: root + "-backup", Title: "prefix sibling"},
	}

	result := fixture.listControl("human-1", "", "")
	if result.OK != true {
		t.Fatalf("discovery failed: %+v", result)
	}
	titles := make([]string, 0, len(result.Sessions))
	for _, row := range result.Sessions {
		titles = append(titles, row.Title)
	}
	joined := strings.Join(titles, ",")
	for _, hidden := range []string{"throwaway", "the root itself"} {
		if strings.Contains(joined, hidden) {
			t.Fatalf("a Runtime-owned disposable session was offered: %s", joined)
		}
	}
	for _, kept := range []string{"real tmp work", "real project work", "lookalike", "prefix sibling"} {
		if !strings.Contains(joined, kept) {
			t.Fatalf("a legitimate user session was hidden: %s", joined)
		}
	}
}

// TestTaskSessionTokensAreHumanBound proves another Human can never use a
// selection that was discovered for someone else.
func TestTaskSessionTokensAreHumanBound(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	setRoster(fixture.rt, "human-1", "human-2")

	discovered := fixture.listControl("human-1", "", "")
	if discovered.OK != true || len(discovered.Sessions) != 1 {
		t.Fatalf("discovery failed: %+v", discovered)
	}
	token := discovered.Sessions[0].Token

	other := fixture.rt.runSessionControl(&types.ResidentSessionControl{
		Kind:               types.ResidentSessionControlPrepare,
		RequestID:          "req-prepare-b",
		HumanParticipantID: "human-2",
		SessionToken:       token,
		TaskRequestID:      "req-B",
	})
	if other.OK {
		t.Fatal("another Human must never prepare a selection they did not discover")
	}
	if other.Error != types.ResidentSessionErrorExpired {
		t.Fatalf("unexpected error class: %q", other.Error)
	}
	// The token was consumed by the failed attempt, so a replay cannot succeed
	// either.
	replay := fixture.rt.runSessionControl(&types.ResidentSessionControl{
		Kind:               types.ResidentSessionControlPrepare,
		RequestID:          "req-prepare-a",
		HumanParticipantID: "human-1",
		SessionToken:       token,
		TaskRequestID:      "req-A",
	})
	if replay.OK {
		t.Fatal("a selection token must be single-use")
	}
}

// TestTaskSessionTokenExpiryAndReuse covers both bounded-token failure modes.
func TestTaskSessionTokenExpiryAndReuse(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	setRoster(fixture.rt, "human-1")

	discovered := fixture.listControl("human-1", "", "")
	token := discovered.Sessions[0].Token

	// Expire the token by hand: the cache is Runtime-local and TTL-bounded.
	fixture.rt.mu.Lock()
	selection := fixture.rt.taskSessionSessions[token]
	selection.expiresAt = time.Now().Add(-time.Second).UnixMilli()
	fixture.rt.taskSessionSessions[token] = selection
	fixture.rt.mu.Unlock()

	expired := fixture.rt.runSessionControl(&types.ResidentSessionControl{
		Kind:               types.ResidentSessionControlPrepare,
		RequestID:          "req-expired",
		HumanParticipantID: "human-1",
		SessionToken:       token,
		TaskRequestID:      "req-A",
	})
	if expired.OK || expired.Error != types.ResidentSessionErrorExpired {
		t.Fatalf("an expired selection must be refused as expired: %+v", expired)
	}
	if _, found := fixture.rt.taskSessionSessions[token]; found {
		t.Fatal("an expired token must be swept, not retained")
	}

	// One token can arm exactly one Task: a second prepare for a different
	// requestId must fail while the first is pending.
	again := fixture.listControl("human-1", "", "")
	second := again.Sessions[0].Token
	first := fixture.rt.runSessionControl(&types.ResidentSessionControl{
		Kind:               types.ResidentSessionControlPrepare,
		RequestID:          "req-first",
		HumanParticipantID: "human-1",
		SessionToken:       second,
		TaskRequestID:      "req-A",
	})
	if first.OK != true {
		t.Fatalf("the first prepare must succeed: %+v", first)
	}
	// A consumed token cannot be replayed even though the adoption is armed.
	replay := fixture.rt.runSessionControl(&types.ResidentSessionControl{
		Kind:               types.ResidentSessionControlPrepare,
		RequestID:          "req-replay",
		HumanParticipantID: "human-1",
		SessionToken:       second,
		TaskRequestID:      "req-B",
	})
	if replay.OK {
		t.Fatal("a consumed selection token must never prepare a second Task")
	}
}

// TestPreparedAdoptionBindsOnlyItsExactTask is the correctness core of the
// product path: an EXACT prepared adoption ignores every other canonical Task.
func TestPreparedAdoptionBindsOnlyItsExactTask(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1")

	if err := rt.ArmPreparedSessionAdoption("native-pi-1", "/workspace", "human-1", "req-A"); err != nil {
		t.Fatalf("arm prepared adoption: %v", err)
	}

	// A DIFFERENT canonical Task — even one that satisfies the CLI sequence
	// fence — must take the ordinary fresh path and leave the preparation
	// armed for its own Task.
	waitForDone(t, startTurn(rt, taskRequestEvent(1, "task:req-B", "req-B", "human-1")), "unrelated Task turn")
	if got := adapter.count("load:task:req-B"); got != 0 {
		t.Fatalf("an unrelated Task must never adopt the preparation: %v", adapter.recorded())
	}
	if got := adapter.count("new:task:req-B"); got != 1 {
		t.Fatalf("an unrelated Task must keep its fresh session: %v", adapter.recorded())
	}
	if adoption := rt.pendingAdoptionSnapshot(); adoption == nil || adoption.taskRequestID != "req-A" {
		t.Fatalf("the preparation must stay armed for its own Task: %+v", adoption)
	}

	// The EXACT Task adopts: load first, then the turn — and never session/new.
	waitForDone(t, startTurn(rt, taskRequestEvent(2, "task:req-A", "req-A", "human-1")), "prepared Task turn")
	loads := adapter.loadCalls()
	if len(loads) != 1 || loads[0].scope != "task:req-A" || loads[0].sessionID != "native-pi-1" {
		t.Fatalf("the prepared Task must load its exact native session: %+v", loads)
	}
	if got := adapter.count("new:task:req-A"); got != 0 {
		t.Fatalf("a prepared Task must never create a scoped session: %v", adapter.recorded())
	}
	if adoption := rt.pendingAdoptionSnapshot(); adoption != nil {
		t.Fatalf("the preparation must be consumed: %+v", adoption)
	}
	if !rt.isAdoptedScope("task:req-A") {
		t.Fatal("the prepared Task must be recorded as adopted")
	}
	assertNoSessionIDLeak(t, fixture.adoptionFixture, "native-pi-1")
}

// TestPreparedAdoptionLoadOrdering is the hard #417 proof, restated for the
// browser path: session/load strictly precedes the first Harness turn, and the
// scope issues ZERO session/new.
func TestPreparedAdoptionLoadOrdering(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1")

	if err := rt.ArmPreparedSessionAdoption("native-pi-1", "", "human-1", "req-A"); err != nil {
		t.Fatalf("arm prepared adoption: %v", err)
	}
	waitForDone(t, startTurn(rt, taskRequestEvent(1, "task:req-A", "req-A", "human-1")), "prepared Task turn")

	loadIndex := adapter.eventIndex("load:task:req-A")
	if loadIndex < 0 {
		t.Fatalf("session/load never ran: %v", adapter.recorded())
	}
	runIndex := -1
	for index, event := range adapter.recorded() {
		if strings.HasPrefix(event, "run:task:req-A") {
			runIndex = index
			break
		}
	}
	if runIndex < 0 {
		t.Fatalf("the prepared Task never ran a turn: %v", adapter.recorded())
	}
	if !(loadIndex < runIndex) {
		t.Fatalf("session/load must precede the first turn: %v", adapter.recorded())
	}
	for _, event := range adapter.recorded() {
		if strings.HasPrefix(event, "new:task:req-A") {
			t.Fatalf("a prepared Task issued session/new: %v", adapter.recorded())
		}
	}
}

// TestPreparedAdoptionExpiryNeverFallsBackToFreshSession is the #409 §24
// safety boundary: a preparation whose Task arrives too late must fail closed,
// and it must never make a LATER unrelated Task adopt anything.
func TestPreparedAdoptionExpiryNeverFallsBackToFreshSession(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1")

	if err := rt.ArmPreparedSessionAdoption("native-pi-1", "", "human-1", "req-X"); err != nil {
		t.Fatalf("arm prepared adoption: %v", err)
	}
	// Expire the preparation exactly as the append-failure window would.
	rt.mu.Lock()
	rt.pendingAdoption.expiresAt = time.Now().Add(-time.Second).UnixMilli()
	rt.mu.Unlock()

	// A completely different Task is unaffected: the expired preparation can
	// never bind to it.
	waitForDone(t, startTurn(rt, taskRequestEvent(1, "task:req-Y", "req-Y", "human-1")), "later Task turn")
	if got := adapter.count("load:task:req-Y"); got != 0 {
		t.Fatalf("an expired preparation must never adopt another Task: %v", adapter.recorded())
	}
	if got := adapter.count("new:task:req-Y"); got != 1 {
		t.Fatalf("an unrelated Task must keep its fresh session: %v", adapter.recorded())
	}

	// The Task the preparation was pinned to fails CLOSED instead of silently
	// starting a fresh conversation the Human did not ask for.
	waitForDone(t, startTurn(rt, taskRequestEvent(2, "task:req-X", "req-X", "human-1")), "late prepared Task")
	if got := adapter.count("new:task:req-X"); got != 0 {
		t.Fatalf("a late prepared Task must never start a fresh session: %v", adapter.recorded())
	}
	if got := adapter.count("load:task:req-X"); got != 0 {
		t.Fatalf("a late prepared Task must not load after its preparation expired: %v", adapter.recorded())
	}
	if !rt.isAdoptedScope("task:req-X") {
		t.Fatal("a late prepared Task must stay permanently bound to its lost conversation")
	}
}

// TestPreparedAdoptionRequiresAHumanOwnedExactTask proves a preparation can
// never be consumed by a Task that is not the pinning Human's.
func TestPreparedAdoptionRequiresAHumanOwnedExactTask(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1", "human-2")

	if err := rt.ArmPreparedSessionAdoption("native-pi-1", "", "human-1", "req-A"); err != nil {
		t.Fatalf("arm prepared adoption: %v", err)
	}
	// The exact requestId, but owned by a DIFFERENT Human.
	waitForDone(t, startTurn(rt, taskRequestEvent(1, "task:req-A", "req-A", "human-2")), "other Human's Task")
	if got := adapter.count("load:task:req-A"); got != 0 {
		t.Fatalf("a preparation must never bind to another Human's Task: %v", adapter.recorded())
	}
	if got := adapter.count("new:task:req-A"); got != 1 {
		t.Fatalf("the other Human's Task must take the fresh path: %v", adapter.recorded())
	}
}

// TestPreparedAdoptionRejectsASecondArm fences the incompatible-pending rule.
func TestPreparedAdoptionRejectsASecondArm(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	rt := fixture.rt
	if err := rt.ArmPreparedSessionAdoption("native-pi-1", "", "human-1", "req-A"); err != nil {
		t.Fatalf("arm prepared adoption: %v", err)
	}
	if err := rt.ArmPreparedSessionAdoption("native-pi-2", "", "human-1", "req-B"); err == nil {
		t.Fatal("a second exact preparation must not silently replace the first")
	}
	if adoption := rt.pendingAdoptionSnapshot(); adoption == nil || adoption.taskRequestID != "req-A" {
		t.Fatalf("the first preparation must survive: %+v", adoption)
	}
}

// TestPreparedAdoptionCancelIsExact fences the best-effort release: only the
// preparation it names is released.
func TestPreparedAdoptionCancelIsExact(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	rt := fixture.rt
	if err := rt.ArmPreparedSessionAdoption("native-pi-1", "", "human-1", "req-A"); err != nil {
		t.Fatalf("arm prepared adoption: %v", err)
	}
	wrong := rt.runSessionControl(&types.ResidentSessionControl{
		Kind:               types.ResidentSessionControlCancel,
		RequestID:          "req-cancel-wrong",
		HumanParticipantID: "human-1",
		TaskRequestID:      "req-Z",
	})
	if wrong.OK != true {
		t.Fatalf("a no-op cancel is not a failure: %+v", wrong)
	}
	if adoption := rt.pendingAdoptionSnapshot(); adoption == nil {
		t.Fatal("a cancel for another Task must not release this preparation")
	}
	exact := rt.runSessionControl(&types.ResidentSessionControl{
		Kind:               types.ResidentSessionControlCancel,
		RequestID:          "req-cancel",
		HumanParticipantID: "human-1",
		TaskRequestID:      "req-A",
	})
	if exact.OK != true {
		t.Fatalf("the exact cancel must succeed: %+v", exact)
	}
	if adoption := rt.pendingAdoptionSnapshot(); adoption != nil {
		t.Fatalf("the exact cancel must release the preparation: %+v", adoption)
	}
}

// TestTaskSessionPolicyIsTheOnlyGate proves discovery is refused by the
// launcher PRODUCT policy, never by ACP capability advertisement.
func TestTaskSessionPolicyIsTheOnlyGate(t *testing.T) {
	// A Pi-shaped adapter with the session primitives, but the policy off:
	// this is exactly what a non-enabled launcher looks like.
	adapter := newAdoptionAdapter("pi")
	rt := NewResidentRuntime(Options{
		InstanceID: "policy-off",
		RoomID:     "room-policy-off",
		Name:       "Pi",
		Client:     newExecutionClient(),
		Adapter:    adapter,
	})
	t.Cleanup(rt.Stop)
	rt.adoptJoin(types.JoinResult{
		ParticipantID:     "agent",
		ParticipantHandle: "room-secret",
		Cursor:            0,
		ExpiresAt:         time.Now().Add(time.Hour).UnixMilli(),
	})
	setRoster(rt, "human-1")

	if rt.CurrentRuntimeFeatures() != nil {
		t.Fatal("a policy-disabled resident must advertise no feature at all")
	}
	result := rt.runSessionControl(&types.ResidentSessionControl{
		Kind:               types.ResidentSessionControlList,
		RequestID:          "req-list",
		HumanParticipantID: "human-1",
	})
	if result.OK || result.Error != types.ResidentSessionErrorUnsupported {
		t.Fatalf("a policy-disabled resident must refuse discovery: %+v", result)
	}
	if got := adapter.count("list"); got != 0 {
		t.Fatalf("a refused discovery must never reach the adapter: %v", adapter.recorded())
	}
}

// TestTaskSessionFeatureProjectionIsAdditive proves the advertised projection
// is exactly the closed shape, and is absent when the policy is off.
func TestTaskSessionFeatureProjectionIsAdditive(t *testing.T) {
	enabled := newDiscoveryFixture(t, "")
	projection := enabled.rt.CurrentRuntimeFeatures()
	if projection == nil || !projection.TaskSessionContinuation {
		t.Fatalf("an enabled resident must advertise the feature: %+v", projection)
	}

	// A Harness that does not implement the session primitives cannot support
	// the feature even when its launcher policy says so.
	plain := NewResidentRuntime(Options{
		InstanceID:              "plain",
		RoomID:                  "room-plain",
		Name:                    "Pi",
		Client:                  newExecutionClient(),
		Adapter:                 &interruptAdapter{fakeAdapter: &fakeAdapter{name: "pi"}},
		TaskSessionContinuation: true,
	})
	t.Cleanup(plain.Stop)
	if plain.CurrentRuntimeFeatures() != nil {
		t.Fatal("a resident without the session primitives must not advertise the feature")
	}
}

// TestTaskSessionDiscoveryIsNeverCached is the freshness contract: every
// fresh discovery re-asks the Harness, so a provider that gained or lost a
// session between two discoveries is reflected IMMEDIATELY — on the same
// ResidentRuntime, with no restart, no reconnect, and no new ACP session.
func TestTaskSessionDiscoveryIsNeverCached(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1")
	adapter.sessions = []harness.ACPSessionInfo{
		{SessionID: "native-a", Cwd: "/home/me/project", Title: "Session A"},
		{SessionID: "native-b", Cwd: "/home/me/project", Title: "Session B"},
	}
	sessionsBefore := rt.options.Adapter

	titles := func(result types.ResidentSessionResult) []string {
		out := make([]string, 0, len(result.Sessions))
		for _, row := range result.Sessions {
			out = append(out, row.Title)
		}
		return out
	}

	first := fixture.listControl("human-1", "", "")
	if first.OK != true || strings.Join(titles(first), ",") != "Session A,Session B" {
		t.Fatalf("first discovery mismatch: %+v", first.Sessions)
	}

	// The PROVIDER gains a session while this exact Runtime and its exact ACP
	// child keep running.
	adapter.sessions = append(adapter.sessions, harness.ACPSessionInfo{
		SessionID: "native-c", Cwd: "/home/me/project", Title: "Session C",
	})

	second := fixture.listControl("human-1", "", "")
	if second.OK != true {
		t.Fatalf("second discovery failed: %+v", second)
	}
	if got := strings.Join(titles(second), ","); got != "Session A,Session B,Session C" {
		t.Fatalf("the Runtime cached the Harness session list: %s", got)
	}

	// The provider now LOSES a session: discovery is always fresh in both
	// directions, never an append-only accumulator.
	adapter.sessions = adapter.sessions[:2]
	third := fixture.listControl("human-1", "", "")
	if got := strings.Join(titles(third), ","); got != "Session A,Session B" {
		t.Fatalf("a removed session must disappear from discovery: %s", got)
	}

	// One adapter call per fresh discovery, and the same adapter object
	// throughout: nothing was restarted, respawned, or re-initialized.
	if got := adapter.count("list:global"); got != 3 {
		t.Fatalf("every fresh discovery must ask the Harness: %v", adapter.recorded())
	}
	if rt.options.Adapter != sessionsBefore {
		t.Fatal("discovery must never replace the resident's Harness adapter")
	}
	for _, event := range adapter.recorded() {
		if strings.HasPrefix(event, "new") {
			t.Fatalf("discovery must never create an ACP session: %v", adapter.recorded())
		}
	}
}

// TestTaskSessionExplicitRefreshRerunsDiscovery proves the picker's Refresh is
// a real Runtime -> Harness round trip rather than a re-render of browser
// state: it is exactly a fresh first-page `list` with no page token.
func TestTaskSessionExplicitRefreshRerunsDiscovery(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	setRoster(fixture.rt, "human-1")
	fixture.adapter.sessions = []harness.ACPSessionInfo{
		{SessionID: "native-a", Cwd: "/home/me/project", Title: "Session A"},
	}

	first := fixture.listControl("human-1", "", "")
	if first.OK != true || len(first.Sessions) != 1 {
		t.Fatalf("first discovery failed: %+v", first)
	}
	// A Refresh is a brand-new first page: it must not carry or consume the
	// previous page token, and it must not reuse a cached session token.
	fixture.adapter.sessions = []harness.ACPSessionInfo{
		{SessionID: "native-a", Cwd: "/home/me/project", Title: "Session A"},
		{SessionID: "native-b", Cwd: "/home/me/project", Title: "Session B"},
	}
	refreshed := fixture.listControl("human-1", "", "")
	if refreshed.OK != true || len(refreshed.Sessions) != 2 {
		t.Fatalf("a refresh must re-read the Harness: %+v", refreshed.Sessions)
	}
	if refreshed.Sessions[0].Token == first.Sessions[0].Token {
		t.Fatal("a refresh must mint fresh opaque tokens, not replay a stale one")
	}
	if got := fixture.adapter.count("list:global"); got != 2 {
		t.Fatalf("a refresh must hit the Harness: %v", fixture.adapter.recorded())
	}
	// The refreshed row still resolves to the real session, and the superseded
	// token still resolves too — both are bounded and Human-bound, and neither
	// is provider identity.
	selection, found := fixture.rt.taskSessionSessions[refreshed.Sessions[0].Token]
	if !found || selection.sessionID != "native-a" {
		t.Fatalf("the refreshed token must resolve locally: %+v", selection)
	}
}

// TestTaskSessionOnlyTokenMappingsAreRetained fences the cache contract: the
// Runtime keeps short-lived OPAQUE token mappings and nothing that could serve
// a session list by itself.
func TestTaskSessionOnlyTokenMappingsAreRetained(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	setRoster(fixture.rt, "human-1")
	fixture.adapter.sessions = []harness.ACPSessionInfo{
		{SessionID: "native-a", Cwd: "/home/me/project", Title: "Session A"},
	}

	discovered := fixture.listControl("human-1", "", "")
	if discovered.OK != true || len(discovered.Sessions) != 1 {
		t.Fatalf("discovery failed: %+v", discovered)
	}

	rt := fixture.rt
	rt.mu.Lock()
	defer rt.mu.Unlock()
	// The only retained per-session state is the opaque handle -> identity
	// mapping.
	for token, selection := range rt.taskSessionSessions {
		if token == "" || selection.sessionID == "" {
			t.Fatalf("a retained mapping is malformed: %q -> %+v", token, selection)
		}
		if selection.expiresAt <= time.Now().UnixMilli() {
			t.Fatalf("a retained mapping is already expired: %+v", selection)
		}
		if strings.Contains(token, selection.sessionID) {
			t.Fatal("a token must not embed the real session identity")
		}
	}
	// No page was left open by a single first-page discovery, and no project
	// handle was fabricated beyond the discovered rows.
	if len(rt.taskSessionPages) != 0 {
		t.Fatalf("a completed first page must leave no pagination handle: %+v", rt.taskSessionPages)
	}
	if len(rt.taskSessionProjects) > types.MaxResidentSessionProjects {
		t.Fatalf("the project catalog exceeded its bound: %d", len(rt.taskSessionProjects))
	}
}

// TestTaskSessionDiscoveryIsBoundedPerPage fences the product page bound: the
// Runtime never hands a browser a bulk export.
func TestTaskSessionDiscoveryIsBoundedPerPage(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	setRoster(fixture.rt, "human-1")
	sessions := make([]harness.ACPSessionInfo, 0, 25)
	for index := 0; index < 25; index++ {
		sessions = append(sessions, harness.ACPSessionInfo{
			SessionID: "native-" + itoa(int64(index)),
			Cwd:       "/home/me/project",
			Title:     "session " + itoa(int64(index)),
		})
	}
	fixture.adapter.sessions = sessions

	first := fixture.listControl("human-1", "", "")
	if first.OK != true {
		t.Fatalf("discovery failed: %+v", first)
	}
	if len(first.Sessions) != types.MaxResidentSessionRows {
		t.Fatalf("a page must be bounded to %d rows: %d", types.MaxResidentSessionRows, len(first.Sessions))
	}
	if !first.HasMore || first.NextPageToken == "" {
		t.Fatalf("a truncated page must offer an explicit continuation: %+v", first)
	}

	// Load more appends exactly the remainder of the SAME adapter page, then
	// continues with the provider cursor — with no duplicates and no loss.
	seen := map[string]struct{}{}
	for _, row := range first.Sessions {
		seen[row.Token] = struct{}{}
	}
	pageToken := first.NextPageToken
	pages := 1
	for pageToken != "" {
		if pages > 8 {
			t.Fatal("pagination did not terminate within its bound")
		}
		next := fixture.listControl("human-1", "", pageToken)
		if next.OK != true {
			t.Fatalf("continuation failed: %+v", next)
		}
		if len(next.Sessions) == 0 {
			t.Fatal("a continuation page returned no rows")
		}
		for _, row := range next.Sessions {
			if _, duplicate := seen[row.Token]; duplicate {
				t.Fatal("Load more returned a duplicate row")
			}
			seen[row.Token] = struct{}{}
		}
		pageToken = next.NextPageToken
		pages++
	}
	if len(seen) != 25 {
		t.Fatalf("pagination lost or duplicated rows: %d", len(seen))
	}
	if pages != 3 {
		t.Fatalf("expected three explicit pages, got %d", pages)
	}
}

// TestTaskSessionPageTokenIsSingleUse fences explicit pagination: a page token
// is consumed, never replayed.
func TestTaskSessionPageTokenIsSingleUse(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	setRoster(fixture.rt, "human-1")
	sessions := make([]harness.ACPSessionInfo, 0, 15)
	for index := 0; index < 15; index++ {
		sessions = append(sessions, harness.ACPSessionInfo{
			SessionID: "native-" + itoa(int64(index)),
			Cwd:       "/home/me/project",
			Title:     "session " + itoa(int64(index)),
		})
	}
	fixture.adapter.sessions = sessions

	first := fixture.listControl("human-1", "", "")
	if first.NextPageToken == "" {
		t.Fatal("expected a continuation token")
	}
	if second := fixture.listControl("human-1", "", first.NextPageToken); second.OK != true {
		t.Fatalf("the first use must succeed: %+v", second)
	}
	replay := fixture.listControl("human-1", "", first.NextPageToken)
	if replay.OK || replay.Error != types.ResidentSessionErrorExpired {
		t.Fatalf("a replayed page token must expire: %+v", replay)
	}
}

// TestTaskSessionUnknownProjectTokenExpires fences project-token handling: an
// unknown or another Human's handle is reported as expired, never silently
// treated as "Recent".
func TestTaskSessionUnknownProjectTokenExpires(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	setRoster(fixture.rt, "human-1", "human-2")
	discovered := fixture.listControl("human-1", "", "")
	projectToken := discovered.Sessions[0].ProjectToken

	unknown := fixture.listControl("human-1", "not-a-real-token", "")
	if unknown.OK || unknown.Error != types.ResidentSessionErrorExpired {
		t.Fatalf("an unknown project token must expire: %+v", unknown)
	}
	other := fixture.listControl("human-2", projectToken, "")
	if other.OK || other.Error != types.ResidentSessionErrorExpired {
		t.Fatalf("another Human's project token must expire: %+v", other)
	}
}

// TestTaskSessionConcurrentControlIsBounded proves the one-outstanding rule.
func TestTaskSessionConcurrentControlIsBounded(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	rt := fixture.rt
	rt.setTaskSessionControlBusy(true)
	defer rt.setTaskSessionControlBusy(false)

	stream := newResidentTestStream()
	rt.setResidentStream(stream)
	defer rt.clearResidentStream(stream)
	rt.dispatchSessionControl(stream, &types.ResidentSessionControl{
		Kind:               types.ResidentSessionControlList,
		RequestID:          "req-busy",
		HumanParticipantID: "human-1",
	})
	results := stream.sessionResultSnapshot()
	if len(results) != 1 || results[0].Error != types.ResidentSessionErrorBusy {
		t.Fatalf("a second control must be refused as busy: %+v", results)
	}
}

// renderSessionResult serializes a result the way the private transport would,
// so a leak assertion sees exactly what a Room/browser could observe.
func renderSessionResult(result types.ResidentSessionResult) string {
	builder := &strings.Builder{}
	builder.WriteString("operation=" + string(result.Kind))
	builder.WriteString(" requestId=" + result.RequestID)
	builder.WriteString(" error=" + string(result.Error))
	builder.WriteString(" nextPageToken=" + result.NextPageToken)
	for _, row := range result.Sessions {
		builder.WriteString(" row=" + row.Token + "|" + row.Title + "|" + row.ProjectToken + "|" + row.ProjectLabel + "|" + row.UpdatedAt)
	}
	for _, project := range result.Projects {
		builder.WriteString(" project=" + project.Token + "|" + project.Label)
	}
	return builder.String()
}
