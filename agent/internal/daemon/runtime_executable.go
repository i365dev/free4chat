package daemon

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

const (
	runtimeExecutableDirectory  = "runtime-executables"
	runtimeExecutablePrefix     = "free4chat-agent-"
	runtimeExecutableTempPrefix = "runtime-executable-tmp-"
	maxRuntimeExecutableScan    = 64
)

// prepareRuntimeExecutable snapshots the daemon owner before any Harness is
// launched. A copied executable remains tied to this daemon even if an
// installer later atomically replaces the normal installed pathname.
func (d *Daemon) prepareRuntimeExecutable(runtimeDir string) error {
	root := filepath.Join(runtimeDir, runtimeExecutableDirectory)
	if err := os.MkdirAll(root, 0o700); err != nil {
		return fmt.Errorf("runtime executable directory failed: %w", err)
	}
	if err := os.Chmod(root, 0o700); err != nil {
		return fmt.Errorf("runtime executable directory permission failed: %w", err)
	}
	if err := removeStaleRuntimeExecutables(root); err != nil {
		return fmt.Errorf("stale runtime executable cleanup failed: %w", err)
	}
	if d.runtimeExecutable == "" {
		return errors.New("unable to locate daemon executable")
	}

	source, err := os.Open(d.runtimeExecutable)
	if err != nil {
		return fmt.Errorf("open daemon executable failed: %w", err)
	}
	defer source.Close()

	temporary, err := os.CreateTemp(root, runtimeExecutableTempPrefix)
	if err != nil {
		return fmt.Errorf("create runtime executable copy failed: %w", err)
	}
	temporaryName := temporary.Name()
	removeTemporary := true
	defer func() {
		if removeTemporary {
			_ = os.Remove(temporaryName)
		}
	}()

	if _, err := io.Copy(temporary, source); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("copy daemon executable failed: %w", err)
	}
	if err := temporary.Chmod(0o700); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("runtime executable permission failed: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close runtime executable copy failed: %w", err)
	}

	stableName := fmt.Sprintf("%s%d-%s", runtimeExecutablePrefix, os.Getpid(), NewID())
	stablePath := filepath.Join(root, stableName)
	if err := os.Rename(temporaryName, stablePath); err != nil {
		return fmt.Errorf("publish runtime executable copy failed: %w", err)
	}
	removeTemporary = false
	d.runtimeExecutableCopy = stablePath
	return nil
}

// cleanupRuntimeExecutable removes only this daemon's private snapshot. A
// dead daemon's snapshot is handled on the next startup by the bounded stale
// scan below.
func (d *Daemon) cleanupRuntimeExecutable() {
	path := d.runtimeExecutableCopy
	d.runtimeExecutableCopy = ""
	if path != "" {
		_ = os.Remove(path)
	}
}

// removeStaleRuntimeExecutables scans only the private, name-prefixed files
// created by this package. It never follows symlinks and caps one startup
// scan, so a damaged or unexpectedly populated Runtime root cannot turn
// daemon startup into an unbounded cleanup operation.
func removeStaleRuntimeExecutables(root string) error {
	directory, err := os.Open(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer directory.Close()

	entries, readErr := directory.Readdir(maxRuntimeExecutableScan)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return readErr
	}
	for _, entry := range entries {
		if entry.Mode()&os.ModeSymlink != 0 || !entry.Mode().IsRegular() {
			continue
		}
		if strings.HasPrefix(entry.Name(), runtimeExecutableTempPrefix) {
			if err := os.Remove(filepath.Join(root, entry.Name())); err != nil && !os.IsNotExist(err) {
				return err
			}
			continue
		}
		if !strings.HasPrefix(entry.Name(), runtimeExecutablePrefix) {
			continue
		}
		pid, ok := runtimeExecutablePID(entry.Name())
		if !ok || runtimeProcessAlive(pid) {
			continue
		}
		if err := os.Remove(filepath.Join(root, entry.Name())); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func runtimeExecutablePID(name string) (int, bool) {
	rest := strings.TrimPrefix(name, runtimeExecutablePrefix)
	separator := strings.IndexByte(rest, '-')
	if separator <= 0 {
		return 0, false
	}
	pid, err := strconv.Atoi(rest[:separator])
	return pid, err == nil && pid > 0
}

func runtimeProcessAlive(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = process.Signal(syscall.Signal(0))
	return err == nil || errors.Is(err, syscall.EPERM)
}
