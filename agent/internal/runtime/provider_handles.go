package runtime

import (
	"sync"

	"github.com/i365dev/free4chat/agent/internal/types"
)

// ProviderHandleStore is daemon-owned volatile capability storage. It is
// shared only by resident Runtimes in this daemon process so Pi/Codex/Hermes
// on one Runtime Host can use one redeemed provider association. It is never
// serialized, logged, included in Status, or written to a workspace.
type ProviderHandleStore struct {
	mu      sync.Mutex
	handles map[string]string
}

func NewProviderHandleStore() *ProviderHandleStore {
	return &ProviderHandleStore{handles: map[string]string{}}
}

func providerHandleKey(roomID, runtimeHostID string) string {
	return roomID + "\x00" + runtimeHostID
}

func (s *ProviderHandleStore) Get(roomID, runtimeHostID string) string {
	if s == nil {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.handles[providerHandleKey(roomID, runtimeHostID)]
}

func (s *ProviderHandleStore) Put(roomID, runtimeHostID, handle string) {
	if s == nil || !types.ValidRuntimeProviderCredential(handle) {
		return
	}
	s.mu.Lock()
	s.handles[providerHandleKey(roomID, runtimeHostID)] = handle
	s.mu.Unlock()
}

func (s *ProviderHandleStore) Delete(roomID, runtimeHostID string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	delete(s.handles, providerHandleKey(roomID, runtimeHostID))
	s.mu.Unlock()
}
