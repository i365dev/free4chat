//go:build darwin || linux

package harness

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Lane teardown ownership (#482).
 *
 * configureHarnessProcessGroup gives the provider its own process group, and
 * the hard stop signals that group. That reaches the provider and every
 * descendant that STAYED in the group. A provider/tool runner may instead put a
 * tool child into its own session/process group, and then:
 *
 *	SIGTERM(-providerPGID) -> provider exits -> proc.exited
 *	                       -> PROCESS_GROUP_QUIESCENT, detached tool still alive
 *
 * The tests below own every process explicitly: the tool child publishes its
 * own pid, and cleanup kills whatever the teardown missed, so a failing
 * assertion never leaks into the machine running the suite.
 */

type diagnosticRecorder struct {
	mu     sync.Mutex
	events []string
}

func (r *diagnosticRecorder) record(event string, _ map[string]string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, event)
}

func (r *diagnosticRecorder) count(event string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	total := 0
	for _, recorded := range r.events {
		if recorded == event {
			total++
		}
	}
	return total
}

// toolLauncher starts the scripted provider that parks its prompt forever while
// running one long tool child (detached => its own session/process group).
func toolLauncher(pidFile string, detached bool) types.AgentLauncher {
	mode := "attached_tool"
	if detached {
		mode = "detached_tool"
	}
	return scriptLauncher(mode, map[string]string{"FAKE_TOOL_PID_FILE": pidFile})
}

func readPIDFile(t *testing.T, path string, timeout time.Duration) int {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if raw, err := os.ReadFile(path); err == nil {
			if pid, convErr := strconv.Atoi(strings.TrimSpace(string(raw))); convErr == nil && pid > 0 {
				return pid
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("tool child never published its pid in %s", filepath.Base(path))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func processAlive(pid int) bool {
	if pid <= 1 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

// processGone waits for the process to disappear, and reports whether it did.
func processGone(pid int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if !processAlive(pid) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// killOwnedProcess is test cleanup, not product behavior: it removes any
// process the implementation under test failed to clean up.
func killOwnedProcess(pid int) {
	if pid > 1 {
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
}

func providerPID(t *testing.T, adapter *ACPAdapter) int {
	t.Helper()
	adapter.mu.Lock()
	defer adapter.mu.Unlock()
	if adapter.proc == nil || adapter.proc.cmd == nil || adapter.proc.cmd.Process == nil {
		t.Fatal("provider process was not started")
	}
	return adapter.proc.cmd.Process.Pid
}

// processParent reads the parent pid of an existing process (syscall.Getppid
// reports only the caller's own parent).
func processParent(t *testing.T, pid int) int {
	t.Helper()
	parent, ok := testProcessParent(pid)
	if !ok {
		t.Fatalf("parent of %d is unreadable", pid)
	}
	return parent
}

func startParkedTurn(t *testing.T, adapter *ACPAdapter) chan error {
	t.Helper()
	settled := make(chan error, 1)
	go func() {
		_, err := adapter.RunTurn(turnInput("run the long tool"), adapter.SessionGeneration())
		settled <- err
	}()
	return settled
}

func TestHardStopTerminatesDetachedToolDescendant(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "tool.pid")
	diagnostics := &diagnosticRecorder{}
	adapter := NewACPAdapter(toolLauncher(pidFile, true), t.TempDir(), AdapterOptions{
		CancelGraceMs:  50,
		DiagnosticSink: diagnostics.record,
	})
	t.Cleanup(func() { _ = adapter.Close() })

	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure session: %v", err)
	}
	provider := providerPID(t, adapter)
	settled := startParkedTurn(t, adapter)

	tool := readPIDFile(t, pidFile, 10*time.Second)
	t.Cleanup(func() { killOwnedProcess(tool) })
	if !processAlive(provider) {
		t.Fatalf("provider %d was not running before the control", provider)
	}
	if !processAlive(tool) {
		t.Fatalf("tool child %d was not running before the control", tool)
	}
	// The child is genuinely owned by this lane, and genuinely out of its
	// process group and session: that is the shape a group-only teardown
	// cannot reach. Ownership is read from the kernel, not from the provider.
	if got := processParent(t, tool); got != provider {
		t.Fatalf("tool child %d parent = %d, want provider %d", tool, got, provider)
	}
	providerGroup, groupErr := syscall.Getpgid(provider)
	toolGroup, toolGroupErr := syscall.Getpgid(tool)
	if groupErr != nil || toolGroupErr != nil || providerGroup == toolGroup {
		t.Fatalf("test setup: child %d group %v must differ from provider group %v", tool, toolGroupErr, groupErr)
	}
	providerSession, sessionErr := unix.Getsid(provider)
	toolSession, toolSessionErr := unix.Getsid(tool)
	if sessionErr != nil || toolSessionErr != nil || providerSession == toolSession {
		t.Fatalf("test setup: child %d session %v must differ from provider session %v", tool, toolSessionErr, sessionErr)
	}

	if err := adapter.CancelTurnFor("room"); err != nil {
		t.Fatalf("hard stop reported failure: %v", err)
	}
	select {
	case <-settled:
	case <-time.After(15 * time.Second):
		t.Fatal("the cancelled turn never settled")
	}

	if !processGone(provider, 5*time.Second) {
		t.Fatalf("provider %d survived the hard stop", provider)
	}
	// A provider exit is not lane quiescence. The Human's exact interrupt may
	// only settle once the tool execution this lane owns is really gone.
	if !processGone(tool, 5*time.Second) {
		t.Fatalf("owned detached tool child %d survived the hard stop", tool)
	}
	if diagnostics.count("PROCESS_GROUP_QUIESCENT") != 1 {
		t.Fatalf("expected exactly one quiescent report, got %v", diagnostics.events)
	}
	if diagnostics.count("PROCESS_GROUP_STILL_ALIVE") != 0 {
		t.Fatalf("lane claimed a non-quiescent teardown: %v", diagnostics.events)
	}
}

func TestHardStopLeavesDetachedChildOfOtherLaneAlive(t *testing.T) {
	dir := t.TempDir()
	// One pid file per LANE: the isolated adapter chooses which lane owns a
	// scope, so the test reads that assignment instead of assuming it.
	pidFiles := map[int]string{0: filepath.Join(dir, "lane0.pid"), 1: filepath.Join(dir, "lane1.pid")}
	lanes := map[int]*ACPAdapter{}
	adapter, err := NewIsolatedACPAdapterWithCapacity(2, func(lane int) *ACPAdapter {
		built := NewACPAdapter(toolLauncher(pidFiles[lane], true), t.TempDir(), AdapterOptions{CancelGraceMs: 50})
		lanes[lane] = built
		return built
	})
	if err != nil {
		t.Fatalf("isolated adapter: %v", err)
	}
	t.Cleanup(func() { _ = adapter.Close() })

	settled := map[string]chan error{}
	for _, scope := range []string{"task:req-A", "task:req-B"} {
		if err := adapter.EnsureSessionFor(scope); err != nil {
			t.Fatalf("EnsureSessionFor(%s): %v", scope, err)
		}
		settled[scope] = make(chan error, 1)
		go func(scope string) {
			_, runErr := adapter.RunTurnFor(scope, turnInput("run the long tool"), adapter.SessionGenerationFor(scope))
			settled[scope] <- runErr
		}(scope)
	}

	adapter.mu.Lock()
	laneA := adapter.scopeLane["task:req-A"]
	laneB := adapter.scopeLane["task:req-B"]
	adapter.mu.Unlock()
	if laneA == laneB {
		t.Fatalf("test needs two isolated lanes, both scopes landed on %d", laneA)
	}
	toolA := readPIDFile(t, pidFiles[laneA], 10*time.Second)
	toolB := readPIDFile(t, pidFiles[laneB], 10*time.Second)
	t.Cleanup(func() { killOwnedProcess(toolA) })
	t.Cleanup(func() { killOwnedProcess(toolB) })
	providerA := providerPID(t, lanes[laneA])
	providerB := providerPID(t, lanes[laneB])
	if got := processParent(t, toolA); got != providerA {
		t.Fatalf("Task A's tool %d parent = %d, want lane %d provider %d", toolA, got, laneA, providerA)
	}
	if got := processParent(t, toolB); got != providerB {
		t.Fatalf("Task B's tool %d parent = %d, want lane %d provider %d", toolB, got, laneB, providerB)
	}

	if err := adapter.CancelTurnFor("task:req-A"); err != nil {
		t.Fatalf("CancelTurnFor(task:req-A): %v", err)
	}
	select {
	case <-settled["task:req-A"]:
	case <-time.After(15 * time.Second):
		t.Fatal("Task A's turn never settled")
	}

	if !processGone(toolA, 5*time.Second) {
		t.Fatalf("Task A's owned tool child %d survived its own hard stop", toolA)
	}
	// Task B's lane owns a different provider process and a different tool
	// child: neither may be touched by Task A's teardown.
	if !processAlive(providerB) {
		t.Fatal("Task B's provider was terminated by Task A's hard stop")
	}
	if !processAlive(toolB) {
		t.Fatal("Task B's tool child was terminated by Task A's hard stop")
	}
}

func TestRepeatedHardStopLeavesNoOwnedDescendant(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "tool.pid")
	adapter := NewACPAdapter(toolLauncher(pidFile, true), t.TempDir(), AdapterOptions{CancelGraceMs: 50})
	t.Cleanup(func() { _ = adapter.Close() })

	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure session: %v", err)
	}
	provider := providerPID(t, adapter)
	settled := startParkedTurn(t, adapter)
	tool := readPIDFile(t, pidFile, 10*time.Second)
	t.Cleanup(func() { killOwnedProcess(tool) })

	for attempt := 1; attempt <= 2; attempt++ {
		if err := adapter.CancelTurnFor("room"); err != nil {
			t.Fatalf("hard stop %d reported failure: %v", attempt, err)
		}
	}
	select {
	case <-settled:
	case <-time.After(15 * time.Second):
		t.Fatal("the cancelled turn never settled")
	}

	if !processGone(provider, 5*time.Second) {
		t.Fatalf("provider %d survived repeated hard stop", provider)
	}
	if !processGone(tool, 5*time.Second) {
		t.Fatalf("owned detached tool child %d survived repeated hard stop", tool)
	}
}

func TestHardStopStillCleansSameProcessGroupChild(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "tool.pid")
	adapter := NewACPAdapter(toolLauncher(pidFile, false), t.TempDir(), AdapterOptions{CancelGraceMs: 50})
	t.Cleanup(func() { _ = adapter.Close() })

	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure session: %v", err)
	}
	provider := providerPID(t, adapter)
	settled := startParkedTurn(t, adapter)
	tool := readPIDFile(t, pidFile, 10*time.Second)
	t.Cleanup(func() { killOwnedProcess(tool) })
	providerGroup, groupErr := syscall.Getpgid(provider)
	toolGroup, toolGroupErr := syscall.Getpgid(tool)
	if groupErr != nil || toolGroupErr != nil || providerGroup != toolGroup {
		t.Fatalf("test setup: child %d group %v != provider group %v", tool, toolGroupErr, groupErr)
	}

	if err := adapter.CancelTurnFor("room"); err != nil {
		t.Fatalf("hard stop reported failure: %v", err)
	}
	select {
	case <-settled:
	case <-time.After(15 * time.Second):
		t.Fatal("the cancelled turn never settled")
	}

	if !processGone(provider, 5*time.Second) {
		t.Fatalf("provider %d survived the hard stop", provider)
	}
	if !processGone(tool, 5*time.Second) {
		t.Fatalf("same-group tool child %d survived the hard stop", tool)
	}
}

func TestHardStopForUnknownScopeIsANoOp(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "tool.pid")
	adapter := NewACPAdapter(toolLauncher(pidFile, true), t.TempDir(), AdapterOptions{CancelGraceMs: 50})
	t.Cleanup(func() { _ = adapter.Close() })

	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure session: %v", err)
	}
	provider := providerPID(t, adapter)
	settled := startParkedTurn(t, adapter)
	tool := readPIDFile(t, pidFile, 10*time.Second)
	t.Cleanup(func() { killOwnedProcess(tool) })

	if err := adapter.CancelTurnFor("task:req-absent"); err != nil {
		t.Fatalf("a cancel for an unknown scope must be a no-op, got %v", err)
	}
	if !processAlive(provider) || !processAlive(tool) {
		t.Fatal("an unknown-scope cancel terminated lane-owned processes")
	}

	_ = adapter.Close()
	<-settled
	if !processGone(tool, 5*time.Second) {
		t.Fatalf("owned detached tool child %d survived lane close", tool)
	}
}
