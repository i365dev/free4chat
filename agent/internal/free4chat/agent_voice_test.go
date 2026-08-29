package free4chat

import "testing"

func TestParseAgentVoiceFailsClosedAndUsesCurrentParticipantIDs(t *testing.T) {
	grants := parseAgentVoice(map[string]any{
		"agent-a": map[string]any{"enabled": true, "enabledAt": float64(101)},
		"agent-b": map[string]any{"enabled": false, "enabledAt": float64(102)},
		"agent-c": map[string]any{"enabled": true, "enabledAt": "bad"},
		"agent-d": map[string]any{"enabled": true, "enabledAt": float64(1.5)},
		"agent-e": map[string]any{"enabled": true, "enabledAt": float64(1 << 63)},
	})
	if len(grants) != 1 || grants["agent-a"].EnabledAt != 101 {
		t.Fatalf("strict Agent Voice parse failed closed: %+v", grants)
	}
	if _, ok := grants["same-runtime-host"]; ok {
		t.Fatal("Runtime Host identity must never authorize a different Agent")
	}
}
