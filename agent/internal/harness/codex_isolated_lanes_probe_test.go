//go:build codexprobe

package harness

import (
	"context"
	"fmt"
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
	if mode := os.Getenv("FREE4CHAT_CODEX_PROBE_MODE"); mode != "" {
		launcher.Environment["INITIAL_AGENT_MODE"] = mode
	}
	type permissionEvent struct {
		lane    string
		request ACPPermissionRequest
	}
	permissionRequests := make(chan permissionEvent, 32)
	options := AdapterOptions{TurnTimeoutMs: 180_000, CancelGraceMs: 2_000, ControlTimeoutMs: 60_000}
	newAdapter := func(lane string) *ACPAdapter {
		localOptions := options
		// The real probe deliberately approves only the provider's own offered
		// option so its fixed shell commands can run. This is a local test seam,
		// not a production policy; recording lane and Scope exercises correlation.
		localOptions.PermissionResponder = func(_ context.Context, request ACPPermissionRequest) (ACPPermissionResponse, error) {
			select {
			case permissionRequests <- permissionEvent{lane: lane, request: request}:
			default:
			}
			for _, option := range request.Options {
				id := strings.ToLower(option.OptionID)
				if strings.Contains(id, "allow") || strings.Contains(id, "accept") || strings.Contains(id, "approve") {
					return ACPPermissionResponse{OptionID: option.OptionID}, nil
				}
			}
			if len(request.Options) > 0 {
				return ACPPermissionResponse{OptionID: request.Options[0].OptionID}, nil
			}
			return ACPPermissionResponse{}, nil
		}
		return NewACPAdapter(launcher, t.TempDir(), localOptions)
	}
	logProcessMetrics(t, "baseline-resident", processTree(os.Getpid()))
	adapterA, adapterB := newAdapter("A"), newAdapter("B")
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
	turnA := startCodexProbeTurn(adapterA, "Use your terminal tool now. Execute exactly `sleep 47`, wait for that command to finish, then reply only TASK_A_DONE and CODEWORD_ALPHA. Do not simulate the command.")
	sampleOne := startProcessSampler([]int{pidA})
	waitForProcessCommand(t, pidA, "sleep 47", 75*time.Second)
	peakOne := sampleOne()
	t.Logf("resources active-1-lane provider_processes_peak=%d rss_mb_peak=%.1f cpu_percent_peak=%.1f", peakOne.processes, float64(peakOne.rssKB)/1024, peakOne.cpu)
	if _, err := adapterA.RunTurnFor("room", codexProbeInput("This second turn must be refused while the same native session is busy."), adapterA.SessionGeneration()); err != ErrSessionPromptBusy {
		// Codex 0.154 can report the tool-bearing turn settled while its
		// descendant is still alive. That is the false-settled reproduction,
		// not a reason to stop the probe: the Runtime must hard-stop the lane
		// before any later continuation is allowed to materialize it.
		t.Logf("false_settled_reproduced=PASS same_session_second_turn_err=%v", err)
	} else {
		t.Log("same_session_serialization=PASS")
	}

	turnB := startCodexProbeTurn(adapterB, "Use your terminal tool now. Execute exactly `sleep 39`, wait for that command to finish, then reply only TASK_B_DONE and CODEWORD_BETA. Do not simulate the command.")
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
	permissionScopes := map[string]int{}
	for {
		select {
		case event := <-permissionRequests:
			permissionScopes[event.lane]++
		default:
			goto permissionDrainDone
		}
	}
permissionDrainDone:
	if permissionScopes["A"] > 0 && permissionScopes["B"] > 0 {
		t.Logf("permission_isolation=PASS scopes=%v (each decision was returned to its originating lane)", permissionScopes)
	} else {
		t.Log("permission_isolation=NOT_EXERCISED (Codex did not emit a native permission request)")
	}

	// Human interrupt does not respawn immediately. The next continuation must
	// materialize a new provider process and load A's exact retained native
	// session, with no fresh-session fallback and no stale cancelled output.
	if err := adapterA.EnsureSession(); err != nil {
		t.Fatalf("lane A exact session reload after hard-stop failed: %v", err)
	}
	recoveredA := runCodexProbeTurn(t, adapterA, "What codeword did I ask you to remember? Reply with the codeword only.")
	if !strings.Contains(recoveredA, "CODEWORD_ALPHA") || strings.Contains(recoveredA, "TASK_A_DONE") {
		t.Fatalf("lane A did not continue the exact retained session after hard-stop: %q", recoveredA)
	}
	t.Log("hard_stop_exact_session_reload=PASS retained_context=PASS stale_cancelled_output=PASS")

	// Repeat the same hard-stop -> later exact-load boundary once more. This
	// catches implementations that preserve identity only for the first
	// replacement process.
	turnA2 := startCodexProbeTurn(adapterA, "Use your terminal tool now. Execute exactly `sleep 17`, wait for that command to finish, then reply only TASK_A2_DONE. Do not simulate the command.")
	waitForProcessCommand(t, adapterPID(adapterA), "sleep 17", 75*time.Second)
	idsA2 := processTreePIDs(adapterPID(adapterA))
	if err := adapterA.CancelTurn(); err != nil {
		t.Fatalf("second lane A cancel failed: %v", err)
	}
	outcomeA2 := awaitProbeOutcome(t, turnA2, 15*time.Second, "second hard-stopped lane A turn")
	if outcomeA2.err == nil && strings.Contains(outcomeA2.result.Text, "TASK_A2_DONE") {
		t.Fatalf("second cancelled turn returned stale completion: %q", outcomeA2.result.Text)
	}
	if !waitGone(idsA2, 8*time.Second) {
		t.Fatalf("second hard-stop left lane A descendants: %v", alivePIDs(idsA2))
	}
	if err := adapterA.EnsureSession(); err != nil {
		t.Fatalf("second lane A exact session reload failed: %v", err)
	}
	recoveredA2 := runCodexProbeTurn(t, adapterA, "Reply with the retained codeword only.")
	if !strings.Contains(recoveredA2, "CODEWORD_ALPHA") {
		t.Fatalf("second exact reload lost retained context: %q", recoveredA2)
	}
	t.Log("repeated_hard_stop_exact_reload=PASS")

	// An unexpected bridge death must settle only its own turn while a second
	// provider process finishes normally.
	adapterC := newAdapter("C")
	t.Cleanup(func() { _ = adapterC.Close() })
	if err := adapterC.EnsureSession(); err != nil {
		t.Fatalf("Codex crash-probe lane startup failed: %v", err)
	}
	pidC := adapterPID(adapterC)
	turnC := startCodexProbeTurn(adapterC, "Use your terminal tool now. Execute exactly `sleep 31`, wait for it to finish, then reply only TASK_C_DONE. Do not simulate the command.")
	waitForProcessCommand(t, pidC, "sleep 31", 75*time.Second)
	turnD := startCodexProbeTurn(adapterB, "Use your terminal tool now. Execute exactly `sleep 25`, wait for it to finish, then reply only TASK_D_DONE and CODEWORD_BETA. Do not simulate the command.")
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
		cycleA, cycleB := newAdapter("cycle-A"), newAdapter("cycle-B")
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
}

// TestCodexBoundedResourceProbe measures the lazy provider model without
// starting model turns. It is intentionally opt-in because it launches up to
// four real Codex ACP processes and is evidence for the issue/PR report, not
// a CI test.
func TestCodexBoundedResourceProbe(t *testing.T) {
	if os.Getenv("FREE4CHAT_RUN_CODEX_RESOURCE_PROBE") != "1" {
		t.Skip("set FREE4CHAT_RUN_CODEX_RESOURCE_PROBE=1 to run the resource probe")
	}
	provider, err := ProviderByID("codex")
	if err != nil {
		t.Fatal(err)
	}
	launcher := provider.Launcher()
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
	adapters := make([]*ACPAdapter, 0, 4)
	t.Cleanup(func() {
		for _, adapter := range adapters {
			_ = adapter.Close()
		}
	})
	for count := 1; count <= 4; count++ {
		adapter := NewACPAdapter(launcher, t.TempDir(), options)
		adapters = append(adapters, adapter)
		started := time.Now()
		if err := adapter.EnsureSession(); err != nil {
			t.Fatalf("resource probe lane %d startup failed: %v", count, err)
		}
		roots := make([]int, 0, len(adapters))
		for _, candidate := range adapters {
			if pid := adapterPID(candidate); pid != 0 {
				roots = append(roots, pid)
			}
		}
		logProcessMetrics(t, fmt.Sprintf("resource-idle-%d-lanes", count), processTreeForRoots(roots))
		t.Logf("resource startup lane=%d startup_ms=%d", count, time.Since(started).Milliseconds())
	}
	for index, adapter := range adapters {
		started := time.Now()
		if err := adapter.ReapIdle(); err != nil {
			t.Fatalf("resource probe lane %d idle reap failed: %v", index+1, err)
		}
		for time.Since(started) < 5*time.Second {
			if adapterPID(adapter) == 0 {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		if adapterPID(adapter) != 0 {
			t.Fatalf("resource probe lane %d left a provider process after reap", index+1)
		}
		t.Logf("resource idle_reap lane=%d latency_ms=%d", index+1, time.Since(started).Milliseconds())
	}
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

func processTreeForRoots(roots []int) []probeProcess {
	seen := make(map[int]probeProcess)
	for _, root := range roots {
		for _, process := range processTree(root) {
			seen[process.pid] = process
		}
	}
	out := make([]probeProcess, 0, len(seen))
	for _, process := range seen {
		out = append(out, process)
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
