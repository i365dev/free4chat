package daemon

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// SendIPC delivers one request to the running daemon and returns the parsed
// result envelope. One connection, one newline-delimited exchange.
func SendIPC(request *IpcRequest) (json.RawMessage, error) {
	conn, err := net.DialTimeout("unix", SocketPath(), 2*time.Second)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	data, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	if _, err := conn.Write(append(data, '\n')); err != nil {
		return nil, err
	}
	reader := bufio.NewReaderSize(conn, 4*1024*1024)
	line, readErr := reader.ReadString('\n')
	if readErr != nil && len(line) == 0 {
		return nil, fmt.Errorf("daemon request failed: %w", readErr)
	}
	var response struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
		Error  string          `json:"error"`
	}
	if err := json.Unmarshal([]byte(line), &response); err != nil {
		return nil, fmt.Errorf("daemon response failed: %w", err)
	}
	if !response.OK {
		message := response.Error
		if message == "" {
			message = "daemon request failed"
		}
		return nil, errors.New(message)
	}
	return response.Result, nil
}

// EnsureDaemon reaches the existing daemon or spawns a detached one and
// waits until the IPC surface answers a status probe.
func EnsureDaemon() error {
	if _, err := SendIPC(&IpcRequest{Op: "status"}); err == nil {
		return nil
	} else if !daemonSocketUnavailable(err) {
		// A response/protocol failure from a reachable socket is not evidence
		// that the daemon failed to start. Preserve the downstream IPC cause.
		return fmt.Errorf("daemon health check failed: %w", err)
	}
	if err := startDaemonProcess(); err != nil {
		return err
	}
	return waitForSocket(5 * time.Second)
}

// EnsureDaemonVersion reaches a daemon only after proving that its build
// version matches the invoking CLI. A responding daemon that cannot answer the
// version handshake is treated as untrusted rather than silently reused.
// This is a guard before join, not a self-update or restart mechanism.
func EnsureDaemonVersion(expected string) error {
	return EnsureDaemonProvenance(expected, "")
}

// EnsureDaemonProvenance verifies semantic version and, when both builds
// expose a source identity, exact source revision before a join/create can be
// forwarded. Unknown identities preserve compatibility with older/release
// binaries; a known mismatch is never silently reused.
func EnsureDaemonProvenance(expectedVersion, expectedBuild string) error {
	expectedVersion = strings.TrimSpace(expectedVersion)
	expectedBuild = strings.TrimSpace(expectedBuild)
	if expectedVersion == "" {
		return errors.New("expected daemon version is empty")
	}
	expectedRoot, err := RuntimeRootIdentity()
	if err != nil {
		return errors.New("local runtime root identity unavailable; refusing to join")
	}

	if info, infoErr := daemonInfo(); infoErr == nil {
		return requireDaemonProvenance(expectedVersion, expectedBuild, expectedRoot, info)
	}
	// An older resident daemon may answer status while rejecting the new
	// daemon-info operation. Do not start a second daemon or forward join to
	// one whose build cannot be verified.
	if _, err := SendIPC(&IpcRequest{Op: "status"}); err == nil {
		return fmt.Errorf(
			"running daemon provenance could not be verified; refusing to join with runtime %s; stop/restart or reselect the host-owned daemon",
			expectedVersion,
		)
	} else if !daemonSocketUnavailable(err) {
		return fmt.Errorf("daemon health check failed: %w", err)
	}

	if err := startDaemonProcess(); err != nil {
		return err
	}
	return waitForDaemonProvenance(expectedVersion, expectedBuild, expectedRoot, 5*time.Second)
}

func daemonVersion() (string, error) {
	info, err := daemonInfo()
	if err != nil {
		return "", err
	}
	return info.DaemonVersion, nil
}

func daemonInfo() (DaemonInfo, error) {
	result, err := SendIPC(&IpcRequest{Op: "daemon-info"})
	if err != nil {
		return DaemonInfo{}, err
	}
	var info DaemonInfo
	if err := json.Unmarshal(result, &info); err != nil {
		return DaemonInfo{}, fmt.Errorf("daemon info response failed: %w", err)
	}
	info.DaemonVersion = strings.TrimSpace(info.DaemonVersion)
	if info.DaemonVersion == "" {
		return DaemonInfo{}, errors.New("daemon info response omitted daemonVersion")
	}
	return info, nil
}

func requireDaemonVersion(expected, actual string) error {
	if actual == expected {
		return nil
	}
	return fmt.Errorf(
		"running daemon version %s does not match runtime %s; stop/restart the daemon under host ownership",
		actual,
		expected,
	)
}

func requireDaemonProvenance(expectedVersion, expectedBuild, expectedRoot string, actual DaemonInfo) error {
	if err := requireDaemonVersion(expectedVersion, actual.DaemonVersion); err != nil {
		return err
	}
	actualBuild := strings.TrimSpace(actual.BuildIdentity)
	if expectedBuild != "" {
		if actualBuild == "" {
			return errors.New("running daemon cannot prove its build identity; refusing to join; stop/restart or reselect the host-owned daemon")
		}
		if expectedBuild != actualBuild {
			return fmt.Errorf("running daemon build %s does not match CLI build %s; refusing to join; stop/restart or reselect the host-owned daemon", actualBuild, expectedBuild)
		}
	}
	actualRoot := strings.TrimSpace(actual.RuntimeRootIdentity)
	if expectedRoot != "" {
		if actualRoot == "" {
			return errors.New("running daemon cannot prove its Runtime root identity; refusing to join; stop/restart or reselect the host-owned daemon")
		}
		if expectedRoot != actualRoot {
			return errors.New("running daemon belongs to a different Runtime root; refusing to join; reselect the intended Runtime root")
		}
	}
	return nil
}

func startDaemonProcess() error {
	self, err := os.Executable()
	if err != nil {
		return fmt.Errorf("unable to locate daemon executable: %w", err)
	}
	command := exec.Command(self, "daemon")
	command.Env = os.Environ()
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		return fmt.Errorf("unable to start daemon: %w", err)
	}
	_ = command.Process.Release()
	return nil
}

// waitForSocket polls the IPC status op until the daemon answers.
func waitForSocket(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		if _, err := SendIPC(&IpcRequest{Op: "status"}); err == nil {
			return nil
		} else {
			lastErr = err
			if !daemonSocketUnavailable(err) {
				return fmt.Errorf("daemon health check failed after start: %w", err)
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	if lastErr != nil {
		return fmt.Errorf("free4chat-agent daemon unavailable after start: %w", lastErr)
	}
	return errors.New("free4chat-agent daemon did not start")
}

// daemonSocketUnavailable distinguishes a missing/refused Unix socket from a
// reachable daemon returning an IPC or operation error.
func daemonSocketUnavailable(err error) bool {
	var opErr *net.OpError
	if !errors.As(err, &opErr) {
		return false
	}
	return opErr.Op == "dial" || opErr.Op == "connect"
}

func waitForDaemonVersion(expected string, timeout time.Duration) error {
	return waitForDaemonProvenance(expected, "", "", timeout)
}

func waitForDaemonProvenance(expectedVersion, expectedBuild, expectedRoot string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		info, err := daemonInfo()
		if err == nil {
			return requireDaemonProvenance(expectedVersion, expectedBuild, expectedRoot, info)
		}
		lastErr = err
		time.Sleep(50 * time.Millisecond)
	}
	if lastErr == nil {
		return errors.New("free4chat-agent daemon did not report its version")
	}
	return fmt.Errorf("free4chat-agent daemon did not report its version: %w", lastErr)
}
