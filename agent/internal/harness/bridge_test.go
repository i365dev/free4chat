package harness

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

func TestBridgeCacheMissingBinReinstallsPinnedPackageAndWarmReuse(t *testing.T) {
	root := t.TempDir()
	installFakeBridgeTools(t, root)
	path := os.Getenv("PATH")
	launcher := testBridgeLauncher()
	cache := bridgeCachePath(filepath.Join(root, "runtime"), launcher)
	writeBridgePackage(t, cache, "1.2.3", false)
	if BridgePrepared(filepath.Join(root, "runtime"), launcher) {
		t.Fatal("cache without node_modules/.bin must be treated as invalid")
	}

	node, args, err := prepareBridge(filepath.Join(root, "runtime"), launcher, map[string]string{"PATH": path, "HOME": root})
	if err != nil {
		t.Fatalf("prepare missing-bin cache: %v", err)
	}
	if filepath.Base(node) != "node" || len(args) != 1 || !strings.HasSuffix(args[0], filepath.Join("fixture", "bridge", "dist", "index.js")) {
		t.Fatalf("prepared launch does not directly target the pinned package entry: node=%q args=%v", node, args)
	}
	if err := exec.Command(node, args...).Run(); err != nil {
		t.Fatalf("prepared bridge entry did not launch: %v", err)
	}
	if !BridgePrepared(filepath.Join(root, "runtime"), launcher) {
		t.Fatal("cold install did not produce a valid bridge cache")
	}
	countPath := filepath.Join(root, "install-count")
	if got, _ := os.ReadFile(countPath); len(got) != 1 {
		t.Fatalf("expected one npm install, got %q", got)
	}
	if _, _, err := prepareBridge(filepath.Join(root, "runtime"), launcher, map[string]string{"PATH": path, "HOME": root}); err != nil {
		t.Fatalf("warm bridge reuse failed: %v", err)
	}
	if got, _ := os.ReadFile(countPath); len(got) != 1 {
		t.Fatalf("warm reuse reinstalled bridge: install count %q", got)
	}
}

func TestBridgeWrongVersionIsRebuilt(t *testing.T) {
	root := t.TempDir()
	installFakeBridgeTools(t, root)
	path := os.Getenv("PATH")
	launcher := testBridgeLauncher()
	runtimeDir := filepath.Join(root, "runtime")
	writeBridgePackage(t, bridgeCachePath(runtimeDir, launcher), "9.9.9", true)
	if BridgePrepared(runtimeDir, launcher) {
		t.Fatal("wrong version must not be reported as prepared")
	}
	if _, _, err := prepareBridge(runtimeDir, launcher, map[string]string{"PATH": path, "HOME": root}); err != nil {
		t.Fatalf("rebuild wrong-version cache: %v", err)
	}
	if !BridgePrepared(runtimeDir, launcher) {
		t.Fatal("correct pinned version was not installed")
	}
}

func TestConcurrentBridgePreparationPromotesOneCompleteCache(t *testing.T) {
	root := t.TempDir()
	installFakeBridgeTools(t, root)
	path := os.Getenv("PATH")
	launcher := testBridgeLauncher()
	runtimeDir := filepath.Join(root, "runtime")
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, err := prepareBridge(runtimeDir, launcher, map[string]string{"PATH": path, "HOME": root})
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent preparation failed: %v", err)
		}
	}
	if !BridgePrepared(runtimeDir, launcher) {
		t.Fatal("concurrent preparation did not leave a valid promoted cache")
	}
}

func TestBridgeInstallFailureIsBoundedAndClassified(t *testing.T) {
	root := t.TempDir()
	bin := installFakeBridgeTools(t, root)
	path := os.Getenv("PATH")
	if err := os.WriteFile(filepath.Join(bin, "npm"), []byte("#!/bin/sh\nexit 7\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	launcher := testBridgeLauncher()
	_, _, err := prepareBridge(filepath.Join(root, "runtime"), launcher, map[string]string{"PATH": path, "HOME": root})
	var preparation *BridgePreparationError
	if !errors.As(err, &preparation) || preparation.Class != "bridge_install_failed" {
		t.Fatalf("expected classified install failure, got %v", err)
	}
}

func TestBridgeInstallTimeoutIsClassified(t *testing.T) {
	root := t.TempDir()
	bin := installFakeBridgeTools(t, root)
	path := os.Getenv("PATH")
	if err := os.WriteFile(filepath.Join(bin, "npm"), []byte("#!/bin/sh\n/bin/sleep 1\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	oldTimeout := bridgeInstallTimeout
	bridgeInstallTimeout = 30 * time.Millisecond
	t.Cleanup(func() { bridgeInstallTimeout = oldTimeout })
	launcher := testBridgeLauncher()
	_, _, err := prepareBridge(filepath.Join(root, "runtime"), launcher, map[string]string{"PATH": path, "HOME": root})
	var preparation *BridgePreparationError
	if !errors.As(err, &preparation) || preparation.Class != "bridge_prepare_timeout" {
		t.Fatalf("expected classified install timeout, got %v", err)
	}
}

func testBridgeLauncher() types.AgentLauncher {
	return types.AgentLauncher{ID: "fixture", Command: "node", BridgePackage: "fixture/bridge", BridgeVersion: "1.2.3", BridgeBin: "fixture-acp"}
}

func installFakeBridgeTools(t *testing.T, root string) string {
	t.Helper()
	systemPath := os.Getenv("PATH")
	bin := filepath.Join(root, "bin")
	if err := os.MkdirAll(bin, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "node"), []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	npm := `#!/bin/sh
prefix=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then prefix="$2"; shift 2; else shift; fi
done
count="` + filepath.Join(root, "install-count") + `"
printf x >> "$count"
mkdir -p "$prefix/node_modules/fixture/bridge/dist" "$prefix/node_modules/.bin"
printf '%s' '{"name":"fixture/bridge","version":"1.2.3","bin":{"fixture-acp":"dist/index.js"}}' > "$prefix/node_modules/fixture/bridge/package.json"
printf '%s\n' '#!/usr/bin/env node' > "$prefix/node_modules/fixture/bridge/dist/index.js"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$prefix/node_modules/.bin/fixture-acp"
chmod +x "$prefix/node_modules/.bin/fixture-acp"
`
	if err := os.WriteFile(filepath.Join(bin, "npm"), []byte(npm), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+systemPath)
	return bin
}

func writeBridgePackage(t *testing.T, prefix, version string, withBin bool) {
	t.Helper()
	packageDir := filepath.Join(prefix, "node_modules", "fixture", "bridge")
	if err := os.MkdirAll(filepath.Join(packageDir, "dist"), 0o700); err != nil {
		t.Fatal(err)
	}
	manifest := `{"name":"fixture/bridge","version":"` + version + `","bin":{"fixture-acp":"dist/index.js"}}`
	if err := os.WriteFile(filepath.Join(packageDir, "package.json"), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "dist", "index.js"), []byte("// fixture\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if withBin {
		bin := filepath.Join(prefix, "node_modules", ".bin")
		if err := os.MkdirAll(bin, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(bin, "fixture-acp"), []byte("#!/bin/sh\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
}
