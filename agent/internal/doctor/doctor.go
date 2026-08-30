// Package doctor reports local launcher readiness without printing any
// credential or capability value.
package doctor

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"time"

	"github.com/i365dev/free4chat/agent/internal/harness"
)

// Version identifies the Go Agent Runtime build line (post-freeze rewrite).
// It is a build-overridable var: release builds inject the agent-vX.Y.Z tag
// version via -ldflags "-X github.com/i365dev/free4chat/agent/internal/doctor.Version=X.Y.Z".
var Version = "0.5.9"

// PackageName mirrors the Node product identity in doctor output.
const PackageName = "free4chat-agent"

// LauncherReport is one launcher's availability snapshot.
type LauncherReport struct {
	ID                  string `json:"id"`
	Maturity            string `json:"maturity"`
	Security            string `json:"security"`
	Executable          string `json:"executable"`
	ExecutableAvailable bool   `json:"executableAvailable"`
	Ready               bool   `json:"ready"`
	Note                string `json:"note,omitempty"`
}

// Report is the full doctor projection.
type Report struct {
	Package   string           `json:"package"`
	Version   string           `json:"version"`
	Runtime   string           `json:"runtime"`
	GoVersion string           `json:"goVersion"`
	Platform  string           `json:"platform"`
	Launchers []LauncherReport `json:"launchers"`
}

// canRun probes `<command> --version` with the filtered doctor environment,
// mirroring the Node spawnSync probe.
func canRun(command string, environment map[string]string) bool {
	cmd := exec.Command(command, "--version")
	cmd.Env = envSlice(environment)
	if err := cmd.Start(); err != nil {
		return false
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err == nil
	case <-time.After(5 * time.Second):
		_ = cmd.Process.Kill()
		return false
	}
}

// Collect builds the doctor report against the current process environment.
func Collect() Report {
	base := environ()
	report := Report{
		Package:   PackageName,
		Version:   Version,
		Runtime:   "go",
		GoVersion: runtime.Version(),
		Platform:  runtime.GOOS + "/" + runtime.GOARCH,
	}
	for _, launcher := range harness.ListLaunchers() {
		env := harness.BuildDoctorEnvironment(launcher, base)
		executableAvailable := canRun(launcher.Command, env)
		configured := true
		if launcher.ID == "deepseek-harness" {
			configured = env["FREE4CHAT_DEEPSEEK_REPO"] != ""
		}
		ready := executableAvailable && configured
		note := ""
		switch {
		case !executableAvailable:
			note = fmt.Sprintf("Executable %s is not available", launcher.Command)
		case !configured:
			note = "Set the local DeepSeek Harness checkout before joining"
		case launcher.Command == "npx":
			note = "The pinned bridge package is installed on first join"
		}
		report.Launchers = append(report.Launchers, LauncherReport{
			ID:                  launcher.ID,
			Maturity:            string(launcher.Maturity),
			Security:            string(launcher.Security),
			Executable:          launcher.Command,
			ExecutableAvailable: executableAvailable,
			Ready:               ready,
			Note:                note,
		})
	}
	return report
}

// Format renders the human-readable doctor text.
func Format(report Report) string {
	lines := []string{
		fmt.Sprintf("%s %s (%s runtime, %s)", report.Package, report.Version, report.Runtime, report.GoVersion),
		fmt.Sprintf("Platform %s", report.Platform),
		"Launchers:",
	}
	for _, launcher := range report.Launchers {
		state := "unavailable"
		if launcher.Ready {
			state = "ready"
		}
		lines = append(lines, fmt.Sprintf("  %s: %s | %s | %s",
			launcher.ID, state, launcher.Maturity, launcher.Security))
		if launcher.Note != "" {
			lines = append(lines, "    "+launcher.Note)
		}
	}
	return joinLines(lines)
}

func joinLines(lines []string) string {
	out := ""
	for i, line := range lines {
		if i > 0 {
			out += "\n"
		}
		out += line
	}
	return out
}

// environ snapshots the current process environment as a plain map.
func environ() map[string]string {
	out := make(map[string]string)
	for _, entry := range osEnviron() {
		for i := 0; i < len(entry); i++ {
			if entry[i] == '=' {
				out[entry[:i]] = entry[i+1:]
				break
			}
		}
	}
	return out
}

// envSlice converts a map into exec.Env form.
func envSlice(environment map[string]string) []string {
	keys := make([]string, 0, len(environment))
	for key := range environment {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		out = append(out, key+"="+environment[key])
	}
	return out
}

// osEnviron returns the raw environ entries.
func osEnviron() []string { return os.Environ() }
