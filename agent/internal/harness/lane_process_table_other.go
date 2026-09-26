//go:build !darwin && !linux

package harness

// Non-Unix builds keep the adapter's direct-process teardown only. The shipped
// Runtime targets Darwin and Linux, where lane process ownership is enabled.
type processIdentity uint64

type processRow struct {
	pid    int
	ppid   int
	ident  processIdentity
	zombie bool
}

func readProcessTable() []processRow { return nil }

func readProcessRow(int) (processRow, bool) { return processRow{}, false }
