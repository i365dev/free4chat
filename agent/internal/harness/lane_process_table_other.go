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

// These platforms have no lane process-ownership model: the adapter's teardown
// boundary is the direct provider process, exactly as before. The read is
// therefore reported as known-but-empty rather than unavailable, so the
// fail-closed rule above stays scoped to the shipped Darwin/Linux targets.
func readProcessTable() ([]processRow, bool) { return nil, true }

func readProcessRow(int) (processRow, bool) { return processRow{}, false }
