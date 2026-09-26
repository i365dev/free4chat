//go:build hermesprobe

package harness

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// This real-provider probe is intentionally opt-in and is NOT part of CI:
//
//	FREE4CHAT_RUN_HERMES_TEARDOWN_PROBE=1 \
//	  go test -tags=hermesprobe ./internal/harness -run '^TestHermesToolDescendantTeardownProbe$' -v
//
// It runs one real Hermes shell tool call and then a Human exact interrupt
// through the ordinary adapter boundary, and asserts on the PROCESSES: the
// provider and the tool process it started must both be gone. Provider exit
// alone is never accepted as cleanup evidence.
func TestHermesToolDescendantTeardownProbe(t *testing.T) {
	if os.Getenv("FREE4CHAT_RUN_HERMES_TEARDOWN_PROBE") != "1" {
		t.Skip("set FREE4CHAT_RUN_HERMES_TEARDOWN_PROBE=1 to run the real Hermes probe")
	}
	provider, err := ProviderByID("hermes")
	if err != nil {
		t.Fatalf("hermes provider: %v", err)
	}
	launcher := provider.Launcher()
	t.Logf("hermes launcher: %s %v", launcher.Command, launcher.Args)

	pidFile := filepath.Join(t.TempDir(), "tool.pid")
	// FREE4CHAT_HERMES_PROBE_GRACE_MS lets the probe reproduce the release
	// timing where the hard stop preempts the provider's own cooperative tool
	// cleanup (the shipped grace is a short cooperative window).
	graceMs := int64(2_000)
	if raw := os.Getenv("FREE4CHAT_HERMES_PROBE_GRACE_MS"); raw != "" {
		if parsed, convErr := strconv.ParseInt(raw, 10, 64); convErr == nil && parsed >= 0 {
			graceMs = parsed
		}
	}
	adapter := NewACPAdapter(launcher, t.TempDir(), AdapterOptions{
		TurnTimeoutMs:  300_000,
		CancelGraceMs:  graceMs,
		DiagnosticSink: func(event string, details map[string]string) { t.Logf("DIAG %s %v", event, details) },
	})
	t.Cleanup(func() { _ = adapter.Close() })

	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure session: %v", err)
	}
	providerPID := providerPID(t, adapter)

	// The tool writes its own pid and then becomes the long-running process, so
	// the probe observes the exact process the turn started.
	command := fmt.Sprintf("sh -c 'echo $$ > %s; exec sleep 300'", pidFile)
	settled := make(chan error, 1)
	go func() {
		_, runErr := adapter.RunTurn(turnInput("Use your shell tool to run exactly this command and wait for it to finish: "+command), adapter.SessionGeneration())
		settled <- runErr
	}()

	toolPID := readPIDFile(t, pidFile, 180*time.Second)
	t.Cleanup(func() { killOwnedProcess(toolPID) })
	t.Logf("before control: provider=%d tool=%d %s", providerPID, toolPID, describeProcess(t, toolPID))

	// The lane's own ownership view at the moment of the control: this is what
	// the teardown boundary is allowed to reason about.
	ownership := snapshotLaneOwnership(providerPID)
	described := make([]string, 0, len(ownership.processes))
	for _, process := range ownership.processes {
		described = append(described, describeProcess(t, process.pid))
	}
	t.Logf("owned before cancel: %d known=%v [%s]", len(ownership.processes), ownership.known, strings.Join(described, " | "))

	if err := adapter.CancelTurnFor("room"); err != nil {
		t.Fatalf("exact hard stop reported failure: %v", err)
	}
	select {
	case <-settled:
	case <-time.After(30 * time.Second):
		t.Fatal("the cancelled turn never settled")
	}
	providerGone := processGone(providerPID, 15*time.Second)
	toolGone := processGone(toolPID, 15*time.Second)
	t.Logf("after control: provider_gone=%v tool_gone=%v tool=%d %s", providerGone, toolGone, toolPID, describeProcess(t, toolPID))
	if !providerGone {
		t.Fatalf("hermes provider %d survived the exact hard stop", providerPID)
	}
	if !toolGone {
		t.Fatalf("hermes tool process %d survived the exact hard stop", toolPID)
	}
}

// describeProcess reports the identity tuple the ownership boundary must be
// able to reason about: pid, parent, process group and session.
func describeProcess(t *testing.T, pid int) string {
	t.Helper()
	parts := []string{fmt.Sprintf("pid=%d", pid)}
	if parent, ok := testProcessParent(pid); ok {
		parts = append(parts, fmt.Sprintf("ppid=%d", parent))
	}
	if group, err := syscall.Getpgid(pid); err == nil {
		parts = append(parts, fmt.Sprintf("pgid=%d", group))
	}
	if session, err := unix.Getsid(pid); err == nil {
		parts = append(parts, fmt.Sprintf("sid=%d", session))
	}
	return strings.Join(parts, " ")
}
