package harness

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

var bridgeInstallTimeout = 3 * time.Minute

// BridgePreparationError exposes only a stable class token. npm output is
// deliberately discarded because it can contain registry or auth details.
type BridgePreparationError struct {
	Class string
}

func (e *BridgePreparationError) Error() string { return e.Class }

func bridgeCachePath(runtimeDir string, launcher types.AgentLauncher) string {
	return filepath.Join(runtimeDir, "bridges", filepath.FromSlash(launcher.BridgePackage), launcher.BridgeVersion)
}

// BridgePrepared reports whether the exact pinned package and bin are present
// and valid in the Runtime-owned cache. It never contacts the package registry.
func BridgePrepared(runtimeDir string, launcher types.AgentLauncher) bool {
	if runtimeDir == "" || launcher.BridgePackage == "" || launcher.BridgeVersion == "" || launcher.BridgeBin == "" {
		return false
	}
	_, _, err := validateBridge(bridgeCachePath(runtimeDir, launcher), launcher)
	return err == nil
}

// prepareBridge lazily installs one trusted registry bridge under the Runtime
// data root. Installation occurs in a unique sibling directory, is validated
// before promotion, and never uses npx or a global npm prefix.
func prepareBridge(runtimeDir string, launcher types.AgentLauncher, environment map[string]string) (string, []string, error) {
	if launcher.BridgePackage == "" || launcher.BridgeVersion == "" || launcher.BridgeBin == "" {
		return launcher.Command, append([]string(nil), launcher.Args...), nil
	}
	if runtimeDir == "" {
		return "", nil, &BridgePreparationError{Class: "bridge_cache_unavailable"}
	}
	final := bridgeCachePath(runtimeDir, launcher)
	if entry, _, err := validateBridge(final, launcher); err == nil {
		node, err := exec.LookPath("node")
		if err != nil {
			return "", nil, &BridgePreparationError{Class: "bridge_node_unavailable"}
		}
		return node, []string{entry}, nil
	}
	if _, err := os.Lstat(final); err == nil {
		if err := os.RemoveAll(final); err != nil {
			return "", nil, &BridgePreparationError{Class: "bridge_cache_unavailable"}
		}
	}

	parent := filepath.Dir(final)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return "", nil, &BridgePreparationError{Class: "bridge_cache_unavailable"}
	}
	npm, err := exec.LookPath("npm")
	if err != nil {
		return "", nil, &BridgePreparationError{Class: "bridge_npm_unavailable"}
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return "", nil, &BridgePreparationError{Class: "bridge_node_unavailable"}
	}
	staging, err := os.MkdirTemp(parent, ".bridge-stage-")
	if err != nil {
		return "", nil, &BridgePreparationError{Class: "bridge_cache_unavailable"}
	}
	defer os.RemoveAll(staging)

	ctx, cancel := context.WithTimeout(context.Background(), bridgeInstallTimeout)
	defer cancel()
	packageSpec := launcher.BridgePackage + "@" + launcher.BridgeVersion
	cmd := exec.CommandContext(ctx, npm, "install", "--prefix", staging, "--no-audit", "--no-fund", "--no-progress", packageSpec)
	cmd.Env = environmentSlice(environment)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", nil, &BridgePreparationError{Class: "bridge_prepare_timeout"}
		}
		return "", nil, &BridgePreparationError{Class: "bridge_install_failed"}
	}
	if _, _, err := validateBridge(staging, launcher); err != nil {
		return "", nil, &BridgePreparationError{Class: "bridge_package_invalid"}
	}

	// A corrupt old cache is never used. Rename promotion keeps readers from
	// observing an install in progress. If another process wins, validate and
	// use its complete cache instead of replacing it.
	if entry, _, validateErr := validateBridge(final, launcher); validateErr == nil {
		return node, []string{entry}, nil
	}
	if _, statErr := os.Lstat(final); statErr == nil {
		if removeErr := os.RemoveAll(final); removeErr != nil {
			return "", nil, &BridgePreparationError{Class: "bridge_cache_unavailable"}
		}
	}
	if err := os.Rename(staging, final); err != nil {
		if entry, _, validateErr := validateBridge(final, launcher); validateErr == nil {
			return node, []string{entry}, nil
		}
		return "", nil, &BridgePreparationError{Class: "bridge_cache_unavailable"}
	}
	entry, _, err := validateBridge(final, launcher)
	if err != nil {
		return "", nil, &BridgePreparationError{Class: "bridge_package_invalid"}
	}
	return node, []string{entry}, nil
}

// validateBridge checks the exact installed package/version, declared bin,
// executable shim/link, and entrypoint. The node entrypoint is used at launch
// so macOS/Linux symlinks and Windows npm command shims share one path.
func validateBridge(prefix string, launcher types.AgentLauncher) (entrypoint string, binPath string, err error) {
	packageDir := filepath.Join(prefix, "node_modules", filepath.FromSlash(launcher.BridgePackage))
	manifestPath := filepath.Join(packageDir, "package.json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return "", "", err
	}
	var manifest struct {
		Name    string          `json:"name"`
		Version string          `json:"version"`
		Bin     json.RawMessage `json:"bin"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil || manifest.Name != launcher.BridgePackage || manifest.Version != launcher.BridgeVersion {
		return "", "", errors.New("bridge manifest mismatch")
	}
	var binValue string
	var binMap map[string]string
	if json.Unmarshal(manifest.Bin, &binMap) == nil {
		binValue = binMap[launcher.BridgeBin]
	} else {
		_ = json.Unmarshal(manifest.Bin, &binValue)
		if binValue != "" && launcher.BridgeBin != packageBinDefault(launcher.BridgePackage) {
			binValue = ""
		}
	}
	if binValue == "" || filepath.IsAbs(binValue) {
		return "", "", errors.New("bridge bin missing")
	}
	entrypoint = filepath.Clean(filepath.Join(packageDir, binValue))
	relative, relErr := filepath.Rel(packageDir, entrypoint)
	if relErr != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", "", errors.New("bridge bin invalid")
	}
	if info, statErr := os.Stat(entrypoint); statErr != nil || !info.Mode().IsRegular() {
		return "", "", errors.New("bridge entrypoint missing")
	}
	binPath = filepath.Join(prefix, "node_modules", ".bin", launcher.BridgeBin)
	if runtime.GOOS == "windows" {
		binPath += ".cmd"
	}
	binInfo, err := os.Stat(binPath)
	if err != nil || !binInfo.Mode().IsRegular() || (runtime.GOOS != "windows" && binInfo.Mode().Perm()&0o111 == 0) {
		return "", "", errors.New("bridge bin shim missing")
	}
	return entrypoint, binPath, nil
}

func packageBinDefault(packageName string) string {
	base := filepath.Base(packageName)
	return strings.TrimSuffix(base, filepath.Ext(base))
}
