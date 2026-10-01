//go:build !darwin && !linux

package daemon

import "errors"

var ErrDaemonAlreadyRunning = errors.New("another daemon is already running")

func lockDaemon(string) (func(), error) {
	return nil, errors.New("daemon singleton locking is unsupported on this platform")
}
