//go:build darwin || linux

package daemon

import (
	"os"
	"testing"
	"time"
)

func TestDaemonLockRetriesTransientContention(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "fcagent-lock-retry-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)

	releaseOwner, err := lockDaemon(dir)
	if err != nil {
		t.Fatalf("initial owner failed to acquire lock: %v", err)
	}
	firstRetry := make(chan struct{}, 1)
	continueRetry := make(chan struct{})
	type lockResult struct {
		release func()
		err     error
	}
	result := make(chan lockResult, 1)
	go func() {
		release, err := lockDaemonWithRetry(dir, time.Second, func(time.Duration) {
			select {
			case firstRetry <- struct{}{}:
			default:
			}
			<-continueRetry
		})
		result <- lockResult{release: release, err: err}
	}()

	select {
	case <-firstRetry:
	case <-time.After(time.Second):
		releaseOwner()
		close(continueRetry)
		select {
		case got := <-result:
			if got.release != nil {
				got.release()
			}
		case <-time.After(time.Second):
		}
		t.Fatal("contending lock attempt did not reach its retry wait")
	}
	releaseOwner()
	close(continueRetry)
	select {
	case got := <-result:
		if got.err != nil {
			t.Fatalf("transient contention prevented replacement ownership: %v", got.err)
		}
		got.release()
	case <-time.After(2 * time.Second):
		t.Fatal("replacement lock did not acquire after the owner released it")
	}
}
