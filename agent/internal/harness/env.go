package harness

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/i365dev/free4chat/agent/internal/types"
)

// RuntimeExecutableEnv is launcher-owned policy. It is injected only from
// the actual Runtime executable path and is never accepted through
// operator-authorized --agent-env inheritance.
const RuntimeExecutableEnv = "FREE4CHAT_AGENT_BIN"

// ErrDeepSeekRepo signals the missing DeepSeek checkout prerequisite.
var errDeepSeekRepo = errors.New(
	"DeepSeek Harness is preview-only; set FREE4CHAT_DEEPSEEK_REPO or use --agent-command")

// UnknownLauncherError reports an unrecognized built-in launcher id.
type UnknownLauncherError struct{ ID string }

func (e *UnknownLauncherError) Error() string {
	return fmt.Sprintf("Unknown ACP launcher: %s", e.ID)
}

// safeEnvironmentKeys is the explicit allow-list for Harness subprocess
// environments: nothing ambient leaks unless it is on this list (or an
// explicit launcher override).
var safeEnvironmentKeys = []string{
	"PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM", "NO_COLOR",
	"FREE4CHAT_AGENT_DIR",
	"OPENAI_API_KEY", "OPENAI_BASE_URL",
	"ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
	"GOOGLE_API_KEY", "GEMINI_API_KEY",
	"OPENROUTER_API_KEY",
	"DEEPSEEK_API_KEY",
	"ZAI_API_KEY", "GLM_API_KEY",
	"NOUS_API_KEY",
	"MISTRAL_API_KEY",
	"XAI_API_KEY",
	"COHERE_API_KEY",
	"MINIMAX_API_KEY",
	"MOONSHOT_API_KEY",
	"DASHSCOPE_API_KEY",
}

// doctorEnvironmentKeys is the narrower list used when probing executables.
var doctorEnvironmentKeys = []string{
	"PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "NO_COLOR",
}

// ForbiddenExplicitEnv reports whether an explicitly inherited environment
// NAME is Free4Chat-owned lifecycle/security policy that must never be
// overridable through operator-authorized named inheritance.
//
// CODEX_CONFIG and INITIAL_AGENT_MODE are intentionally removed from every
// Harness environment and may only be set by a built-in launcher's own
// explicit policy. Arbitrary FREE4CHAT_* names are Runtime control variables,
// not generic provider configuration; FREE4CHAT_AGENT_DIR remains propagated
// by the ambient allow-list (never through explicit inheritance).
func ForbiddenExplicitEnv(name string) bool {
	return name == "CODEX_CONFIG" || name == "INITIAL_AGENT_MODE" ||
		strings.HasPrefix(name, "FREE4CHAT_")
}

// ValidateExplicitEnv rejects a whole explicitly inherited environment map
// when it contains any Free4Chat-owned lifecycle/security variable. The
// daemon calls this at the IPC boundary so a direct daemon request — not just
// the CLI — cannot reintroduce a forbidden policy override.
func ValidateExplicitEnv(env map[string]string) error {
	for name := range env {
		if ForbiddenExplicitEnv(name) {
			return fmt.Errorf(
				"Harness environment variable %s is reserved by Free4Chat and cannot be inherited explicitly",
				name,
			)
		}
	}
	return nil
}

// BuildHarnessEnvironment filters the ambient environment down to the safe
// allow-list, applies explicitly authorized named environment from the
// operator (CLI --agent-env), and finally applies the launcher's explicit
// overrides. Precedence: safe ambient -> operator authorized -> launcher policy.
// launcher-owned policy always wins.
func BuildHarnessEnvironment(launcher types.AgentLauncher, base map[string]string, explicitEnv map[string]string) map[string]string {
	if base == nil {
		base = osEnviron()
	}
	environment := make(map[string]string, len(safeEnvironmentKeys)+len(launcher.Environment)+len(explicitEnv))
	for _, key := range safeEnvironmentKeys {
		if value, ok := base[key]; ok {
			environment[key] = value
		}
	}
	// Never inherit ambient Codex privilege/configuration policy. A
	// built-in launcher may opt into an explicit safe value below.
	delete(environment, "CODEX_CONFIG")
	delete(environment, "INITIAL_AGENT_MODE")
	// Apply explicitly authorized named environment from operator (CLI --agent-env).
	// These are resolved from the CURRENT CLI process, not the daemon.
	// Defense in depth: even if a forbidden name slipped past the daemon's
	// ValidateExplicitEnv boundary, it is dropped here and can never reach
	// the Harness subprocess or override launcher-owned policy.
	for key, value := range explicitEnv {
		if ForbiddenExplicitEnv(key) {
			continue
		}
		environment[key] = value
	}
	// Launcher-owned explicit policy wins (e.g., Codex INITIAL_AGENT_MODE=read-only).
	for key, value := range launcher.Environment {
		environment[key] = value
	}
	return environment
}

// BuildDoctorEnvironment filters the environment used to probe launchers.
func BuildDoctorEnvironment(launcher types.AgentLauncher, base map[string]string) map[string]string {
	if base == nil {
		base = osEnviron()
	}
	environment := make(map[string]string, len(doctorEnvironmentKeys))
	for _, key := range doctorEnvironmentKeys {
		if value, ok := base[key]; ok {
			environment[key] = value
		}
	}
	for key, value := range launcher.Environment {
		environment[key] = value
	}
	return environment
}

// osEnviron snapshots the current process environment as a plain map.
func osEnviron() map[string]string {
	out := make(map[string]string, len(os.Environ()))
	for _, entry := range os.Environ() {
		for i := 0; i < len(entry); i++ {
			if entry[i] == '=' {
				out[entry[:i]] = entry[i+1:]
				break
			}
		}
	}
	return out
}
