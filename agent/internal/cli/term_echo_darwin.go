//go:build darwin

package cli

import (
	"errors"
	"os"
	"syscall"
	"unsafe"
)

// isTerminal reports whether file is a real terminal (isatty semantics): the
// TIOCGETA ioctl succeeds on terminals and fails with ENOTTY on files,
// pipes, and character devices like /dev/null.
func isTerminal(file *os.File) bool {
	var termios syscall.Termios
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, file.Fd(), syscall.TIOCGETA, uintptr(unsafe.Pointer(&termios)))
	return errno == 0
}

// termDisableEcho turns off terminal echo on file's descriptor. It fails
// closed: if either termios ioctl fails, echo is NOT confirmed disabled and
// callers must not read credential input. On success the returned restore
// function puts the original termios back and reports its own error; the
// terminal is considered unsafely left if it fails.
func termDisableEcho(file *os.File) (func() error, error) {
	fd := file.Fd()
	var termios syscall.Termios
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TIOCGETA, uintptr(unsafe.Pointer(&termios))); errno != 0 {
		return nil, errors.New("terminal echo control is unavailable")
	}
	original := termios
	termios.Lflag &^= syscall.ECHO
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TIOCSETA, uintptr(unsafe.Pointer(&termios))); errno != 0 {
		return nil, errors.New("terminal echo control is unavailable")
	}
	return func() error {
		if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TIOCSETA, uintptr(unsafe.Pointer(&original))); errno != 0 {
			return errors.New("could not restore terminal echo settings")
		}
		return nil
	}, nil
}
