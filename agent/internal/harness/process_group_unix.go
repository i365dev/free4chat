//go:build darwin || linux

package harness

import (
	"os/exec"
	"syscall"
)

// configureHarnessProcessGroup gives every provider lane its own process
// group. ACP owns the provider protocol, while the Runtime owns the lifecycle
// boundary around that provider and all descendants it starts for a tool call.
// The lane is deliberately scoped to one provider process; we never signal the
// Runtime's own process group.
func configureHarnessProcessGroup(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// signalHarnessProcessGroup signals the provider lane as a unit. A negative
// pid addresses the process group whose id equals the provider pid because the
// child is started with Setpgid. The direct-pid fallback is only for an already
// exited group, and keeps shutdown tolerant of a race with process reaping.
func signalHarnessProcessGroup(pid int, signal syscall.Signal) error {
	if pid <= 1 {
		return syscall.EINVAL
	}
	if err := syscall.Kill(-pid, signal); err != nil && err != syscall.ESRCH {
		return err
	} else if err == nil {
		return nil
	}
	return syscall.Kill(pid, signal)
}
