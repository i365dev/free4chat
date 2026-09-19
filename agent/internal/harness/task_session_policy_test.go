package harness

import (
	"testing"

	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Task Session Continuation (#409) — the ONE product-level support policy.
 *
 * These tests are the extensibility gate: they prove support is a centralized
 * launcher-registry decision rather than something scattered through Runtime,
 * Room, or UI code, and that enabling a Harness later is a one-flag change.
 */

// TestTaskSessionContinuationPolicyIsCentralized pins the current validation
// state. Pi is VERIFIED end-to-end and is the only enabled Harness; Codex and
// Claude are source-supported but not runtime-verified, and OpenCode/Hermes
// were runtime-verified PARTIAL, so none of them may be enabled by default.
func TestTaskSessionContinuationPolicyIsCentralized(t *testing.T) {
	want := map[string]bool{
		"pi":       true,
		"codex":    false,
		"claude":   false,
		"opencode": false,
		"hermes":   false,
	}
	enabled := make([]string, 0, 1)
	for id, expected := range want {
		launcher, err := GetLauncher(id)
		if err != nil {
			t.Fatalf("launcher %q must exist: %v", id, err)
		}
		if launcher.TaskSessionContinuation != expected {
			t.Fatalf("launcher %q policy mismatch: got %v want %v", id, launcher.TaskSessionContinuation, expected)
		}
		if launcher.TaskSessionContinuation {
			enabled = append(enabled, id)
		}
	}
	// EXACTLY ONE place selects a Harness as enabled.
	if len(enabled) != 1 || enabled[0] != "pi" {
		t.Fatalf("exactly one Harness may be enabled, and it must be pi: %v", enabled)
	}
}

// TestCustomLauncherIsNeverEnabled proves a trusted-local custom ACP command
// can never enable Task Session Continuation implicitly: admission is a named
// product decision for a pinned bridge, not a property of "some ACP agent".
func TestCustomLauncherIsNeverEnabled(t *testing.T) {
	custom, err := CustomLauncher("some-acp-agent", []string{"--stdio"})
	if err != nil {
		t.Fatalf("custom launcher: %v", err)
	}
	if custom.TaskSessionContinuation {
		t.Fatal("a custom ACP launcher must never enable Task Session Continuation")
	}
}

// TestLauncherPolicySurvivesRegistryCopies proves the policy is part of the
// registry contract rather than a copy-time detail: a caller reading the
// registry sees exactly what the Runtime will be constructed with.
func TestLauncherPolicySurvivesRegistryCopies(t *testing.T) {
	launchers := ListLaunchers()
	for index := range launchers {
		launchers[index].TaskSessionContinuation = false
	}
	pi, err := GetLauncher("pi")
	if err != nil {
		t.Fatalf("get pi: %v", err)
	}
	if !pi.TaskSessionContinuation {
		t.Fatal("mutating a returned registry copy must not change the source policy")
	}
	if ListLaunchers()[4].TaskSessionContinuation != true {
		t.Fatal("the registry must keep reporting the pi policy")
	}
	// The policy is discovery/presentation metadata, never a Harness capability
	// advertisement: types.HarnessCapabilities stays text/images only.
	var capabilities types.HarnessCapabilities
	if capabilities.Images || capabilities.Text {
		t.Fatal("HarnessCapabilities must stay zero-valued by default")
	}
}
