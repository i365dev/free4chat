package harness

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

/*
 * #409 Task Session Continuation — discovery freshness.
 *
 * The product picker must reflect the PROVIDER's current sessions, not a
 * snapshot Free4Chat took once. These tests drive a real scripted ACP child and
 * change its session store WHILE THE SAME PROCESS KEEPS RUNNING, then prove the
 * next discovery observes the change without any restart, respawn, or
 * re-initialize.
 */

func TestACPListSessionsReflectsProviderChangesWithoutRestart(t *testing.T) {
	tracePath := filepath.Join(t.TempDir(), "acp-trace.log")
	extraPath := filepath.Join(t.TempDir(), "provider-sessions.txt")
	adapter, _ := newTestAdapter(t, scriptLauncher("normal", map[string]string{
		"FAKE_LIST_CAP":        "1",
		"FAKE_TRACE":           tracePath,
		"FAKE_LIST_EXTRA_FILE": extraPath,
	}), AdapterOptions{})
	defer adapter.Close()
	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure session: %v", err)
	}
	diagnosticsBefore := adapter.SessionDiagnostics()
	generationBefore := adapter.SessionGeneration()

	ids := func(page ACPSessionPage) []string {
		out := make([]string, 0, len(page.Sessions))
		for _, session := range page.Sessions {
			out = append(out, session.SessionID)
		}
		return out
	}

	// Discovery #1: the provider knows two sessions.
	first, err := adapter.ListSessions(ACPSessionListOptions{})
	if err != nil {
		t.Fatalf("first discovery: %v", err)
	}
	if got := ids(first); !reflect.DeepEqual(got, []string{"native-session-1", "native-session-2"}) {
		t.Fatalf("first discovery mismatch: %v", got)
	}

	// The provider gains a THIRD session while this exact ACP child keeps
	// running. Nothing about the adapter, the process, or the ACP session is
	// torn down or re-initialized.
	if err := os.WriteFile(extraPath, []byte("native-session-3|/workspace|Third native session\n"), 0o600); err != nil {
		t.Fatalf("grow the provider session store: %v", err)
	}

	// Discovery #2: the new session is visible IMMEDIATELY.
	second, err := adapter.ListSessions(ACPSessionListOptions{})
	if err != nil {
		t.Fatalf("second discovery: %v", err)
	}
	if got := ids(second); !reflect.DeepEqual(got, []string{
		"native-session-1", "native-session-2", "native-session-3",
	}) {
		t.Fatalf("the adapter cached the provider's session list: %v", got)
	}

	// SAME process, SAME retained ACP session: exactly one initialize frame
	// (a restart would handshake again) and an unchanged session identity.
	initializes := 0
	for _, frame := range readACPTraceFrames(t, tracePath) {
		if frame.Method == "initialize" {
			initializes++
		}
	}
	if initializes != 1 {
		t.Fatalf("the ACP child was restarted during discovery (%d initializes)", initializes)
	}
	if got := adapter.SessionDiagnostics(); !reflect.DeepEqual(got, diagnosticsBefore) {
		t.Fatalf("discovery changed the retained ACP session: %+v", got)
	}
	if adapter.SessionGeneration() != generationBefore {
		t.Fatalf("discovery advanced the ACP session generation: %d", adapter.SessionGeneration())
	}

	// A THIRD discovery after the provider REMOVES a session must also see the
	// change: the guarantee is "always fresh", not "append-only".
	if err := os.WriteFile(extraPath, nil, 0o600); err != nil {
		t.Fatalf("shrink the provider session store: %v", err)
	}
	third, err := adapter.ListSessions(ACPSessionListOptions{})
	if err != nil {
		t.Fatalf("third discovery: %v", err)
	}
	if got := ids(third); !reflect.DeepEqual(got, []string{"native-session-1", "native-session-2"}) {
		t.Fatalf("a removed session must disappear from discovery: %v", got)
	}
}

func TestACPListSessionsRematerializesAfterIdleReap(t *testing.T) {
	tracePath := filepath.Join(t.TempDir(), "acp-trace.log")
	adapter, _ := newTestAdapter(t, scriptLauncher("normal", map[string]string{
		"FAKE_LOAD_CAP": "1",
		"FAKE_LIST_CAP": "1",
		"FAKE_TRACE":    tracePath,
	}), AdapterOptions{IdleReapMs: 1})
	defer adapter.Close()
	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure session: %v", err)
	}
	if err := adapter.LoadSession("room", "native-session-after-reap", ""); err != nil {
		t.Fatalf("load native room session: %v", err)
	}
	loadedGeneration := adapter.SessionGeneration()
	if err := adapter.ReapIdle(); err != nil {
		t.Fatalf("reap provider: %v", err)
	}
	if _, hasProc, _, _, _ := adapterStateSnapshot(adapter); hasProc {
		t.Fatal("idle reap left the provider process alive")
	}

	page, err := adapter.ListSessions(ACPSessionListOptions{})
	if err != nil {
		t.Fatalf("list sessions after idle reap: %v", err)
	}
	if len(page.Sessions) != 2 {
		t.Fatalf("post-reap session discovery mismatch: %+v", page.Sessions)
	}
	if got := adapter.SessionDiagnostics(); len(got) != 1 || got[0].SessionID != "native-session-after-reap" {
		t.Fatalf("session discovery replaced the retained native conversation: %+v", got)
	}
	if adapter.SessionGeneration() <= loadedGeneration {
		t.Fatalf("post-reap discovery did not rematerialize the retained provider session: %d -> %d", loadedGeneration, adapter.SessionGeneration())
	}

	methods := make(map[string]int)
	for _, frame := range readACPTraceFrames(t, tracePath) {
		methods[frame.Method]++
	}
	if methods["initialize"] != 2 || methods["session/new"] != 1 || methods["session/load"] != 2 || methods["session/list"] != 1 {
		t.Fatalf("session discovery after reap must reload the exact Room session before listing: %v", methods)
	}
}

func TestIdleReapCallbackRespectsAnActiveDiscoveryHold(t *testing.T) {
	adapter, _ := newTestAdapter(t, scriptLauncher("normal", nil), AdapterOptions{})
	defer adapter.Close()
	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure session: %v", err)
	}

	adapter.mu.Lock()
	adapter.idleReapHolds++
	gen := adapter.gen
	adapter.mu.Unlock()
	if err := adapter.closeInternalWithRetentionGuarded(true, true, &gen); err != nil {
		t.Fatalf("guarded idle reap: %v", err)
	}
	if _, hasProc, _, _, _ := adapterStateSnapshot(adapter); !hasProc {
		t.Fatal("idle reap closed the provider while session discovery held it")
	}

	adapter.mu.Lock()
	adapter.idleReapHolds--
	adapter.mu.Unlock()
	if err := adapter.closeInternalWithRetentionGuarded(true, true, &gen); err != nil {
		t.Fatalf("idle reap after discovery hold ended: %v", err)
	}
	if _, hasProc, _, _, _ := adapterStateSnapshot(adapter); hasProc {
		t.Fatal("idle reap did not close the provider after the discovery hold ended")
	}
}
