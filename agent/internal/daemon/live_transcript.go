package daemon

import "sync"

// TranscriptProducerCoordinator is the daemon-local ownership ledger for one
// Room-wide Live Transcript producer. The Room control plane chooses a
// Runtime Host; this only elects exactly one local resident belonging to that
// Host. It never permits another Host to take over and it persists nothing.
type TranscriptProducerCoordinator struct {
	mu     sync.Mutex
	leases map[string]transcriptProducerLease
}

type transcriptProducerLease struct {
	epoch      int64
	instanceID string
}

func NewTranscriptProducerCoordinator() *TranscriptProducerCoordinator {
	return &TranscriptProducerCoordinator{leases: make(map[string]transcriptProducerLease)}
}

func transcriptProducerKey(roomID, runtimeHostID string) string {
	return roomID + "\x00" + runtimeHostID
}

// Acquire elects one local instance for the exact Room Host epoch. A changed
// epoch replaces a stale lease; the same epoch is deliberately sticky until
// its holder releases, avoiding duplicate STT from same-host residents.
func (c *TranscriptProducerCoordinator) Acquire(roomID, runtimeHostID string, epoch int64, instanceID string) bool {
	if c == nil || roomID == "" || runtimeHostID == "" || epoch <= 0 || instanceID == "" {
		return false
	}
	key := transcriptProducerKey(roomID, runtimeHostID)
	c.mu.Lock()
	defer c.mu.Unlock()
	current, exists := c.leases[key]
	if !exists || current.epoch != epoch {
		c.leases[key] = transcriptProducerLease{epoch: epoch, instanceID: instanceID}
		return true
	}
	return current.instanceID == instanceID
}

// Release relinquishes only the exact owned epoch, so a late callback from a
// stale controller cannot remove a newer producer lease.
func (c *TranscriptProducerCoordinator) Release(roomID, runtimeHostID string, epoch int64, instanceID string) {
	if c == nil {
		return
	}
	key := transcriptProducerKey(roomID, runtimeHostID)
	c.mu.Lock()
	if current, ok := c.leases[key]; ok && current.epoch == epoch && current.instanceID == instanceID {
		delete(c.leases, key)
	}
	c.mu.Unlock()
}

// ReleaseInstance is defensive daemon cleanup for leave/expiry/shutdown.
func (c *TranscriptProducerCoordinator) ReleaseInstance(instanceID string) {
	if c == nil || instanceID == "" {
		return
	}
	c.mu.Lock()
	for key, current := range c.leases {
		if current.instanceID == instanceID {
			delete(c.leases, key)
		}
	}
	c.mu.Unlock()
}
