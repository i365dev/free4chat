package harness

import (
	"errors"
	"fmt"
	"os"

	"github.com/i365dev/free4chat/agent/internal/types"
)

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

// BuildHarnessEnvironment filters the ambient environment down to the safe
// allow-list, never inherits ambient Codex privilege/configuration policy,
// and finally applies the launcher's explicit overrides.
func BuildHarnessEnvironment(launcher types.AgentLauncher, base map[string]string) map[string]string {
	if base == nil {
		base = osEnviron()
	}
	environment := make(map[string]string, len(safeEnvironmentKeys)+len(launcher.Environment))
	for _, key := range safeEnvironmentKeys {
		if value, ok := base[key]; ok {
			environment[key] = value
		}
	}
	// Never inherit ambient Codex privilege/configuration policy. A
	// built-in launcher may opt into an explicit safe value below.
	delete(environment, "CODEX_CONFIG")
	delete(environment, "INITIAL_AGENT_MODE")
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
