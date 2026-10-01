//go:build darwin || linux

package daemon

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

const (
	daemonLockRetryWindow   = 750 * time.Millisecond
	daemonLockRetryInterval = 10 * time.Millisecond
)

// ErrDaemonAlreadyRunning means another process owns this RuntimeDirectory.
var ErrDaemonAlreadyRunning = errors.New("another daemon is already running")

// lockDaemon retries short stop/restart contention, then fails closed if a
// different daemon continues to own the RuntimeDirectory.
func lockDaemon(dir string) (func(), error) {
	return lockDaemonWithRetry(dir, daemonLockRetryWindow, time.Sleep)
}

func lockDaemonWithRetry(dir string, retryWindow time.Duration, pause func(time.Duration)) (func(), error) {
	file, err := os.OpenFile(filepath.Join(dir, "daemon.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("daemon lock open failed: %w", err)
	}
	deadline := time.Now().Add(retryWindow)
	for {
		err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() {
				_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
				_ = file.Close()
			}, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			_ = file.Close()
			return nil, fmt.Errorf("daemon lock failed: %w", err)
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			_ = file.Close()
			return nil, ErrDaemonAlreadyRunning
		}
		interval := daemonLockRetryInterval
		if interval > remaining {
			interval = remaining
		}
		pause(interval)
	}
}
