//go:build codexprobe

package harness

import (
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

// This real-provider spike is intentionally opt-in:
//
//	FREE4CHAT_RUN_CODEX_ISOLATION_PROBE=1 GOCACHE=/private/tmp/free4chat-448-go-cache \
//	  go test -tags=codexprobe ./internal/harness -run '^TestCodexIsolatedProcessLanesProbe$' -v
//
// It uses the built-in codex-acp pin and the locally installed Codex CLI. The
// ordinary deterministic fake-provider tests remain the CI regression suite.
func TestCodexIsolatedProcessLanesProbe(t *testing.T) {
	if os.Getenv("FREE4CHAT_RUN_CODEX_ISOLATION_PROBE") != "1" {
		t.Skip("set FREE4CHAT_RUN_CODEX_ISOLATION_PROBE=1 to run the real Codex probe")
	}

	provider, err := ProviderByID("codex")
	if err != nil {
		t.Fatal(err)
	}
	launcher := provider.Launcher()
	// Most hosts can use the built-in npx launcher directly. These opt-in
	// overrides let the probe use the exact cached bridge entry and an
	// installed Codex CLI when local npm bin-link configuration is broken.
	if entry := os.Getenv("FREE4CHAT_CODEX_ACP_NODE_ENTRY"); entry != "" {
		launcher.Command = os.Getenv("FREE4CHAT_CODEX_ACP_NODE")
		if launcher.Command == "" {
			launcher.Command = "node"
		}
		launcher.Args = []string{entry}
	}
	if codexPath := os.Getenv("FREE4CHAT_CODEX_PATH"); codexPath != "" {
		launcher.Environment["CODEX_PATH"] = codexPath
	}
	options := AdapterOptions{TurnTimeoutMs: 180_000, CancelGraceMs: 2_000, ControlTimeoutMs: 60_000}
	newAdapter := func() *ACPAdapter {
		return NewACPAdapter(launcher, t.TempDir(), options)
	}
	logProcessMetrics(t, "baseline-resident", processTree(os.Getpid()))
	adapterA, adapterB := newAdapter(), newAdapter()
	t.Cleanup(func() { _ = adapterA.Close(); _ = adapterB.Close() })

	startup := time.Now()
	if err := adapterA.EnsureSession(); err != nil {
		t.Fatalf("Codex lane A startup failed: %v", err)
	}
	startupA := time.Since(startup)
	logProcessMetrics(t, "idle-1-lane", processTree(adapterPID(adapterA)))
	startup = time.Now()
	if err := adapterB.EnsureSession(); err != nil {
		t.Fatalf("Codex lane B startup failed: %v", err)
	}
	startupB := time.Since(startup)
	pidA, pidB := adapterPID(adapterA), adapterPID(adapterB)
	if pidA == 0 || pidB == 0 || pidA == pidB {
		t.Fatalf("isolated lanes do not own distinct provider processes: A=%d B=%d", pidA, pidB)
	}
	if adapterSessionID(adapterA) == adapterSessionID(adapterB) {
		t.Fatal("independent provider processes returned the same native session id")
	}
	logProcessMetrics(t, "idle-2-lanes", append(processTree(pidA), processTree(pidB)...))
	cliVersion := "PATH-resolved"
	if codexPath := launcher.Environment["CODEX_PATH"]; codexPath != "" {
		if output, err := exec.Command(codexPath, "--version").Output(); err == nil {
			cliVersion = strings.TrimSpace(string(output))
		}
	}
	t.Logf("codex_acp_pin=@agentclientprotocol/codex-acp@1.12.0 codex_cli=%s startup_ms={A:%d,B:%d}", cliVersion, startupA.Milliseconds(), startupB.Milliseconds())

	if got := runCodexProbeTurn(t, adapterA, "Remember CODEWORD_ALPHA for this conversation. Reply with only READY."); !strings.Contains(got, "READY") {
		t.Fatalf("session A seed was not acknowledged: %q", got)
	}
	if got := runCodexProbeTurn(t, adapterB, "Remember CODEWORD_BETA for this conversation. Reply with only READY."); !strings.Contains(got, "READY") {
		t.Fatalf("session B seed was not acknowledged: %q", got)
	}
	answerA := runCodexProbeTurn(t, adapterA, "What is the codeword I asked you to remember? Reply with that codeword only.")
	answerB := runCodexProbeTurn(t, adapterB, "What is the codeword I asked you to remember? Reply with that codeword only.")
	if !strings.Contains(answerA, "CODEWORD_ALPHA") || strings.Contains(answerA, "CODEWORD_BETA") {
		t.Fatalf("session A context crossed or was lost: %q", answerA)
	}
	if !strings.Contains(answerB, "CODEWORD_BETA") || strings.Contains(answerB, "CODEWORD_ALPHA") {
		t.Fatalf("session B context crossed or was lost: %q", answerB)
	}
	t.Log("context_isolation=PASS stream_isolation=PASS (independent returned turn text)")

	// Both lanes must be in actual provider tool work before cancellation.
	// Try ACP session/cancel first; if it does not settle in ten seconds, the
	// exact owning process is closed as the coarse lane cancellation boundary.
	turnA := startCodexProbeTurn(adapterA, "Run the shell command sleep 47, wait for it to finish, then reply only TASK_A_DONE and CODEWORD_ALPHA.")
	sampleOne := startProcessSampler([]int{pidA})
	waitForProcessCommand(t, pidA, "sleep 47", 75*time.Second)
	peakOne := sampleOne()
	t.Logf("resources active-1-lane provider_processes_peak=%d rss_mb_peak=%.1f cpu_percent_peak=%.1f", peakOne.processes, float64(peakOne.rssKB)/1024, peakOne.cpu)
	if _, err := adapterA.RunTurnFor("room", codexProbeInput("This second turn must be refused while the same native session is busy."), adapterA.SessionGeneration()); err != ErrSessionPromptBusy {
		t.Fatalf("same-native-session turn was not serialized: %v", err)
	}
	t.Log("same_session_serialization=PASS")

	turnB := startCodexProbeTurn(adapterB, "Run the shell command sleep 39, wait for it to finish, then reply only TASK_B_DONE and CODEWORD_BETA.")
	sampleTwo := startProcessSampler([]int{pidA, pidB})
	waitForProcessCommand(t, pidB, "sleep 39", 75*time.Second)
	if !adapterHasActiveTurn(adapterA) || !adapterHasActiveTurn(adapterB) {
		t.Fatal("provider processes exposed tool children without both turns remaining active")
	}
	t.Log("concurrent_progress=PASS (both independent shell children overlapped)")
	peakTwo := sampleTwo()
	t.Logf("resources active-2-lanes provider_processes_peak=%d rss_mb_peak=%.1f cpu_percent_peak=%.1f", peakTwo.processes, float64(peakTwo.rssKB)/1024, peakTwo.cpu)

	idsA := processTreePIDs(pidA)
	cancelAt := time.Now()
	cancelMethod := "ACP cancel"
	if err := adapterA.CancelTurn(); err != nil {
		t.Logf("acp_cancel_dispatch=FAIL (%v)", err)
	}
	var cancelOutcome codexProbeOutcome
	cancelSettled := false
	select {
	case cancelOutcome = <-turnA:
		cancelSettled = true
	case <-time.After(10 * time.Second):
	}
	if cancelSettled {
		t.Logf("acp_cancel_settlement=PASS elapsed_ms=%d err=%v", time.Since(cancelAt).Milliseconds(), cancelOutcome.err)
	} else {
		t.Log("acp_cancel_settlement=FAIL within 10s; closing only lane A process")
		adapterA.forceClose()
		select {
		case cancelOutcome = <-turnA:
			t.Logf("process_cancel_settlement=PASS elapsed_ms=%d err=%v", time.Since(cancelAt).Milliseconds(), cancelOutcome.err)
		case <-time.After(8 * time.Second):
			t.Fatal("lane A did not settle after its own provider process was closed")
		}
	}
	if strings.Contains(cancelOutcome.result.Text, "TASK_A_DONE") || adapterHasActiveTurn(adapterA) {
		t.Fatalf("lane A did not settle its cancelled turn: active=%v text=%q", adapterHasActiveTurn(adapterA), cancelOutcome.result.Text)
	}
	commandStopped := !processHasCommand(pidA, "sleep 47")
	if !commandStopped {
		t.Log("acp_cancel_command_cleanup=FAIL; stopping only isolated lane A provider process")
		adapterA.forceClose()
		cancelMethod = "isolated lane A process close"
		commandStopped = waitGone(idsA, 8*time.Second)
	}
	if !commandStopped {
		t.Errorf("lane A command survived both ACP cancel and its provider process close: %v", alivePIDs(idsA))
	}
	if !adapterHasActiveTurn(adapterB) || !processHasCommand(pidB, "sleep 39") {
		t.Fatal("cancel/close of lane A stopped lane B's active provider work")
	}
	if !cancelSettled && !waitGone(idsA, 8*time.Second) {
		t.Errorf("lane A left provider process descendants after cancel/close: %v", alivePIDs(idsA))
	}
	outcomeB := awaitProbeOutcome(t, turnB, 70*time.Second, "lane B after lane A cancel")
	if outcomeB.err != nil || !strings.Contains(outcomeB.result.Text, "TASK_B_DONE") ||
		!strings.Contains(outcomeB.result.Text, "CODEWORD_BETA") ||
		strings.Contains(outcomeB.result.Text, "CODEWORD_ALPHA") {
		t.Fatalf("lane B did not continue with isolated history after lane A cancel: text=%q err=%v", outcomeB.result.Text, outcomeB.err)
	}
	t.Logf("cancel_isolation=PASS (A turn settled; %s stopped A command; B continued)", cancelMethod)

	// An unexpected bridge death must settle only its own turn while a second
	// provider process finishes normally.
	adapterC := newAdapter()
	t.Cleanup(func() { _ = adapterC.Close() })
	if err := adapterC.EnsureSession(); err != nil {
		t.Fatalf("Codex crash-probe lane startup failed: %v", err)
	}
	pidC := adapterPID(adapterC)
	turnC := startCodexProbeTurn(adapterC, "Run the shell command sleep 31 and then reply only TASK_C_DONE.")
	waitForProcessCommand(t, pidC, "sleep 31", 75*time.Second)
	turnD := startCodexProbeTurn(adapterB, "Run the shell command sleep 25 and then reply only TASK_D_DONE and CODEWORD_BETA.")
	waitForProcessCommand(t, pidB, "sleep 25", 75*time.Second)
	idsC := processTreePIDs(pidC)
	if err := adapterC.proc.cmd.Process.Kill(); err != nil {
		t.Fatalf("kill lane C provider bridge: %v", err)
	}
	failedC := awaitProbeOutcome(t, turnC, 8*time.Second, "crashed lane C")
	if failedC.err == nil {
		t.Fatalf("killed lane C unexpectedly returned success: %q", failedC.result.Text)
	}
	if !adapterHasActiveTurn(adapterB) || !processHasCommand(pidB, "sleep 25") {
		t.Fatal("crashing lane C stopped lane D's active provider work")
	}
	if !waitGone(idsC, 8*time.Second) {
		t.Errorf("crashed lane C left provider descendants: %v", alivePIDs(idsC))
	}
	passedD := awaitProbeOutcome(t, turnD, 50*time.Second, "healthy lane D after lane C crash")
	if passedD.err != nil || !strings.Contains(passedD.result.Text, "TASK_D_DONE") ||
		!strings.Contains(passedD.result.Text, "CODEWORD_BETA") {
		t.Fatalf("lane D did not finish after lane C crash: text=%q err=%v", passedD.result.Text, passedD.err)
	}
	t.Logf("crash_isolation=PASS lane_C_error=%v", failedC.err)

	// Normal shutdown and repeated create/destroy cycles exercise process and
	// resident-memory cleanup without issuing extra model turns.
	idsB := processTreePIDs(pidB)
	closeAAt := time.Now()
	if err := adapterA.Close(); err != nil {
		t.Errorf("normal lane A close: %v", err)
	}
	closeALatency := time.Since(closeAAt)
	if !waitGone(idsA, 8*time.Second) {
		t.Errorf("normal close left lane A descendants: %v", alivePIDs(idsA))
	}
	closeAt := time.Now()
	if err := adapterB.Close(); err != nil {
		t.Errorf("normal lane B close: %v", err)
	}
	closeLatency := time.Since(closeAt)
	if !waitGone(idsB, 8*time.Second) {
		t.Errorf("normal close left provider descendants: %v", alivePIDs(idsB))
	}
	t.Logf("normal_cleanup_ms={A:%d,B:%d} residual_processes={A:%d,B:%d}", closeALatency.Milliseconds(), closeLatency.Milliseconds(), len(alivePIDs(idsA)), len(alivePIDs(idsB)))

	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	for cycle := 1; cycle <= 3; cycle++ {
		cycleA, cycleB := newAdapter(), newAdapter()
		t.Cleanup(func() { _ = cycleA.Close(); _ = cycleB.Close() })
		if err := cycleA.EnsureSession(); err != nil {
			t.Fatalf("repeat cycle %d lane A startup: %v", cycle, err)
		}
		if err := cycleB.EnsureSession(); err != nil {
			t.Fatalf("repeat cycle %d lane B startup: %v", cycle, err)
		}
		cycleIDs := append(processTreePIDs(adapterPID(cycleA)), processTreePIDs(adapterPID(cycleB))...)
		_ = cycleA.Close()
		_ = cycleB.Close()
		if !waitGone(cycleIDs, 8*time.Second) {
			t.Fatalf("repeat cycle %d leaked provider processes: %v", cycle, alivePIDs(cycleIDs))
		}
		t.Logf("repeated_cycle=%d residual_processes=0", cycle)
	}
	runtime.GC()
	runtime.ReadMemStats(&after)
	t.Logf("go_heap_after_cycles_delta_kb=%d", int64(after.HeapAlloc-before.HeapAlloc)/1024)
	t.Log("permission_isolation=NOT_EXERCISED (no stable native Codex permission request in this probe)")
}

type codexProbeOutcome struct {
	result types.HarnessTurnResult
	err    error
}

func startCodexProbeTurn(adapter *ACPAdapter, text string) <-chan codexProbeOutcome {
	result := make(chan codexProbeOutcome, 1)
	go func() {
		turn, err := adapter.RunTurnFor("room", codexProbeInput(text), adapter.SessionGeneration())
		result <- codexProbeOutcome{result: turn, err: err}
	}()
	return result
}

func runCodexProbeTurn(t *testing.T, adapter *ACPAdapter, text string) string {
	t.Helper()
	outcome := awaitProbeOutcome(t, startCodexProbeTurn(adapter, text), 90*time.Second, "Codex probe turn")
	if outcome.err != nil {
		t.Fatalf("Codex probe turn failed: %v", outcome.err)
	}
	return outcome.result.Text
}

func codexProbeInput(text string) types.HarnessTurnInput {
	return types.HarnessTurnInput{
		Room:   types.RoomTurnContext{Ephemeral: true},
		Events: []types.HarnessEvent{{Sender: "Codex lane probe", Kind: types.KindHuman, Text: text, Addressed: true, Sequence: 1}},
	}
}

func awaitProbeOutcome(t *testing.T, result <-chan codexProbeOutcome, timeout time.Duration, what string) codexProbeOutcome {
	t.Helper()
	select {
	case outcome := <-result:
		return outcome
	case <-time.After(timeout):
		t.Fatalf("timed out waiting for %s", what)
		return codexProbeOutcome{}
	}
}

type probeProcess struct {
	pid, ppid int
	rssKB     int64
	cpu       float64
	command   string
}

type probePeak struct {
	processes int
	rssKB     int64
	cpu       float64
}

func startProcessSampler(roots []int) func() probePeak {
	stop := make(chan struct{})
	done := make(chan probePeak, 1)
	go func() {
		var peak probePeak
		sample := func() {
			var current probePeak
			for _, root := range roots {
				processes := processTree(root)
				current.processes += len(processes)
				for _, process := range processes {
					current.rssKB += process.rssKB
					current.cpu += process.cpu
				}
			}
			if current.processes > peak.processes {
				peak.processes = current.processes
			}
			if current.rssKB > peak.rssKB {
				peak.rssKB = current.rssKB
			}
			if current.cpu > peak.cpu {
				peak.cpu = current.cpu
			}
		}
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		sample()
		for {
			select {
			case <-ticker.C:
				sample()
			case <-stop:
				sample()
				done <- peak
				return
			}
		}
	}()
	return func() probePeak {
		close(stop)
		return <-done
	}
}

func processTree(root int) []probeProcess {
	output, err := exec.Command("ps", "-Ao", "pid=,ppid=,rss=,%cpu=,stat=,command=").Output()
	if err != nil {
		return nil
	}
	all := make(map[int]probeProcess)
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 6 {
			continue
		}
		pid, errPID := strconv.Atoi(fields[0])
		ppid, errPPID := strconv.Atoi(fields[1])
		rss, errRSS := strconv.ParseInt(fields[2], 10, 64)
		cpu, errCPU := strconv.ParseFloat(fields[3], 64)
		if errPID != nil || errPPID != nil || errRSS != nil || errCPU != nil {
			continue
		}
		all[pid] = probeProcess{pid: pid, ppid: ppid, rssKB: rss, cpu: cpu, command: strings.Join(fields[5:], " ")}
	}
	owned := map[int]bool{root: true}
	for changed := true; changed; {
		changed = false
		for pid, process := range all {
			if !owned[pid] && owned[process.ppid] {
				owned[pid] = true
				changed = true
			}
		}
	}
	out := make([]probeProcess, 0, len(owned))
	for pid := range owned {
		if process, ok := all[pid]; ok {
			out = append(out, process)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].pid < out[j].pid })
	return out
}

func adapterPID(adapter *ACPAdapter) int {
	adapter.mu.Lock()
	defer adapter.mu.Unlock()
	if adapter.proc == nil || adapter.proc.cmd == nil || adapter.proc.cmd.Process == nil {
		return 0
	}
	return adapter.proc.cmd.Process.Pid
}

func adapterSessionID(adapter *ACPAdapter) string {
	adapter.mu.Lock()
	defer adapter.mu.Unlock()
	return adapter.sessionID
}

func adapterHasActiveTurn(adapter *ACPAdapter) bool {
	adapter.mu.Lock()
	defer adapter.mu.Unlock()
	return len(adapter.activeTurns) > 0
}

func processTreePIDs(root int) []int {
	processes := processTree(root)
	ids := make([]int, 0, len(processes))
	for _, process := range processes {
		ids = append(ids, process.pid)
	}
	return ids
}

func processHasCommand(root int, command string) bool {
	for _, process := range processTree(root) {
		if strings.Contains(process.command, command) {
			return true
		}
	}
	return false
}

func waitForProcessCommand(t *testing.T, root int, command string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if processHasCommand(root, command) {
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatalf("Codex did not start the expected tool command %q under lane pid %d", command, root)
}

func waitGone(ids []int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if len(alivePIDs(ids)) == 0 {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return len(alivePIDs(ids)) == 0
}

func alivePIDs(ids []int) []int {
	alive := make([]int, 0)
	for _, pid := range ids {
		if pid <= 0 {
			continue
		}
		if err := syscall.Kill(pid, 0); err == nil {
			alive = append(alive, pid)
		}
	}
	return alive
}

func logProcessMetrics(t *testing.T, label string, processes []probeProcess) {
	t.Helper()
	var rssKB int64
	var cpu float64
	for _, process := range processes {
		rssKB += process.rssKB
		cpu += process.cpu
	}
	t.Logf("resources %s provider_processes=%d rss_mb=%.1f cpu_percent=%.1f", label, len(processes), float64(rssKB)/1024, cpu)
}
