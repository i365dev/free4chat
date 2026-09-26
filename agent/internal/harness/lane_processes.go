package harness

import (
	"bytes"
	"strconv"
	"strings"
	"syscall"
	"time"
)

/*
 * Lane-owned process teardown (#482).
 *
 * A lane's provider runs in its own process group, so signalling that group is
 * the first and cheapest teardown boundary. It is NOT a complete one: a
 * provider or tool runner may put a tool child into its own session/process
 * group, and then the group signal never reaches it:
 *
 *	SIGTERM(-providerPGID) -> provider exits -> proc.exited closes
 *	                       -> the detached tool child keeps running
 *
 * The child is still reachable by parent link BEFORE the provider exits, and it
 * is re-parented the moment the provider is gone. Ownership is therefore
 * snapshotted first and verified afterwards, and the lane may only report
 * quiescence once every process it owned is really gone.
 */

// Bounded windows for processes a group signal cannot reach. They are
// deliberately small: this runs inside an interactive Human interrupt.
const (
	laneProcessTermWaitMs = 250
	laneProcessKillWaitMs = 1_500
	laneProcessPollMs     = 25
)

// laneProcess is one process the lane owned at snapshot time. The identity is
// a start-time token, so a pid that was recycled is never mistaken for it.
type laneProcess struct {
	pid   int
	ident processIdentity
}

// laneProcessSnapshot lists every live DESCENDANT of root (the provider) by
// walking parent links. The provider itself is excluded: its own lifecycle is
// already owned by the wait channel. Callers must take the snapshot before any
// signal is sent, because an orphaned descendant is no longer discoverable.
func laneProcessSnapshot(root int) []laneProcess {
	if root <= 1 {
		return nil
	}
	rows := readProcessTable()
	if len(rows) == 0 {
		return nil
	}
	children := make(map[int][]processRow, len(rows))
	for _, row := range rows {
		children[row.ppid] = append(children[row.ppid], row)
	}
	owned := make([]laneProcess, 0, 4)
	visited := map[int]bool{root: true}
	queue := []int{root}
	for len(queue) > 0 {
		parent := queue[0]
		queue = queue[1:]
		for _, child := range children[parent] {
			if visited[child.pid] || child.pid <= 1 {
				continue
			}
			visited[child.pid] = true
			// A zombie holds no execution: it is already stopped, and its
			// pid may legitimately outlive the process while it is reaped.
			if child.zombie {
				continue
			}
			owned = append(owned, laneProcess{pid: child.pid, ident: child.ident})
			queue = append(queue, child.pid)
		}
	}
	return owned
}

// laneProcessSurvivors returns the owned processes that are still the SAME
// live process. The identity check is what makes the sweep safe against pid
// reuse: a recycled pid is not the process this lane owned.
func laneProcessSurvivors(owned []laneProcess) []laneProcess {
	survivors := make([]laneProcess, 0, len(owned))
	for _, process := range owned {
		row, ok := readProcessRow(process.pid)
		if !ok || row.zombie || row.ident != process.ident {
			continue
		}
		survivors = append(survivors, process)
	}
	return survivors
}

// sweepLaneProcesses terminates every owned process that outlived the process
// group signal, and returns those it could not confirm gone within the bounded
// windows. It signals only pids this lane owned, directly and by identity —
// never by name, and never another lane's processes.
func sweepLaneProcesses(owned []laneProcess) []laneProcess {
	survivors := laneProcessSurvivors(owned)
	if len(survivors) == 0 {
		return nil
	}
	for _, process := range survivors {
		_ = syscall.Kill(process.pid, syscall.SIGTERM)
	}
	remaining := waitLaneProcessesGone(survivors, laneProcessTermWaitMs)
	if len(remaining) == 0 {
		return nil
	}
	for _, process := range remaining {
		_ = syscall.Kill(process.pid, syscall.SIGKILL)
	}
	return waitLaneProcessesGone(remaining, laneProcessKillWaitMs)
}

func waitLaneProcessesGone(owned []laneProcess, timeoutMs int) []laneProcess {
	deadline := time.Now().Add(time.Duration(timeoutMs) * time.Millisecond)
	for {
		remaining := laneProcessSurvivors(owned)
		if len(remaining) == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return remaining
		}
		time.Sleep(time.Duration(laneProcessPollMs) * time.Millisecond)
	}
}

// parseProcStat reads the fields this boundary needs. The comm field is
// parenthesized and may itself contain spaces and parentheses, so parsing
// starts after the LAST ')': state, ppid, pgrp, session, ..., starttime.
func parseProcStat(pid int, raw []byte) (processRow, bool) {
	closing := bytes.LastIndexByte(raw, ')')
	if closing < 0 || closing+2 >= len(raw) {
		return processRow{}, false
	}
	fields := strings.Fields(string(raw[closing+2:]))
	// 0 state, 1 ppid, 19 starttime (field 22 of the full line).
	if len(fields) < 20 {
		return processRow{}, false
	}
	ppid, ppidErr := strconv.Atoi(fields[1])
	start, startErr := strconv.ParseUint(fields[19], 10, 64)
	if ppidErr != nil || startErr != nil {
		return processRow{}, false
	}
	state := fields[0]
	return processRow{
		pid:    pid,
		ppid:   ppid,
		ident:  processIdentity(start),
		zombie: state == "Z" || state == "X",
	}, true
}
