package harness

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

type fakeIsolatedLane struct {
	index      int
	failure    types.AdapterFailureHandler
	ensured    []string
	cancelled  []string
	loaded     map[string]string
	closed     bool
	closeCount int
	activity   ACPActivityHandler
	permission ACPPermissionResponder
}

func (f *fakeIsolatedLane) Name() string { return "fake" }
func (f *fakeIsolatedLane) Capabilities() *types.HarnessCapabilities {
	return &types.HarnessCapabilities{Text: true}
}
func (f *fakeIsolatedLane) EnsureSession() error     { return nil }
func (f *fakeIsolatedLane) SessionGeneration() int64 { return 1 }
func (f *fakeIsolatedLane) RunTurn(types.HarnessTurnInput, int64) (types.HarnessTurnResult, error) {
	return types.HarnessTurnResult{Text: "room"}, nil
}
func (f *fakeIsolatedLane) OnFailure(handler types.AdapterFailureHandler) { f.failure = handler }
func (f *fakeIsolatedLane) CancelTurn() error                             { return nil }
func (f *fakeIsolatedLane) Close() error                                  { f.closed = true; f.closeCount++; return nil }
func (f *fakeIsolatedLane) EnsureSessionFor(scope string) error {
	f.ensured = append(f.ensured, scope)
	return nil
}
func (f *fakeIsolatedLane) SessionGenerationFor(string) int64 { return 1 }
func (f *fakeIsolatedLane) RunTurnFor(scope string, _ types.HarnessTurnInput, _ int64) (types.HarnessTurnResult, error) {
	return types.HarnessTurnResult{Text: scope}, nil
}
func (f *fakeIsolatedLane) CancelTurnFor(scope string) error {
	f.cancelled = append(f.cancelled, scope)
	return nil
}
func (f *fakeIsolatedLane) TurnOwnerFor(string) (string, bool) { return "", false }
func (f *fakeIsolatedLane) ListSessions(ACPSessionListOptions) (ACPSessionPage, error) {
	return ACPSessionPage{}, nil
}
func (f *fakeIsolatedLane) LoadSession(scope, sessionID, _ string) error {
	if f.loaded == nil {
		f.loaded = make(map[string]string)
	}
	f.loaded[scope] = sessionID
	return nil
}
func (f *fakeIsolatedLane) SessionDiagnostics() []types.HarnessSessionDiagnostic {
	var out []types.HarnessSessionDiagnostic
	for scope, id := range f.loaded {
		out = append(out, types.HarnessSessionDiagnostic{Scope: scope, SessionID: id, Generation: 1})
	}
	return out
}
func (f *fakeIsolatedLane) SetActivityHandler(handler ACPActivityHandler) { f.activity = handler }
func (f *fakeIsolatedLane) SetPermissionResponder(responder ACPPermissionResponder) {
	f.permission = responder
}
func (f *fakeIsolatedLane) PermissionRequestLifetime() time.Duration { return time.Minute }

func TestIsolatedACPAdapterPinsScopesAndReportsOnlyFailedLane(t *testing.T) {
	lanes := make([]*fakeIsolatedLane, isolatedACPLaneCount)
	adapter, err := newIsolatedACPAdapter(func(index int) isolatedLaneAdapter {
		lanes[index] = &fakeIsolatedLane{index: index}
		return lanes[index]
	})
	if err != nil {
		t.Fatal(err)
	}
	var failedScopes []string
	var failure error
	adapter.OnScopedFailure(func(scopes []string, err error) { failedScopes, failure = scopes, err })

	for _, scope := range []string{"task:req-alpha", "task:req-beta"} {
		if err := adapter.EnsureSessionFor(scope); err != nil {
			t.Fatal(err)
		}
	}
	alphaLane := adapter.scopeLane["task:req-alpha"]
	betaLane := adapter.scopeLane["task:req-beta"]
	if alphaLane == betaLane {
		t.Fatalf("independent sessions shared one provider lane: %d", alphaLane)
	}
	if err := adapter.EnsureSessionFor("task:req-alpha"); err != nil {
		t.Fatal(err)
	}
	if len(lanes[alphaLane].ensured) != 2 {
		t.Fatalf("scope did not remain on its original lane: %+v", lanes[alphaLane].ensured)
	}
	if err := adapter.CancelTurnFor("task:req-alpha"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(lanes[alphaLane].cancelled, []string{"task:req-alpha"}) || len(lanes[betaLane].cancelled) != 0 {
		t.Fatalf("cancel crossed lanes: alpha=%v beta=%v", lanes[alphaLane].cancelled, lanes[betaLane].cancelled)
	}

	boom := errors.New("lane process exited")
	lanes[alphaLane].failure(boom)
	if !reflect.DeepEqual(failedScopes, []string{"task:req-alpha"}) || !errors.Is(failure, boom) {
		t.Fatalf("failure was not scoped to lane A: scopes=%v err=%v", failedScopes, failure)
	}

	if err := adapter.Close(); err != nil {
		t.Fatal(err)
	}
	for lane, child := range lanes {
		if !child.closed || child.closeCount != 1 {
			t.Fatalf("lane %d not closed exactly once: %+v", lane, child)
		}
	}
}

func TestIsolatedACPAdapterKeepsAdoptedNativeSessionOnOneLane(t *testing.T) {
	lanes := make([]*fakeIsolatedLane, isolatedACPLaneCount)
	adapter, err := newIsolatedACPAdapter(func(index int) isolatedLaneAdapter {
		lanes[index] = &fakeIsolatedLane{index: index}
		return lanes[index]
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := adapter.LoadSession("task:req-alpha", "native-session-1", ""); err != nil {
		t.Fatal(err)
	}
	lane := adapter.scopeLane["task:req-alpha"]
	if got := adapter.SessionDiagnostics(); len(got) != 1 || got[0].SessionID != "native-session-1" {
		t.Fatalf("session diagnostic missing: %+v", got)
	}
	if err := adapter.LoadSession("task:req-beta", "native-session-1", ""); err == nil {
		t.Fatal("the same native session was rebound to a second logical scope")
	}
	if adapter.scopeLane["task:req-beta"] != lane {
		t.Fatal("the same native session id moved to a second provider lane")
	}
	if err := adapter.Close(); err != nil {
		t.Fatal(err)
	}
}
