package daemon

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
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

	return waitForSocket(5 * time.Second)
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
