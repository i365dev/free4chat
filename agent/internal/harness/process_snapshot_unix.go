//go:build darwin || linux

package harness

import (
	"bytes"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

type processSnapshot struct {
	pgid        int
	alive       bool
	descendants int
	rssKB       int64
}

// snapshotProviderProcess uses the platform's existing ps view once per
// diagnostics request. It is deliberately a snapshot, not a polling loop.
func snapshotProviderProcess(root int) processSnapshot {
	if root <= 0 {
		return processSnapshot{}
	}
	snapshot := processSnapshot{alive: syscall.Kill(root, 0) == nil}
	if pgid, err := syscall.Getpgid(root); err == nil {
		snapshot.pgid = pgid
	}
	out, err := exec.Command("ps", "-axo", "pid=,ppid=,rss=").Output()
	if err != nil {
		return snapshot
	}
	type proc struct {
		ppid int
		rss  int64
	}
	processes := make(map[int]proc)
	for _, line := range bytes.Split(out, []byte{'\n'}) {
		fields := strings.Fields(string(line))
		if len(fields) != 3 {
			continue
		}
		pid, errPID := strconv.Atoi(fields[0])
		ppid, errPPID := strconv.Atoi(fields[1])
		rss, errRSS := strconv.ParseInt(fields[2], 10, 64)
		if errPID == nil && errPPID == nil && errRSS == nil {
			processes[pid] = proc{ppid: ppid, rss: rss}
		}
	}
	if rootProc, ok := processes[root]; ok {
		snapshot.rssKB = rootProc.rss
	}
	parents := make(map[int][]int)
	for pid, process := range processes {
		parents[process.ppid] = append(parents[process.ppid], pid)
	}
	queue := []int{root}
	seen := map[int]bool{root: true}
	for len(queue) > 0 {
		parent := queue[0]
		queue = queue[1:]
		for _, child := range parents[parent] {
			if seen[child] {
				continue
			}
			seen[child] = true
			snapshot.descendants++
			if process, ok := processes[child]; ok {
				snapshot.rssKB += process.rss
			}
			queue = append(queue, child)
		}
	}
	return snapshot
}
