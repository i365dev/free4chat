package harness

import (
	"strings"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/types"
)

func TestDiagnosticsSnapshotUsesOpaqueSessionCorrelation(t *testing.T) {
	adapter, _ := newTestAdapter(t, scriptLauncher("session_echo", map[string]string{
		"FAKE_LOAD_CAP": "1",
	}), AdapterOptions{})
	t.Cleanup(func() { _ = adapter.Close() })
	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure session: %v", err)
	}
	snapshot := adapter.DiagnosticsSnapshot()
	if len(snapshot.Lanes) != 1 || snapshot.Lanes[0].ProviderPID == 0 {
		t.Fatalf("missing materialized lane snapshot: %+v", snapshot)
	}
	if snapshot.Lanes[0].SessionHash == "" || strings.Contains(snapshot.Lanes[0].SessionHash, "session-") {
		t.Fatalf("session correlation was not opaque: %+v", snapshot.Lanes[0])
	}
	if snapshot.Lanes[0].RSSKB < 0 || snapshot.Lanes[0].DescendantCount < 0 {
		t.Fatalf("invalid resource snapshot: %+v", snapshot.Lanes[0])
	}
}

func TestDiagnosticProviderSpecNeverIncludesCustomArgs(t *testing.T) {
	launcher := types.AgentLauncher{
		Command: "/opt/tools/custom-agent",
		Args:    []string{"--api-key", "sentinel-secret", "https://user:pass@example.invalid"},
	}
	spec := DiagnosticProviderSpec(launcher, true)
	if strings.Contains(spec, "sentinel-secret") || strings.Contains(spec, "example.invalid") {
		t.Fatalf("custom launcher args leaked into provider diagnostics: %q", spec)
	}
	if spec != "custom:custom-agent" {
		t.Fatalf("unexpected bounded custom provider identity: %q", spec)
	}
}

func TestDiagnosticsLifecycleDoesNotCarryNativeSessionIDs(t *testing.T) {
	var events []string
	adapter, _ := newTestAdapter(t, scriptLauncher("session_echo", nil), AdapterOptions{
		DiagnosticSink: func(event string, details map[string]string) {
			events = append(events, event)
			if strings.Contains(event, "session-") {
				t.Fatalf("event name carried native session id: %q", event)
			}
			for key, value := range details {
				if strings.Contains(value, "session-") {
					t.Fatalf("event detail %s carried native session id: %q", key, value)
				}
			}
		},
	})
	t.Cleanup(func() { _ = adapter.Close() })
	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure session: %v", err)
	}
	if len(events) == 0 || events[0] != "PROVIDER_MATERIALIZE_START" {
		t.Fatalf("missing bounded materialization event trail: %v", events)
	}
	joined := strings.Join(events, ",")
	if !strings.Contains(joined, "SESSION_NEW_START") || !strings.Contains(joined, "SESSION_NEW_OK") {
		t.Fatalf("missing session/new lifecycle events: %v", events)
	}
}
