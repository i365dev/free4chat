package types

import (
	"strings"
	"testing"
)

func testCapabilityProjection() RuntimeCapabilityProjection {
	action := RuntimeCapabilityAction{Name: "set-state", Title: "Set state"}
	action.Input.Type = "object"
	action.Input.Properties = map[string]string{"value": "string"}
	action.Input.Required = []string{"value"}
	return RuntimeCapabilityProjection{
		CapabilityID: "fixture",
		Title:        "Fixture",
		Version:      "1",
		Observe:      true,
		Actions:      []RuntimeCapabilityAction{action},
	}
}

func TestRuntimeCapabilityProjectionAndRpcBounds(t *testing.T) {
	projection := testCapabilityProjection()
	if !projection.Valid() {
		t.Fatal("valid semantic projection rejected")
	}
	unsafe := testCapabilityProjection()
	unsafe.Actions[0].Input.Properties = map[string]string{"endpoint": "string"}
	if unsafe.Valid() {
		t.Fatal("endpoint field entered the Room projection")
	}
	tooMany := testCapabilityProjection()
	tooMany.Actions = make([]RuntimeCapabilityAction, 5)
	if tooMany.Valid() {
		t.Fatal("oversized action list accepted")
	}

	request := ResidentCapabilityRequest{
		RequestID:     "human-request-1",
		RuntimeHostID: "host-route-1",
		CapabilityID:  "fixture",
		Operation:     ResidentCapabilityInvoke,
		Action:        "set-state",
		Args:          map[string]any{"value": "on"},
	}
	if !request.Valid() {
		t.Fatal("valid invoke request rejected")
	}
	request.Args = map[string]any{"value": "https://127.0.0.1"}
	if request.Valid() {
		t.Fatal("local endpoint entered request args")
	}
	request.Args = map[string]any{"value": strings.Repeat("x", 9000)}
	if request.Valid() {
		t.Fatal("oversized request args accepted")
	}

	request.Args = map[string]any{"value": "on"}
	transportProjection := RuntimeParticipantTransportProjection{
		Routes: []RuntimeParticipantTransportRoute{{
			AppInstanceID:  "generated:123e4567-e89b-12d3-a456-426614174000",
			BundleRevision: 2, TaskRequestID: "task-origin", AgentParticipantID: "agent-a",
			HumanParticipantID: "human-a",
			RuntimeHostID:      "host-route-1", CapabilityIDs: []string{"fixture"},
		}},
		Sources: []RuntimeParticipantTransportSource{{ParticipantID: "human-a", SessionID: "human-session-1"}},
	}
	if !transportProjection.Valid() {
		t.Fatal("bounded participant transport association rejected")
	}
	secondHumanRoute := transportProjection.Routes[0]
	secondHumanRoute.HumanParticipantID = "human-b"
	transportProjection.Routes = append(transportProjection.Routes, secondHumanRoute)
	transportProjection.Sources = append(transportProjection.Sources, RuntimeParticipantTransportSource{
		ParticipantID: "human-b", SessionID: "human-session-2",
	})
	if !transportProjection.Valid() {
		t.Fatal("one Task App route per Room Human should be valid")
	}
	transportProjection.Routes = append(transportProjection.Routes, secondHumanRoute)
	if transportProjection.Valid() {
		t.Fatal("duplicate Task App/Human route should be rejected")
	}
	transportProjection.Routes = transportProjection.Routes[:2]
	tooManyRoutes := transportProjection
	tooManyRoutes.Routes = make([]RuntimeParticipantTransportRoute, 129)
	if tooManyRoutes.Valid() {
		t.Fatal("more than four Apps times 32 Human routes should be rejected")
	}
	transportProjection.Sources[0].SessionID = "https://local.invalid/session"
	if transportProjection.Valid() {
		t.Fatal("unbounded session metadata accepted")
	}

}
