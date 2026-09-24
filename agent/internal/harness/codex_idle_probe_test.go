//go:build codexprobe

package harness

import (
	"os"
	"sort"
	"strings"
	"testing"
)

func TestCodexIdleRematerializationProbe(t *testing.T) {
	if os.Getenv("FREE4CHAT_RUN_CODEX_IDLE_PROBE") != "1" {
		t.Skip("opt-in real Codex ACP probe")
	}
	provider, err := ProviderByID("codex")
	if err != nil {
		t.Fatal(err)
	}
	adapter := NewACPAdapter(provider.Launcher(), t.TempDir(), AdapterOptions{ControlTimeoutMs: 60000})
	t.Cleanup(func() { _ = adapter.Close() })
	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("initial room session: %s", probeErrorClass(err))
	}
	if adapter.SessionControlsFor("room") == nil {
		t.Fatal("room controls absent")
	}
	project := t.TempDir()
	if err := adapter.EnsureSessionForCwd("task:probe", project); err != nil {
		t.Fatalf("initial task session: %s", probeErrorClass(err))
	}
	controls := adapter.SessionControlsFor("task:probe")
	if controls == nil {
		t.Fatal("task controls absent")
	}
	model := ""
	for _, option := range controls.ConfigOptions {
		if option.ID != "model" {
			continue
		}
		for _, choice := range option.Options {
			if strings.Contains(choice.Value, "gpt-5.6-sol") {
				model = choice.Value
				break
			}
		}
	}
	if model == "" {
		t.Fatal("usable model absent")
	}
	if err := adapter.SetConfigOptionFor("task:probe", "model", model); err != nil {
		t.Fatalf("select model: %s", probeErrorClass(err))
	}
	result, err := adapter.RunTurnFor("task:probe", turnInput("Reply only IDLE_PROBE_READY."), adapter.SessionGenerationFor("task:probe"))
	if err != nil {
		t.Fatalf("seed turn: %s", probeErrorClass(err))
	}
	if !strings.Contains(result.Text, "IDLE_PROBE_READY") {
		t.Fatal("seed turn did not complete")
	}
	t.Log("seed_turn=PASS")
	taskID := adapter.SessionDiagnostics()[1].SessionID
	t.Log("initial_room_and_task=PASS")
	if err := adapter.ReapIdle(); err != nil {
		t.Fatalf("force reap: %s", probeErrorClass(err))
	}
	if err := adapter.EnsureSessionForCwd("task:probe", project); err != nil {
		t.Fatalf("exact task reload: %s", probeErrorClass(err))
	}
	if got := adapter.SessionDiagnostics()[1].SessionID; got != taskID {
		t.Fatal("task native identity changed after reap")
	}
	if err := adapter.SetConfigOptionFor("task:probe", "model", model); err != nil {
		t.Fatalf("reapply model: %s", probeErrorClass(err))
	}
	continued, err := adapter.RunTurnFor("task:probe", turnInput("What exact phrase did I ask you to reply with in the previous turn? Reply with that phrase only."), adapter.SessionGenerationFor("task:probe"))
	if err != nil {
		t.Fatalf("continued turn: %s", probeErrorClass(err))
	}
	if !strings.Contains(continued.Text, "IDLE_PROBE_READY") {
		t.Fatal("continued turn lost context")
	}
	t.Log("exact_task_reload_and_context=PASS")
}

func probeErrorClass(err error) string {
	if err == nil {
		return "nil"
	}
	message := strings.ToLower(err.Error())
	matched := []string{}
	for _, word := range []string{"timeout", "not found", "does not exist", "invalid", "unavailable", "session/load", "process exited", "unauthorized", "permission", "failed", "thread", "resume", "history", "parse", "database", "file", "rollout", "config", "model", "turn", "-32603", "-32000", "-32602", "unknown", "unsupported", "could not", "cannot", "no such", "archived"} {
		if strings.Contains(message, word) {
			matched = append(matched, word)
		}
	}
	sort.Strings(matched)
	return strings.Join(matched, ",")
}
