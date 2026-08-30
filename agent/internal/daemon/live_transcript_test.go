package daemon

import "testing"

func TestTranscriptProducerCoordinatorElectsOneSameHostResident(t *testing.T) {
	coordinator := NewTranscriptProducerCoordinator()
	if !coordinator.Acquire("room", "host-a", 1, "instance-a") {
		t.Fatal("first same-host resident must acquire")
	}
	if coordinator.Acquire("room", "host-a", 1, "instance-b") {
		t.Fatal("second same-host resident must not duplicate the producer")
	}
	if !coordinator.Acquire("room", "host-b", 1, "instance-b") {
		t.Fatal("a distinct Room-selected Host has an independent local key")
	}
	coordinator.Release("room", "host-a", 1, "instance-a")
	if !coordinator.Acquire("room", "host-a", 1, "instance-b") {
		t.Fatal("a same-host resident must take over after the owner leaves")
	}
}

func TestTranscriptProducerCoordinatorEpochAndInstanceCleanupAreExact(t *testing.T) {
	coordinator := NewTranscriptProducerCoordinator()
	if !coordinator.Acquire("room", "host-a", 1, "instance-a") {
		t.Fatal("initial acquire failed")
	}
	if !coordinator.Acquire("room", "host-a", 2, "instance-b") {
		t.Fatal("new Room epoch must replace stale lease")
	}
	coordinator.Release("room", "host-a", 1, "instance-a")
	if coordinator.Acquire("room", "host-a", 2, "instance-c") {
		t.Fatal("stale release must not remove newer owner")
	}
	coordinator.ReleaseInstance("instance-b")
	if !coordinator.Acquire("room", "host-a", 2, "instance-c") {
		t.Fatal("daemon instance cleanup must release its exact ownership")
	}
}
