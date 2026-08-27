//go:build darwin

package cli

import (
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

// termDisableEcho turns off terminal echo on file's descriptor until the
// returned restore function runs. Any ioctl failure leaves the terminal
// untouched and returns a no-op restore.
func termDisableEcho(file *os.File) func() {
	fd := file.Fd()
	var termios syscall.Termios
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TIOCGETA, uintptr(unsafe.Pointer(&termios))); errno != 0 {
		return func() {}
	}
	original := termios
	termios.Lflag &^= syscall.ECHO
	syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TIOCSETA, uintptr(unsafe.Pointer(&termios)))
	return func() {
		syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TIOCSETA, uintptr(unsafe.Pointer(&original)))
	}
}
