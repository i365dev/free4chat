//go:build windows

package daemon

import "sync"

// hostSeedLock serializes in-process callers on windows builds. The release
// matrix has no windows target and windows has no flock in this build; the
// cross-process guarantee is only claimed for the supported platforms.
var hostSeedLock sync.Mutex

func lockHostSeed(dir string) (func(), error) {
	hostSeedLock.Lock()
	return func() { hostSeedLock.Unlock() }, nil
}
