package runtime

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/types"
)

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

func TestBuildHarnessTurnProjectsSemanticCapabilitiesOnlyIntoTask(t *testing.T) {
	capabilities := []types.RuntimeCapabilityProjection{{
		CapabilityID: "printer_status", Title: "Printer status", Version: "1",
		Observe: true, Actions: []types.RuntimeCapabilityAction{},
	}}
	task := BuildHarnessTurn(nil, &TurnContextOptions{
		TaskRequestID: "req-T", TaskCapabilities: capabilities,
	})
	if len(task.TaskCapabilities) != 1 || task.TaskCapabilities[0].CapabilityID != "printer_status" {
		t.Fatalf("Task did not receive its semantic capability descriptor: %+v", task.TaskCapabilities)
	}
	encoded, _ := json.Marshal(task)
	for _, forbidden := range []string{"runtimeHostId", "endpoint", "queue", "127.0.0.1", "credential"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("Task context leaked integration detail %q: %s", forbidden, encoded)
		}
	}
	room := BuildHarnessTurn(nil, &TurnContextOptions{TaskCapabilities: capabilities})
	if len(room.TaskCapabilities) != 0 {
		t.Fatalf("ordinary Room turn received Task capability context: %+v", room.TaskCapabilities)
	}
}

func TestBuildHarnessTurnCarriesCurrentRoomApps(t *testing.T) {
	apps := []types.RoomAppProjection{{
		AppInstanceID: "test-app:0123abcd",
		AppID:         "test-app",
		Title:         "Test App",
		Source:        "curated",
		Callable:      true,
	}}
	input := BuildHarnessTurn(nil, &TurnContextOptions{RoomApps: apps})
	if len(input.Room.RoomApps) != 1 || input.Room.RoomApps[0] != apps[0] {
		t.Fatalf("turn Room Apps = %+v, want %+v", input.Room.RoomApps, apps)
	}
}
