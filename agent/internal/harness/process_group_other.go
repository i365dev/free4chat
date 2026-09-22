//go:build !darwin && !linux

package harness

import (
	"os/exec"
	"syscall"
)

// Non-Unix builds retain the adapter's direct-process fallback. The shipped
// Runtime targets Darwin and Linux, where process-group ownership is enabled.
func configureHarnessProcessGroup(command *exec.Cmd) {}

func signalHarnessProcessGroup(pid int, signal syscall.Signal) error {
	if pid <= 1 {
		return syscall.EINVAL
	}
	return syscall.Kill(pid, signal)
}
