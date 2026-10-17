//go:build codexprobe

package harness

import (
	"os"
	"strings"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/types"
)

// This opt-in integration probe uses the exact installed codex-acp bridge and
// a standalone ACPAdapter process. It does not connect to a Room or resident
// Runtime and never mutates Codex configuration.
func TestCodexRecommendedModelFallbackEndToEnd(t *testing.T) {
	if os.Getenv("FREE4CHAT_RUN_CODEX_RECOMMENDATION_PROBE") != "1" {
		t.Skip("set FREE4CHAT_RUN_CODEX_RECOMMENDATION_PROBE=1 to run the isolated Codex probe")
	}

	runtimeDir := os.Getenv("FREE4CHAT_CODEX_BRIDGE_RUNTIME_DIR")
	if runtimeDir == "" {
		t.Fatal("FREE4CHAT_CODEX_BRIDGE_RUNTIME_DIR must point to the existing Runtime bridge cache")
	}
	provider, err := ProviderByID("codex")
	if err != nil {
		t.Fatal(err)
	}
	launcher := provider.Launcher()
	if !BridgePrepared(runtimeDir, launcher) {
		t.Fatalf("installed bridge %s@%s is not present in the specified cache", launcher.BridgePackage, launcher.BridgeVersion)
	}

	adapter := NewACPAdapter(launcher, t.TempDir(), AdapterOptions{
		ControlTimeoutMs: 60_000,
		TurnTimeoutMs:    180_000,
		RuntimeDirectory: runtimeDir,
	})
	t.Cleanup(func() { _ = adapter.Close() })
	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("initialize installed ACP bridge/session: %s", probeErrorClass(err))
	}

	controls := adapter.SessionControls()
	option, ok := findConfigOption(controls.ConfigOptions, "model")
	if !ok || !isUnknownRecommendedModel(option) {
		t.Fatalf("negotiated model option was not the expected synthesized unknown: present=%t", ok)
	}
	previous := option.CurrentValue
	recommended := option.RecommendedValue
	if expected := os.Getenv("FREE4CHAT_EXPECTED_CODEX_MODEL"); expected != "" && previous != expected {
		t.Fatalf("installed default model did not match expected failing selection: got %q", previous)
	}

	applied, err := adapter.ApplySessionConfigFallbacksFor("room", nil)
	if err != nil {
		t.Fatalf("apply negotiated model recommendation: %s", probeErrorClass(err))
	}
	want := []types.AppliedSessionConfigFallback{{
		ConfigID: "model", PreviousValue: previous, EffectiveValue: recommended,
	}}
	if len(applied) != 1 || applied[0] != want[0] {
		t.Fatalf("applied fallback = %+v; want exactly %+v", applied, want)
	}
	if got := findCurrentConfigValue(t, adapter.SessionControls(), "model"); got != recommended {
		t.Fatalf("effective model = %q; want negotiated recommendation %q", got, recommended)
	}
	t.Logf("bridge=%s@%s model_before=%s current_entry=synthesized_description_null model_after=%s recommendation=advertised_and_negotiated", launcher.BridgePackage, launcher.BridgeVersion, previous, recommended)

	const token = "FREE4CHAT_HARMLESS_MODEL_PROBE_OK"
	result, err := adapter.RunTurn(turnInput("Reply with exactly this text and do not use tools: "+token), adapter.SessionGeneration())
	if err != nil {
		t.Fatalf("harmless Codex turn failed: %s", probeErrorClass(err))
	}
	if !strings.Contains(result.Text, token) {
		t.Fatal("harmless Codex turn completed without the expected reply token")
	}
	t.Log("negotiated_fallback=PASS harmless_codex_turn=PASS")
}
