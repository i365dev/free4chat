package doctor

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDoctorDistinguishesBridgePrerequisitesFromPreparedReadiness(t *testing.T) {
	root := t.TempDir()
	bin := filepath.Join(root, "bin")
	if err := os.MkdirAll(bin, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"node", "npm"} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	runtimeDir := filepath.Join(root, "runtime")
	t.Setenv("PATH", bin)
	t.Setenv("HOME", root)
	t.Setenv("FREE4CHAT_AGENT_DIR", runtimeDir)

	before := findLauncher(t, Collect(), "codex")
	if !before.ExecutableAvailable || before.Ready || !strings.Contains(before.Note, "not prepared") {
		t.Fatalf("doctor overstated cold bridge readiness: %+v", before)
	}

	prefix := filepath.Join(runtimeDir, "bridges", "@agentclientprotocol", "codex-acp", "1.12.0")
	packageDir := filepath.Join(prefix, "node_modules", "@agentclientprotocol", "codex-acp")
	if err := os.MkdirAll(filepath.Join(packageDir, "dist"), 0o700); err != nil {
		t.Fatal(err)
	}
	manifest := `{"name":"@agentclientprotocol/codex-acp","version":"1.12.0","bin":{"codex-acp":"dist/index.js"}}`
	if err := os.WriteFile(filepath.Join(packageDir, "package.json"), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "dist", "index.js"), []byte("// fixture\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(prefix, "node_modules", ".bin", "codex-acp")
	if err := os.MkdirAll(filepath.Dir(shim), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(shim, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}

	after := findLauncher(t, Collect(), "codex")
	if !after.ExecutableAvailable || !after.Ready || !strings.Contains(after.Note, "1.12.0 is prepared") {
		t.Fatalf("doctor failed to report prepared bridge: %+v", after)
	}
	if err := os.Remove(filepath.Join(bin, "npm")); err != nil {
		t.Fatal(err)
	}
	withoutNPM := findLauncher(t, Collect(), "codex")
	if !withoutNPM.Ready {
		t.Fatalf("warm prepared bridge should remain ready without npm: %+v", withoutNPM)
	}
	if !strings.Contains(Format(Report{Launchers: []LauncherReport{before}}), "codex: available") {
		t.Fatal("human doctor output did not distinguish available from ready")
	}
}

func findLauncher(t *testing.T, report Report, id string) LauncherReport {
	t.Helper()
	for _, launcher := range report.Launchers {
		if launcher.ID == id {
			return launcher
		}
	}
	t.Fatalf("doctor omitted launcher %q", id)
	return LauncherReport{}
}
