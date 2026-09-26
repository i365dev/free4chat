//go:build darwin

package harness

import "golang.org/x/sys/unix"

// testProcessParent reads the parent pid from the kernel process entry. It is
// deliberately independent of the implementation under test, so a broken
// ownership sweep cannot make its own regression pass.
func testProcessParent(pid int) (int, bool) {
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || info == nil || int(info.Proc.P_pid) != pid {
		return 0, false
	}
	return int(info.Eproc.Ppid), true
}
