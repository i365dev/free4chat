//go:build !darwin && !linux

package harness

type processSnapshot struct {
	pgid        int
	alive       bool
	descendants int
	rssKB       int64
}

func snapshotProviderProcess(int) processSnapshot { return processSnapshot{} }
