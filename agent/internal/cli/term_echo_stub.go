//go:build !darwin && !linux

package cli

import (
	"errors"
	"os"
)

// isTerminal is always false on platforms without terminal handling: speech
// setup fails closed there.
func isTerminal(file *os.File) bool { return false }

// termDisableEcho fails closed on platforms without terminal handling: no
// credential input may be read there.
func termDisableEcho(file *os.File) (func() error, error) {
	return nil, errors.New("terminal echo control is unavailable on this platform")
}
