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
	expected = strings.TrimSpace(expected)
	if expected == "" {
		return errors.New("expected daemon version is empty")
	}

	if version, err := daemonVersion(); err == nil {
		return requireDaemonVersion(expected, version)
	}
	// An older resident daemon may answer status while rejecting the new
	// daemon-info operation. Do not start a second daemon or forward join to
	// one whose build cannot be verified.
	if _, err := SendIPC(&IpcRequest{Op: "status"}); err == nil {
		return fmt.Errorf(
			"running daemon version could not be verified; refusing to join with runtime %s; stop/restart the daemon under host ownership",
			expected,
		)
	}

	if err := startDaemonProcess(); err != nil {
		return err
	}
	return waitForDaemonVersion(expected, 5*time.Second)
}

func daemonVersion() (string, error) {
	result, err := SendIPC(&IpcRequest{Op: "daemon-info"})
	if err != nil {
		return "", err
	}
	var info DaemonInfo
	if err := json.Unmarshal(result, &info); err != nil {
		return "", fmt.Errorf("daemon info response failed: %w", err)
	}
	info.DaemonVersion = strings.TrimSpace(info.DaemonVersion)
	if info.DaemonVersion == "" {
		return "", errors.New("daemon info response omitted daemonVersion")
	}
	return info.DaemonVersion, nil
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
	for time.Now().Before(deadline) {
		if _, err := SendIPC(&IpcRequest{Op: "status"}); err == nil {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return errors.New("free4chat-agent daemon did not start")
}

func waitForDaemonVersion(expected string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		version, err := daemonVersion()
		if err == nil {
			return requireDaemonVersion(expected, version)
		}
		lastErr = err
		time.Sleep(50 * time.Millisecond)
	}
	if lastErr == nil {
		return errors.New("free4chat-agent daemon did not report its version")
	}
	return fmt.Errorf("free4chat-agent daemon did not report its version: %w", lastErr)
}
