//go:build !darwin && !linux && !windows

package capability

import "os/exec"

func configureAdapterProcess(*exec.Cmd) {}

func killAdapterProcess(cmd *exec.Cmd) {
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
