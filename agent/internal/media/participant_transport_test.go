package media

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
	"github.com/pion/webrtc/v4"
)

type capabilityTestChannel struct{ payloads chan []byte }

func (c *capabilityTestChannel) Ready() bool { return true }
func (c *capabilityTestChannel) Send(payload []byte) error {
	c.payloads <- append([]byte(nil), payload...)
	return nil
}

type capabilityTestHandler struct {
	calls       chan types.ResidentCapabilityRequest
	descriptors []types.RuntimeCapabilityProjection
}

func (h *capabilityTestHandler) DescribeCapabilities() []types.RuntimeCapabilityProjection {
	return h.descriptors
}
func (h *capabilityTestHandler) HandleCapabilityRequest(_ context.Context, request types.ResidentCapabilityRequest) (map[string]any, error) {
	h.calls <- request
	return map[string]any{"status": "ready"}, nil
}

func validCapabilityTestDescriptor(capabilityID string, observe bool) types.RuntimeCapabilityProjection {
	descriptor := types.RuntimeCapabilityProjection{
		CapabilityID: capabilityID,
		Title:        "Status",
		Version:      "1",
		Observe:      observe,
		Actions:      []types.RuntimeCapabilityAction{},
	}
	return descriptor
}

func TestRuntimeParticipantTransportUsesBoundedParticipantFrames(t *testing.T) {
	handler := &capabilityTestHandler{
		calls:       make(chan types.ResidentCapabilityRequest, 1),
		descriptors: []types.RuntimeCapabilityProjection{validCapabilityTestDescriptor("printer_status", true)},
	}
	channel := &capabilityTestChannel{payloads: make(chan []byte, 1)}
	transport := NewRuntimeParticipantTransport("https://example.invalid", DecodedHandle{ParticipantID: "agent-a"}, handler, nil)
	transport.ctx = context.Background()
	transport.outbound = channel
	transport.routes = map[string]types.RuntimeParticipantTransportRoute{
		"generated:123e4567-e89b-12d3-a456-426614174000": {
			AppInstanceID:  "generated:123e4567-e89b-12d3-a456-426614174000",
			BundleRevision: 2, TaskRequestID: "task-a", AgentParticipantID: "agent-a",
			RuntimeHostID: "host-route-1", CapabilityIDs: []string{"printer_status"},
		},
	}
	transport.sources = map[string]string{"room-app-reliable-human-a-subscriber": "human-a"}
	requestPayload, _ := json.Marshal(capabilityFrame{
		Type: capabilityRequestFrame, RequestID: "request-a",
		AppInstanceID:  "generated:123e4567-e89b-12d3-a456-426614174000",
		BundleRevision: 2, TaskRequestID: "task-a", AgentID: "agent-a",
		CapabilityID: "printer_status", Operation: types.ResidentCapabilityObserve,
	})
	request, _ := json.Marshal(roomAppEnvelope{ProtocolVersion: 1, Lane: "reliable", AppInstanceID: "generated:123e4567-e89b-12d3-a456-426614174000", Payload: requestPayload})
	transport.receive("room-app-reliable-human-a-subscriber", request)
	select {
	case got := <-handler.calls:
		if got.RequestID != "request-a" || got.RuntimeHostID != "host-route-1" || got.CapabilityID != "printer_status" {
			t.Fatalf("request did not resolve through the projected originating route: %+v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("Runtime controller was not called")
	}
	select {
	case payload := <-channel.payloads:
		var envelope roomAppEnvelope
		var result capabilityFrame
		if err := json.Unmarshal(payload, &envelope); err != nil || envelope.ProtocolVersion != 1 || envelope.Lane != "reliable" {
			t.Fatalf("result did not use the bounded reliable Room App envelope: %s (%v)", payload, err)
		}
		if err := json.Unmarshal(envelope.Payload, &result); err != nil || result.Type != capabilityResultFrame || !result.OK || result.RequestID != "request-a" || result.Result["status"] != "ready" {
			t.Fatalf("result was not correlated on the same participant lane: %s (%v)", payload, err)
		}
	case <-time.After(time.Second):
		t.Fatal("Runtime did not return the bounded result on its participant lane")
	}
}

func TestRuntimeParticipantTransportDropsStaleRouteAndUnmappedSource(t *testing.T) {
	handler := &capabilityTestHandler{calls: make(chan types.ResidentCapabilityRequest, 1)}
	transport := NewRuntimeParticipantTransport("https://example.invalid", DecodedHandle{ParticipantID: "agent-a"}, handler, nil)
	transport.ctx = context.Background()
	transport.outbound = &capabilityTestChannel{payloads: make(chan []byte, 1)}
	transport.routes = map[string]types.RuntimeParticipantTransportRoute{}
	transport.sources = map[string]string{"room-app-reliable-human-a-subscriber": "human-a"}
	payload, _ := json.Marshal(roomAppEnvelope{ProtocolVersion: 1, Lane: "reliable", AppInstanceID: "generated:123e4567-e89b-12d3-a456-426614174000", Payload: json.RawMessage(`{"type":"runtime-capability-request","requestId":"request-a","appInstanceId":"generated:123e4567-e89b-12d3-a456-426614174000","bundleRevision":2,"taskRequestId":"task-a","agentParticipantId":"agent-a","capabilityId":"printer_status","operation":"observe"}`)})
	transport.receive("room-app-reliable-unknown-subscriber", payload)
	transport.receive("room-app-reliable-human-a-subscriber", payload)
	select {
	case <-handler.calls:
		t.Fatal("stale or unmapped route reached the capability controller")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestRuntimeParticipantTransportEnforcesCurrentDescriptorBeforeDispatch(t *testing.T) {
	invokeDescriptor := validCapabilityTestDescriptor("printer_status", false)
	action := types.RuntimeCapabilityAction{Name: "set_mode", Title: "Set mode"}
	action.Input.Type = "object"
	action.Input.Properties = map[string]string{"mode": "string"}
	action.Input.Required = []string{"mode"}
	invokeDescriptor.Actions = []types.RuntimeCapabilityAction{action}

	tests := []struct {
		name         string
		descriptor   types.RuntimeCapabilityProjection
		operation    types.ResidentCapabilityOperation
		action       string
		args         map[string]any
		wantDispatch bool
	}{
		{name: "observe disabled by descriptor", descriptor: validCapabilityTestDescriptor("printer_status", false), operation: types.ResidentCapabilityObserve},
		{name: "unknown invoke action", descriptor: invokeDescriptor, operation: types.ResidentCapabilityInvoke, action: "unknown", args: map[string]any{"mode": "quiet"}},
		{name: "invalid action args", descriptor: invokeDescriptor, operation: types.ResidentCapabilityInvoke, action: "set_mode", args: map[string]any{"mode": true}},
		{name: "missing required action arg", descriptor: invokeDescriptor, operation: types.ResidentCapabilityInvoke, action: "set_mode", args: map[string]any{}},
		{name: "advertised valid action", descriptor: invokeDescriptor, operation: types.ResidentCapabilityInvoke, action: "set_mode", args: map[string]any{"mode": "quiet"}, wantDispatch: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			handler := &capabilityTestHandler{
				calls:       make(chan types.ResidentCapabilityRequest, 1),
				descriptors: []types.RuntimeCapabilityProjection{test.descriptor},
			}
			outbound := &capabilityTestChannel{payloads: make(chan []byte, 1)}
			transport := NewRuntimeParticipantTransport("https://example.invalid", DecodedHandle{ParticipantID: "agent-a"}, handler, nil)
			transport.ctx = context.Background()
			transport.outbound = outbound
			appID := "generated:123e4567-e89b-12d3-a456-426614174000"
			route := types.RuntimeParticipantTransportRoute{
				AppInstanceID: appID, BundleRevision: 2, TaskRequestID: "task-a",
				AgentParticipantID: "agent-a", RuntimeHostID: "host-route-1",
				CapabilityIDs: []string{"printer_status"},
			}
			transport.routes = map[string]types.RuntimeParticipantTransportRoute{appID: route}
			transport.sources = map[string]string{"room-app-reliable-human-a-subscriber": "human-a"}
			frame := capabilityFrame{
				Type: capabilityRequestFrame, RequestID: "request-a", AppInstanceID: appID,
				BundleRevision: 2, TaskRequestID: "task-a", AgentID: "agent-a",
				CapabilityID: "printer_status", Operation: test.operation,
				Action: test.action, Args: test.args,
			}
			framePayload, _ := json.Marshal(frame)
			wire, _ := json.Marshal(roomAppEnvelope{ProtocolVersion: 1, Lane: "reliable", AppInstanceID: appID, Payload: framePayload})
			transport.receive("room-app-reliable-human-a-subscriber", wire)

			if test.wantDispatch {
				select {
				case got := <-handler.calls:
					if got.Operation != test.operation || got.Action != test.action {
						t.Fatalf("unexpected dispatched request: %+v", got)
					}
				case <-time.After(time.Second):
					t.Fatal("advertised valid operation did not reach the controller")
				}
			} else {
				select {
				case got := <-handler.calls:
					t.Fatalf("unadvertised operation reached the controller: %+v", got)
				case <-time.After(25 * time.Millisecond):
				}
			}
		})
	}
}

func TestNoMediaPionParticipantDataChannelsCarryReliableRequestAndResult(t *testing.T) {
	engineMessages := make(chan string, 2)
	engine := NewEngine(EngineEvents{OnDataChannelMessage: func(label string, payload []byte) {
		engineMessages <- label + ":" + string(payload)
	}}, nil)
	if err := engine.Create(); err != nil {
		t.Skipf("Pion unavailable: %v", err)
	}
	defer engine.Close()
	if err := engine.CreateServerEventsChannel(); err != nil {
		t.Fatal(err)
	}
	humanChannel, err := engine.CreateParticipantDataChannel("room-app-reliable-human-a-subscriber", 42)
	if err != nil {
		t.Fatal(err)
	}
	runtimeChannel, err := engine.CreateParticipantDataChannel("room-app-reliable-agent-a", 43)
	if err != nil {
		t.Fatal(err)
	}
	if got := len(engine.pc.GetTransceivers()); got != 0 {
		t.Fatalf("capability participant transport created media transceivers: %d", got)
	}

	peer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Skipf("local peer unavailable: %v", err)
	}
	defer peer.Close()
	peerHumanChannel, err := peer.CreateDataChannel("room-app-reliable-human-a", &webrtc.DataChannelInit{Negotiated: boolPtr(true), ID: uint16Ptr(42), Ordered: boolPtr(true)})
	if err != nil {
		t.Fatal(err)
	}
	peerRuntimeChannel, err := peer.CreateDataChannel("room-app-reliable-agent-a-subscriber", &webrtc.DataChannelInit{Negotiated: boolPtr(true), ID: uint16Ptr(43), Ordered: boolPtr(true)})
	if err != nil {
		t.Fatal(err)
	}
	peerMessages := make(chan string, 2)
	peerHumanChannel.OnMessage(func(message webrtc.DataChannelMessage) { peerMessages <- string(message.Data) })
	peerRuntimeChannel.OnMessage(func(message webrtc.DataChannelMessage) { peerMessages <- string(message.Data) })
	offer, err := engine.GatherCompleteOffer()
	if err != nil {
		t.Fatal(err)
	}
	if err := peer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer.SDP}); err != nil {
		t.Fatal(err)
	}
	answer, err := peer.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := peer.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	if _, _, err := engine.ApplyRemote(Description{Type: "answer", SDP: peer.LocalDescription().SDP}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := engine.WaitConnected(ctx, 10*time.Second); err != nil {
		t.Fatal(err)
	}
	for !humanChannel.Ready() || !runtimeChannel.Ready() || peer.ConnectionState() != webrtc.PeerConnectionStateConnected {
		select {
		case <-ctx.Done():
			t.Fatal("negotiated participant DataChannels did not open")
		case <-time.After(25 * time.Millisecond):
		}
	}
	request := []byte(`{"protocolVersion":1,"appInstanceId":"generated:123e4567-e89b-12d3-a456-426614174000","lane":"reliable","payload":{"type":"runtime-capability-request","requestId":"request-a"}}`)
	if err := peerHumanChannel.Send(request); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-engineMessages:
		if got != "room-app-reliable-human-a-subscriber:"+string(request) {
			t.Fatalf("request arrived on the wrong Runtime channel: %s", got)
		}
	case <-ctx.Done():
		t.Fatal("request did not reach the Runtime Pion DataChannel")
	}
	result := []byte(`{"protocolVersion":1,"appInstanceId":"generated:123e4567-e89b-12d3-a456-426614174000","lane":"reliable","payload":{"type":"runtime-capability-result","requestId":"request-a"}}`)
	if err := runtimeChannel.Send(result); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-peerMessages:
		if got != string(result) {
			t.Fatalf("result frame changed in transit: %s", got)
		}
	case <-ctx.Done():
		t.Fatal("result did not return on the Runtime participant DataChannel")
	}
}

func boolPtr(value bool) *bool       { return &value }
func uint16Ptr(value uint16) *uint16 { return &value }
