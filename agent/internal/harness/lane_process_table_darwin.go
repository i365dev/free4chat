//go:build darwin

package harness

import "golang.org/x/sys/unix"

// processIdentity is an opaque, comparable start-time token. Darwin encodes the
// kernel start time (seconds + microseconds since the epoch), which is stable
// for the lifetime of one process and different for a process that reuses its
// pid.
type processIdentity uint64

type processRow struct {
	pid    int
	ppid   int
	ident  processIdentity
	zombie bool
}

// kernProcZombie is the Darwin process state for an exited, unreaped process
// (SZOMB in <sys/proc.h>).
const kernProcZombie = 5

func darwinProcessRow(info *unix.KinfoProc) processRow {
	return processRow{
		pid:    int(info.Proc.P_pid),
		ppid:   int(info.Eproc.Ppid),
		ident:  darwinProcessIdentity(info),
		zombie: info.Proc.P_stat == kernProcZombie,
	}
}

func darwinProcessIdentity(info *unix.KinfoProc) processIdentity {
	start := info.Proc.P_starttime
	return processIdentity(uint64(uint32(start.Sec))<<32 | uint64(uint32(start.Usec)))
}

// readProcessTable snapshots the kernel process table and reports whether the
// platform could be asked at all. It is called only while a lane is being torn
// down, never on a timer. A failing sysctl is NOT "no descendants": ownership
// is unknown, and the teardown boundary fails closed on it.
func readProcessTable() ([]processRow, bool) {
	all, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return nil, false
	}
	rows := make([]processRow, 0, len(all))
	for index := range all {
		row := darwinProcessRow(&all[index])
		if row.pid <= 1 {
			continue
		}
		rows = append(rows, row)
	}
	return rows, true
}

func readProcessRow(pid int) (processRow, bool) {
	if pid <= 1 {
		return processRow{}, false
	}
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || info == nil || int(info.Proc.P_pid) != pid {
		return processRow{}, false
	}
	return darwinProcessRow(info), true
}
