package runtime

import "testing"

// TestBuildHarnessTurnCarriesExactTaskRequestID pins the plumbing half of the
// #421 dogfood fix E: the Runtime puts the exact canonical Task request id of
// the turn's scope into the Harness turn input, and leaves it empty for the
// ordinary Room conversation, so the prompt can state the correlation id
// without ever inferring a "current Task".
func TestBuildHarnessTurnCarriesExactTaskRequestID(t *testing.T) {
	task := BuildHarnessTurn(nil, &TurnContextOptions{TaskRequestID: "req-T"})
	if task.TaskRequestID != "req-T" {
		t.Fatalf("task turn input must carry the exact Task request id, got %q", task.TaskRequestID)
	}
	room := BuildHarnessTurn(nil, &TurnContextOptions{})
	if room.TaskRequestID != "" {
		t.Fatalf("Room turn input must not carry a Task request id, got %q", room.TaskRequestID)
	}
	nilContext := BuildHarnessTurn(nil, nil)
	if nilContext.TaskRequestID != "" {
		t.Fatalf("nil context must not carry a Task request id, got %q", nilContext.TaskRequestID)
	}
}
