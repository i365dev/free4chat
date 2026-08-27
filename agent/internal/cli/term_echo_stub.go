//go:build !darwin && !linux

package cli

import "os"

// isTerminal is always false on platforms without terminal handling: speech
// setup fails closed there.
func isTerminal(file *os.File) bool { return false }

// termDisableEcho is a no-op on platforms where the interactive speech
// setup terminal handling is not implemented.
func termDisableEcho(file *os.File) func() {
	return func() {}
}
