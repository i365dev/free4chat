package harness

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * #409 §8 — how "no cwd filter" is spelled on the wire.
 *
 * ACP makes `cwd` optional, but a bridge decides what omission MEANS. The
 * pinned Pi bridge resolves an absent cwd to its OWN last session cwd, so
 * omission is a silent project filter there and only an explicitly empty value
 * asks for every project. These tests drive a real spawned ACP child that
 * reproduces that rule exactly, and prove the launcher's declared policy is
 * what makes global discovery actually global.
 */

// bridgeStore models a real multi-project bridge session store.
func bridgeStore(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "store.txt")
	content := "session-a|/private/tmp|tmp work\n" +
		"session-b|/private/tmp|more tmp work\n" +
		"session-c|/home/me/project|project work\n" +
		"session-d|/home/me/other|other work\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write bridge store: %v", err)
	}
	return path
}

func bridgeLauncher(policy types.LauncherSessionListGlobalCwd, store string) types.AgentLauncher {
	return types.AgentLauncher{
		ID: "pi", DisplayName: "Pi", Command: fakeAgentPath,
		Maturity: types.MaturityPreview, Security: types.SecurityUnverified,
		Environment: map[string]string{
			"FAKE_MODE":              "normal",
			"FAKE_LIST_CAP":          "1",
			"FAKE_LIST_NO_CURSOR":    "1",
			"FAKE_LIST_STORE":        store,
			"FAKE_LIST_CWD_FALLBACK": "/workspace",
		},
		SessionListGlobalCwd: policy,
	}
}

func sessionIDs(page ACPSessionPage) []string {
	out := make([]string, 0, len(page.Sessions))
	for _, session := range page.Sessions {
		out = append(out, session.SessionID)
	}
	return out
}

func TestACPSessionListGlobalDiscoveryFollowsTheLauncherPolicy(t *testing.T) {
	store := bridgeStore(t)

	t.Run("omitting the cwd is a silent PROJECT filter for this bridge", func(t *testing.T) {
		// The ACP-correct default, run against a bridge that resolves an
		// absent cwd to its own last session cwd. This is the exact trap the
		// policy exists to avoid: the request LOOKS global and is not.
		adapter := NewACPAdapter(bridgeLauncher(types.GlobalSessionListCwdOmitted, store), t.TempDir(), AdapterOptions{})
		defer adapter.Close()
		if err := adapter.EnsureSession(); err != nil {
			t.Fatalf("ensure session: %v", err)
		}
		page, err := adapter.ListSessions(ACPSessionListOptions{})
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		if len(page.Sessions) != 0 {
			t.Fatalf("expected the fallback cwd to filter everything out, got %v", sessionIDs(page))
		}
	})

	t.Run("an explicitly empty cwd asks for every project", func(t *testing.T) {
		adapter := NewACPAdapter(bridgeLauncher(types.GlobalSessionListCwdEmpty, store), t.TempDir(), AdapterOptions{})
		defer adapter.Close()
		if err := adapter.EnsureSession(); err != nil {
			t.Fatalf("ensure session: %v", err)
		}
		page, err := adapter.ListSessions(ACPSessionListOptions{})
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		want := []string{"session-a", "session-b", "session-c", "session-d"}
		if got := sessionIDs(page); !reflect.DeepEqual(got, want) {
			t.Fatalf("global discovery did not span projects: got %v want %v", got, want)
		}
		cwds := map[string]int{}
		for _, session := range page.Sessions {
			cwds[session.Cwd]++
		}
		if len(cwds) != 3 {
			t.Fatalf("expected three distinct project cwds, got %v", cwds)
		}
	})

	t.Run("an explicit cwd stays an exact project filter", func(t *testing.T) {
		adapter := NewACPAdapter(bridgeLauncher(types.GlobalSessionListCwdEmpty, store), t.TempDir(), AdapterOptions{})
		defer adapter.Close()
		if err := adapter.EnsureSession(); err != nil {
			t.Fatalf("ensure session: %v", err)
		}
		project := "/private/tmp"
		page, err := adapter.ListSessions(ACPSessionListOptions{Cwd: &project})
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		if got := sessionIDs(page); !reflect.DeepEqual(got, []string{"session-a", "session-b"}) {
			t.Fatalf("project filter mismatch: %v", got)
		}
	})
}

// TestACPSessionListSendsTheDeclaredGlobalCwdSpelling asserts the exact wire
// params, so a future refactor cannot silently change which request means
// "every project" for a bridge whose whole picker depends on it.
func TestACPSessionListSendsTheDeclaredGlobalCwdSpelling(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		policy types.LauncherSessionListGlobalCwd
		want   map[string]any
	}{
		{name: "default omits the field", policy: types.GlobalSessionListCwdOmitted, want: map[string]any{}},
		{name: "bridge policy sends an explicit empty value", policy: types.GlobalSessionListCwdEmpty, want: map[string]any{"cwd": ""}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			tracePath := filepath.Join(t.TempDir(), "acp-trace.log")
			launcher := scriptLauncher("normal", map[string]string{
				"FAKE_LIST_CAP": "1",
				"FAKE_TRACE":    tracePath,
			})
			launcher.SessionListGlobalCwd = testCase.policy
			adapter, _ := newTestAdapter(t, launcher, AdapterOptions{})
			defer adapter.Close()
			if err := adapter.EnsureSession(); err != nil {
				t.Fatalf("ensure failed: %v", err)
			}
			if _, err := adapter.ListSessions(ACPSessionListOptions{}); err != nil {
				t.Fatalf("list failed: %v", err)
			}
			got := acpTraceParams(t, tracePath, "session/list")
			want := []map[string]any{testCase.want}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("session/list wire params mismatch: got=%v want=%v", got, want)
			}
		})
	}
}
