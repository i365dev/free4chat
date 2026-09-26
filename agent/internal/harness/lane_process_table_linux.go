//go:build linux

package harness

import (
	"os"
	"strconv"
)

// processIdentity is an opaque, comparable start-time token. Linux encodes the
// kernel start time (jiffies since boot), which is stable for the lifetime of
// one process and different for a process that reuses its pid.
type processIdentity uint64

type processRow struct {
	pid    int
	ppid   int
	ident  processIdentity
	zombie bool
}

// readProcessTable snapshots /proc and reports whether the platform could be
// asked at all. It is called only while a lane is being torn down, never on a
// timer. An unreadable /proc is NOT "no descendants": ownership is unknown, and
// the teardown boundary fails closed on it.
func readProcessTable() ([]processRow, bool) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, false
	}
	rows := make([]processRow, 0, len(entries))
	for _, entry := range entries {
		pid, convErr := strconv.Atoi(entry.Name())
		if convErr != nil || pid <= 1 {
			continue
		}
		if row, ok := readProcessRow(pid); ok {
			rows = append(rows, row)
		}
	}
	return rows, true
}

func readProcessRow(pid int) (processRow, bool) {
	if pid <= 1 {
		return processRow{}, false
	}
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return processRow{}, false
	}
	return parseProcStat(pid, raw)
}
