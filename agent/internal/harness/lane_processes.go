package harness

import (
	"bytes"
	"errors"
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
 * snapshotted before the cooperative cancel (which may itself end the provider),
 * carried into the hard stop, and verified afterwards: a lane may only report
 * quiescence for processes it can prove are gone.
 */

// Bounded windows for processes a group signal cannot reach. They are
// deliberately small: this runs inside an interactive Human interrupt.
const (
	laneProcessTermWaitMs = 250
	laneProcessKillWaitMs = 1_500
	laneProcessPollMs     = 25
)

// errProcessTableUnavailable reports that the platform could not be asked which
// processes exist. It is deliberately fail-closed: without the table a lane
// cannot know what it owned, so it must not claim that anything stopped.
var errProcessTableUnavailable = errors.New("lane process table unavailable")

// readLaneProcessTable is the platform process-table reader this boundary uses.
// It is a seam so a regression can prove the fail-closed path when the table
// cannot be read at all.
var readLaneProcessTable = readProcessTable

// laneProcess is one process the lane owned at snapshot time. The identity is
// a start-time token, so a pid that was recycled is never mistaken for it.
type laneProcess struct {
	pid   int
	ident processIdentity
}

// laneOwnership is the ownership evidence one teardown carries. known=false
// means the platform process table could not be read at all, so the lane has no
// evidence either way and may not report quiescence.
type laneOwnership struct {
	processes []laneProcess
	known     bool
}

// snapshotLaneOwnership lists every live DESCENDANT of root (the provider) by
// walking parent links. The provider itself is excluded: its own lifecycle is
// already owned by the wait channel. Callers must take the snapshot while the
// provider is still alive — an orphaned descendant is not discoverable.
func snapshotLaneOwnership(root int) laneOwnership {
	if root <= 1 {
		return laneOwnership{known: true}
	}
	rows, ok := readLaneProcessTable()
	if !ok {
		return laneOwnership{}
	}
	return laneOwnership{processes: laneProcessTree(rows, root), known: true}
}

// laneProcessTree builds the descendant list from one process-table read.
func laneProcessTree(rows []processRow, root int) []laneProcess {
	if root <= 1 || len(rows) == 0 {
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
			// A zombie holds no execution: it is already stopped, and its pid
			// may legitimately outlive the process while it is reaped.
			if child.zombie {
				continue
			}
			owned = append(owned, laneProcess{pid: child.pid, ident: child.ident})
			queue = append(queue, child.pid)
		}
	}
	return owned
}

// merge unions two ownership reads without duplicating a pid. The result is
// known only when BOTH reads were known: a lane that failed to read the table
// once cannot prove what it owned at that moment, even if a later read works.
func (o laneOwnership) merge(other laneOwnership) laneOwnership {
	merged := laneOwnership{processes: o.processes, known: o.known && other.known}
	for _, candidate := range other.processes {
		duplicate := false
		for _, existing := range merged.processes {
			if existing.pid == candidate.pid {
				duplicate = true
				break
			}
		}
		if !duplicate {
			merged.processes = append(merged.processes, candidate)
		}
	}
	return merged
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

// signalOwnedProcess re-reads the recorded identity immediately before the
// signal, so a pid recycled since the snapshot is never signalled. The window
// cannot be made zero (no portable signal-if-same-process exists), but this is
// the smallest it can be, and it is what makes "every kill compares identity"
// true of the code rather than only of the snapshot.
func signalOwnedProcess(process laneProcess, signal syscall.Signal) {
	row, ok := readProcessRow(process.pid)
	if !ok || row.zombie || row.ident != process.ident {
		return
	}
	_ = syscall.Kill(process.pid, signal)
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
		signalOwnedProcess(process, syscall.SIGTERM)
	}
	remaining := waitLaneProcessesGone(survivors, laneProcessTermWaitMs)
	if len(remaining) == 0 {
		return nil
	}
	for _, process := range remaining {
		signalOwnedProcess(process, syscall.SIGKILL)
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

// parseProcStat reads the fields this boundary needs from one Linux
// /proc/<pid>/stat line. The comm field is parenthesized and may itself contain
// spaces and parentheses, so parsing starts after the LAST ')': state, ppid,
// pgrp, session, ..., starttime.
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
