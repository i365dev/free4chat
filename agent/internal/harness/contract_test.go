package harness

import (
	"testing"

	"github.com/i365dev/free4chat/agent/internal/types"
)

// The shared ACP adapter must be the one full implementation of the semantic
// contract that the Runtime depends on.
func TestSharedACPAdapterSatisfiesContract(t *testing.T) {
	launcher, err := GetLauncher("pi")
	if err != nil {
		t.Fatalf("get pi launcher: %v", err)
	}
	adapter := NewACPAdapter(launcher, t.TempDir(), AdapterOptions{})
	contract, ok := ContractOf(adapter)
	if !ok || contract == nil {
		t.Fatal("the shared ACP adapter must satisfy the full semantic contract")
	}
	if contract.Name() != "pi" {
		t.Fatalf("contract name: got %q want pi", contract.Name())
	}
	if err := adapter.Close(); err != nil {
		t.Fatalf("close adapter: %v", err)
	}
}

// legacyOnlyAdapter implements exactly the mandatory base interface and
// nothing else, like the compatibility fakes the Runtime still supports.
type legacyOnlyAdapter struct{}

func (legacyOnlyAdapter) Name() string                             { return "legacy" }
func (legacyOnlyAdapter) Capabilities() *types.HarnessCapabilities { return nil }
func (legacyOnlyAdapter) EnsureSession() error                     { return nil }
func (legacyOnlyAdapter) SessionGeneration() int64                 { return 0 }
func (legacyOnlyAdapter) OnFailure(types.AdapterFailureHandler)    {}
func (legacyOnlyAdapter) CancelTurn() error                        { return nil }
func (legacyOnlyAdapter) Close() error                             { return nil }
func (legacyOnlyAdapter) RunTurn(types.HarnessTurnInput, int64) (types.HarnessTurnResult, error) {
	return types.HarnessTurnResult{}, nil
}

func TestLegacyAndNilAdaptersAreNotTheFullContract(t *testing.T) {
	if _, ok := ContractOf(legacyOnlyAdapter{}); ok {
		t.Fatal("a base-only adapter must not be mistaken for the full contract")
	}
	if _, ok := ContractOf(nil); ok {
		t.Fatal("a nil adapter must not be mistaken for the full contract")
	}
}

/*
 * fakeSemanticHarness is a non-ACP implementation of the whole contract. It
 * proves the semantic seam is implementable and testable WITHOUT raw ACP
 * internals: exact scope identity, exact conversation binding, and exact
 * cancel routing are contract properties, not ACP fixture details.
 */
type fakeSemanticHarness struct {
	loaded    string
	cancelled string
	owner     string
}

func (f *fakeSemanticHarness) Name() string { return "fake" }
func (f *fakeSemanticHarness) Capabilities() *types.HarnessCapabilities {
	return &types.HarnessCapabilities{Text: true}
}
func (f *fakeSemanticHarness) EnsureSession() error                  { return nil }
func (f *fakeSemanticHarness) SessionGeneration() int64              { return 1 }
func (f *fakeSemanticHarness) OnFailure(types.AdapterFailureHandler) {}
func (f *fakeSemanticHarness) CancelTurn() error                     { return nil }
func (f *fakeSemanticHarness) Close() error                          { return nil }
func (f *fakeSemanticHarness) RunTurn(types.HarnessTurnInput, int64) (types.HarnessTurnResult, error) {
	return types.HarnessTurnResult{Text: "ok"}, nil
}
func (f *fakeSemanticHarness) EnsureSessionFor(string) error            { return nil }
func (f *fakeSemanticHarness) EnsureSessionForCwd(string, string) error { return nil }
func (f *fakeSemanticHarness) SessionControlsFor(string) *types.HarnessSessionControls {
	return nil
}
func (f *fakeSemanticHarness) SetModeFor(string, string) error                 { return nil }
func (f *fakeSemanticHarness) SetConfigOptionFor(string, string, string) error { return nil }
func (f *fakeSemanticHarness) SessionGenerationFor(string) int64 {
	return 1
}
func (f *fakeSemanticHarness) RunTurnFor(string, types.HarnessTurnInput, int64) (types.HarnessTurnResult, error) {
	return types.HarnessTurnResult{Text: "ok"}, nil
}
func (f *fakeSemanticHarness) CancelTurnFor(scope string) error {
	f.cancelled = scope
	return nil
}
func (f *fakeSemanticHarness) TurnOwnerFor(string) (string, bool) {
	return f.owner, f.owner != ""
}
func (f *fakeSemanticHarness) ListSessions(ACPSessionListOptions) (ACPSessionPage, error) {
	return ACPSessionPage{}, nil
}
func (f *fakeSemanticHarness) LoadSession(scope string, sessionID string, cwd string) error {
	f.loaded = scope + "|" + sessionID + "|" + cwd
	return nil
}

func TestSemanticContractIsExercisableWithoutACP(t *testing.T) {
	fake := &fakeSemanticHarness{owner: "task:A"}
	contract, ok := ContractOf(fake)
	if !ok {
		t.Fatal("a non-ACP semantic implementation must satisfy the contract")
	}

	// Exact adoption: one scope binds one exact native conversation.
	if err := contract.LoadSession("task:A", "native-1", "/work"); err != nil {
		t.Fatalf("load: %v", err)
	}
	if fake.loaded != "task:A|native-1|/work" {
		t.Fatalf("exact conversation binding lost: %q", fake.loaded)
	}

	// Exact cancel routing: naming one scope never cancels another.
	if err := contract.CancelTurnFor("task:B"); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if fake.cancelled != "task:B" {
		t.Fatalf("cancel must carry the exact scope, got %q", fake.cancelled)
	}

	// Ownership is reported per scope without exposing native identity.
	owner, busy := contract.TurnOwnerFor("task:A")
	if owner != "task:A" || !busy {
		t.Fatalf("ownership: got %q/%v", owner, busy)
	}
}
