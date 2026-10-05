package media

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
	"github.com/pion/webrtc/v4"
)

type capabilityTestChannel struct{ payloads chan []byte }

func (c *capabilityTestChannel) Ready() bool { return true }
func (c *capabilityTestChannel) SendText(payload string) error {
	c.payloads <- []byte(payload)
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
	transport.outbound = map[string]reliableParticipantDataChannel{"human-a": channel}
	transport.routes = map[participantRouteKey]types.RuntimeParticipantTransportRoute{
		{appInstanceID: "generated:123e4567-e89b-12d3-a456-426614174000", humanParticipantID: "human-a"}: {
			AppInstanceID:  "generated:123e4567-e89b-12d3-a456-426614174000",
			BundleRevision: 2, TaskRequestID: "task-a", AgentParticipantID: "agent-a", HumanParticipantID: "human-a",
			RuntimeHostID: "host-route-1", CapabilityIDs: []string{"printer_status"},
		},
	}
	label := participantDirectReliableChannelName("agent-a", "human-a")
	transport.sources = map[string]string{label: "human-a"}
	requestPayload, _ := json.Marshal(capabilityFrame{
		Type: capabilityRequestFrame, RequestID: "request-a",
		AppInstanceID:  "generated:123e4567-e89b-12d3-a456-426614174000",
		BundleRevision: 2, TaskRequestID: "task-a", AgentID: "agent-a",
		CapabilityID: "printer_status", Operation: types.ResidentCapabilityObserve,
	})
	request, _ := json.Marshal(roomAppEnvelope{ProtocolVersion: 1, Lane: "reliable", AppInstanceID: "generated:123e4567-e89b-12d3-a456-426614174000", Payload: requestPayload})
	transport.receive(label, request)
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

func TestRuntimeParticipantTransportReturnsBoundedErrorForEnvelopeOversizeResult(t *testing.T) {
	channel := &capabilityTestChannel{payloads: make(chan []byte, 1)}
	transport := NewRuntimeParticipantTransport("https://example.invalid", DecodedHandle{ParticipantID: "agent-a"}, nil, nil)
	route := types.RuntimeParticipantTransportRoute{
		AppInstanceID:  "generated:123e4567-e89b-12d3-a456-426614174000",
		BundleRevision: 2, TaskRequestID: "task-a", AgentParticipantID: "agent-a",
		HumanParticipantID: "human-a", RuntimeHostID: "host-route-1",
		CapabilityIDs: []string{"printer_status"},
	}
	request := capabilityFrame{
		RequestID: "request-a", CapabilityID: "printer_status",
		Operation: types.ResidentCapabilityObserve,
	}
	largeResult := map[string]any{
		"items": []any{
			strings.Repeat("a", 4000),
			strings.Repeat("b", 4000),
			strings.Repeat("c", 4000),
			strings.Repeat("d", 4000),
		},
	}
	if !types.ResidentCapabilityResultPayloadValid(largeResult) {
		t.Fatal("test result must satisfy the documented semantic payload limit")
	}
	transport.sendResult(channel, route, request, "", largeResult)

	select {
	case wire := <-channel.payloads:
		if len(wire) > capabilityPayloadLimit {
			t.Fatalf("sent envelope has %d bytes, over the %d-byte limit", len(wire), capabilityPayloadLimit)
		}
		var envelope roomAppEnvelope
		var result capabilityFrame
		if err := json.Unmarshal(wire, &envelope); err != nil {
			t.Fatalf("decode result envelope: %v", err)
		}
		if err := json.Unmarshal(envelope.Payload, &result); err != nil {
			t.Fatalf("decode capability result: %v", err)
		}
		if result.Type != capabilityResultFrame || result.RequestID != request.RequestID ||
			result.OK || result.Error != "controller_error" || result.Result != nil {
			t.Fatalf("oversize result did not become a bounded correlated error: %+v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("oversize success was silently dropped instead of returning a bounded failure")
	}
}

func TestRuntimeParticipantTransportRoutesEachHumanToItsOwnPair(t *testing.T) {
	appID := "generated:123e4567-e89b-12d3-a456-426614174000"
	handler := &capabilityTestHandler{
		calls:       make(chan types.ResidentCapabilityRequest, 2),
		descriptors: []types.RuntimeCapabilityProjection{validCapabilityTestDescriptor("printer_status", true)},
	}
	humanA := &capabilityTestChannel{payloads: make(chan []byte, 1)}
	humanB := &capabilityTestChannel{payloads: make(chan []byte, 1)}
	transport := NewRuntimeParticipantTransport("https://example.invalid", DecodedHandle{ParticipantID: "agent-a"}, handler, nil)
	transport.ctx = context.Background()
	transport.outbound = map[string]reliableParticipantDataChannel{"human-a": humanA, "human-b": humanB}
	transport.routes = map[participantRouteKey]types.RuntimeParticipantTransportRoute{
		{appInstanceID: appID, humanParticipantID: "human-a"}: {
			AppInstanceID: appID, BundleRevision: 2, TaskRequestID: "task-a",
			AgentParticipantID: "agent-a", HumanParticipantID: "human-a",
			RuntimeHostID: "host-route-1", CapabilityIDs: []string{"printer_status"},
		},
		{appInstanceID: appID, humanParticipantID: "human-b"}: {
			AppInstanceID: appID, BundleRevision: 2, TaskRequestID: "task-a",
			AgentParticipantID: "agent-a", HumanParticipantID: "human-b",
			RuntimeHostID: "host-route-1", CapabilityIDs: []string{"printer_status"},
		},
	}
	labelA := participantDirectReliableChannelName("agent-a", "human-a")
	labelB := participantDirectReliableChannelName("agent-a", "human-b")
	transport.sources = map[string]string{labelA: "human-a", labelB: "human-b"}
	frame := capabilityFrame{
		Type: capabilityRequestFrame, RequestID: "request-a", AppInstanceID: appID,
		BundleRevision: 2, TaskRequestID: "task-a", AgentID: "agent-a",
		CapabilityID: "printer_status", Operation: types.ResidentCapabilityObserve,
	}
	framePayload, _ := json.Marshal(frame)
	wire, _ := json.Marshal(roomAppEnvelope{ProtocolVersion: 1, Lane: "reliable", AppInstanceID: appID, Payload: framePayload})
	frameB := frame
	frameB.RequestID = "request-b"
	framePayloadB, _ := json.Marshal(frameB)
	wireB, _ := json.Marshal(roomAppEnvelope{ProtocolVersion: 1, Lane: "reliable", AppInstanceID: appID, Payload: framePayloadB})
	transport.receive(labelB, wireB)
	transport.receive(labelA, wire)
	for range 2 {
		select {
		case <-handler.calls:
		case <-time.After(time.Second):
			t.Fatal("both Humans' private requests should reach the same Runtime")
		}
	}
	assertRequest := func(payload []byte, wantRequestID string) {
		t.Helper()
		var envelope roomAppEnvelope
		var result capabilityFrame
		if err := json.Unmarshal(payload, &envelope); err != nil || json.Unmarshal(envelope.Payload, &result) != nil || result.Type != capabilityResultFrame || result.RequestID != wantRequestID {
			t.Fatalf("result was not correlated to its requesting Human: %s", payload)
		}
	}
	select {
	case payload := <-humanA.payloads:
		assertRequest(payload, "request-a")
	case <-time.After(time.Second):
		t.Fatal("Agent result was not sent to Human A's private channel")
	}
	select {
	case payload := <-humanB.payloads:
		assertRequest(payload, "request-b")
	case <-time.After(time.Second):
		t.Fatal("Agent result was not sent to Human B's private channel")
	}
}

func TestRuntimeParticipantTransportDropsStaleRouteAndUnmappedSource(t *testing.T) {
	handler := &capabilityTestHandler{calls: make(chan types.ResidentCapabilityRequest, 1)}
	transport := NewRuntimeParticipantTransport("https://example.invalid", DecodedHandle{ParticipantID: "agent-a"}, handler, nil)
	transport.ctx = context.Background()
	transport.outbound = map[string]reliableParticipantDataChannel{"human-a": &capabilityTestChannel{payloads: make(chan []byte, 1)}}
	transport.routes = map[participantRouteKey]types.RuntimeParticipantTransportRoute{}
	transport.sources = map[string]string{participantDirectReliableChannelName("agent-a", "human-a"): "human-a"}
	payload, _ := json.Marshal(roomAppEnvelope{ProtocolVersion: 1, Lane: "reliable", AppInstanceID: "generated:123e4567-e89b-12d3-a456-426614174000", Payload: json.RawMessage(`{"type":"runtime-capability-request","requestId":"request-a","appInstanceId":"generated:123e4567-e89b-12d3-a456-426614174000","bundleRevision":2,"taskRequestId":"task-a","agentParticipantId":"agent-a","capabilityId":"printer_status","operation":"observe"}`)})
	transport.receive("participant-direct-reliable-unknown", payload)
	transport.receive(participantDirectReliableChannelName("agent-a", "human-a"), payload)
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
			transport.outbound = map[string]reliableParticipantDataChannel{"human-a": outbound}
			appID := "generated:123e4567-e89b-12d3-a456-426614174000"
			route := types.RuntimeParticipantTransportRoute{
				AppInstanceID: appID, BundleRevision: 2, TaskRequestID: "task-a",
				AgentParticipantID: "agent-a", HumanParticipantID: "human-a", RuntimeHostID: "host-route-1",
				CapabilityIDs: []string{"printer_status"},
			}
			transport.routes = map[participantRouteKey]types.RuntimeParticipantTransportRoute{{appInstanceID: appID, humanParticipantID: "human-a"}: route}
			label := participantDirectReliableChannelName("agent-a", "human-a")
			transport.sources = map[string]string{label: "human-a"}
			frame := capabilityFrame{
				Type: capabilityRequestFrame, RequestID: "request-a", AppInstanceID: appID,
				BundleRevision: 2, TaskRequestID: "task-a", AgentID: "agent-a",
				CapabilityID: "printer_status", Operation: test.operation,
				Action: test.action, Args: test.args,
			}
			framePayload, _ := json.Marshal(frame)
			wire, _ := json.Marshal(roomAppEnvelope{ProtocolVersion: 1, Lane: "reliable", AppInstanceID: appID, Payload: framePayload})
			transport.receive(label, wire)

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

func TestNoMediaPionPairwiseReliableChannelsDeliverTextResultOnlyToRequestingHuman(t *testing.T) {
	type channelMessage struct {
		label, payload string
		isString       bool
	}
	engineMessages := make(chan channelMessage, 4)
	engine := NewEngine(EngineEvents{OnDataChannelMessage: func(label string, payload []byte) {
		engineMessages <- channelMessage{label: label, payload: string(payload)}
	}}, nil)
	if err := engine.Create(); err != nil {
		t.Skipf("Pion unavailable: %v", err)
	}
	defer engine.Close()
	humanALabel := participantDirectReliableChannelName("agent-a", "human-a")
	humanBLabel := participantDirectReliableChannelName("agent-a", "human-b")
	humanAChannel, err := engine.CreateParticipantDataChannel(humanALabel, 42)
	if err != nil {
		t.Fatal(err)
	}
	humanBChannel, err := engine.CreateParticipantDataChannel(humanBLabel, 43)
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
	peerHumanAChannel, err := peer.CreateDataChannel(humanALabel+"-subscriber", &webrtc.DataChannelInit{Negotiated: boolPtr(true), ID: uint16Ptr(42), Ordered: boolPtr(true)})
	if err != nil {
		t.Fatal(err)
	}
	peerHumanBChannel, err := peer.CreateDataChannel(humanBLabel+"-subscriber", &webrtc.DataChannelInit{Negotiated: boolPtr(true), ID: uint16Ptr(43), Ordered: boolPtr(true)})
	if err != nil {
		t.Fatal(err)
	}
	peerMessages := make(chan channelMessage, 4)
	peerHumanAChannel.OnMessage(func(eventMessage webrtc.DataChannelMessage) {
		peerMessages <- channelMessage{label: humanALabel, payload: string(eventMessage.Data), isString: eventMessage.IsString}
	})
	peerHumanBChannel.OnMessage(func(eventMessage webrtc.DataChannelMessage) {
		peerMessages <- channelMessage{label: humanBLabel, payload: string(eventMessage.Data), isString: eventMessage.IsString}
	})
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
	for !humanAChannel.Ready() || !humanBChannel.Ready() || peer.ConnectionState() != webrtc.PeerConnectionStateConnected {
		select {
		case <-ctx.Done():
			t.Fatal("negotiated participant DataChannels did not open")
		case <-time.After(25 * time.Millisecond):
		}
	}
	request := []byte(`{"protocolVersion":1,"appInstanceId":"generated:123e4567-e89b-12d3-a456-426614174000","lane":"reliable","payload":{"type":"runtime-capability-request","requestId":"request-a"}}`)
	if err := peerHumanAChannel.SendText(string(request)); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-engineMessages:
		if got.label != humanALabel || got.payload != string(request) {
			t.Fatalf("request arrived on the wrong private Runtime channel: %+v", got)
		}
	case <-ctx.Done():
		t.Fatal("request did not reach the Runtime Pion DataChannel")
	}
	appInstanceID := "generated:123e4567-e89b-12d3-a456-426614174000"
	route := types.RuntimeParticipantTransportRoute{
		AppInstanceID: appInstanceID, BundleRevision: 2, TaskRequestID: "task-a",
		AgentParticipantID: "agent-a", HumanParticipantID: "human-a",
		CapabilityIDs: []string{"fixture_status"},
	}
	transport := NewRuntimeParticipantTransport("https://example.invalid", DecodedHandle{ParticipantID: "agent-a"}, nil, nil)
	transport.sendResult(humanAChannel, route, capabilityFrame{
		RequestID: "request-a", CapabilityID: "fixture_status", Operation: types.ResidentCapabilityObserve,
	}, "", map[string]any{"state": "ready", "counter": 1})
	select {
	case got := <-peerMessages:
		var envelope roomAppEnvelope
		var frame capabilityFrame
		if err := json.Unmarshal([]byte(got.payload), &envelope); err != nil {
			t.Fatalf("Runtime result was not JSON text: %v", err)
		}
		if err := json.Unmarshal(envelope.Payload, &frame); err != nil {
			t.Fatalf("Runtime result had an invalid envelope payload: %v", err)
		}
		if got.label != humanALabel || !got.isString || envelope.ProtocolVersion != 1 || envelope.AppInstanceID != appInstanceID || envelope.Lane != "reliable" || frame.Type != capabilityResultFrame || frame.RequestID != "request-a" || frame.BundleRevision != 2 || frame.Result["counter"] != float64(1) {
			t.Fatalf("result was not a text frame on the requesting Human's private channel: %+v", got)
		}
	case <-ctx.Done():
		t.Fatal("result did not return on the Human A pair channel")
	}
	select {
	case got := <-peerMessages:
		t.Fatalf("Human B received Human A's private result frame: %+v", got)
	case <-time.After(50 * time.Millisecond):
	}
	if humanBChannel.Ready() != true {
		t.Fatal("Human B pair channel did not open")
	}
}

func TestParticipantDataTransportCloseFencesFinalReadyTrue(t *testing.T) {
	transport := NewRuntimeParticipantTransport("https://example.invalid", DecodedHandle{ParticipantID: "agent-a"}, &capabilityTestHandler{}, nil)
	transport.session = "session-old"
	transport.generation = 1
	transport.starting = true
	readyTrueEntered := make(chan struct{})
	allowReadyTrueToFinish := make(chan struct{})
	var stateMu sync.Mutex
	ready := false
	var updates []bool
	transport.readyUpdate = func(session string, value bool) error {
		if session != "session-old" {
			t.Errorf("readiness update used unexpected session %q", session)
		}
		if value {
			close(readyTrueEntered)
			<-allowReadyTrueToFinish
		}
		stateMu.Lock()
		ready = value
		updates = append(updates, value)
		stateMu.Unlock()
		return nil
	}

	startResult := make(chan error, 1)
	go func() {
		startResult <- transport.publishReadyAndCheckCurrent("session-old", nil, 1)
	}()
	<-readyTrueEntered
	transport.Close()
	stateMu.Lock()
	if ready {
		stateMu.Unlock()
		t.Fatal("Close did not publish ready=false before stale Start returned")
	}
	stateMu.Unlock()
	close(allowReadyTrueToFinish)
	if err := <-startResult; err == nil || err.Error() != "participant_data_transport_closed" {
		t.Fatalf("stale Start result = %v, want participant_data_transport_closed", err)
	}
	stateMu.Lock()
	defer stateMu.Unlock()
	if ready {
		t.Fatal("stale ready=true remained observable after Close")
	}
	if !reflect.DeepEqual(updates, []bool{false, true, false}) {
		t.Fatalf("readiness update order = %v, want close false, stale true, corrective false", updates)
	}

	// A replacement is a fresh transport object and can publish its own ready
	// state after the old object's corrective false has completed.
	replacement := NewRuntimeParticipantTransport("https://example.invalid", DecodedHandle{ParticipantID: "agent-a"}, &capabilityTestHandler{}, nil)
	replacement.session = "session-new"
	replacement.generation = 1
	replacement.starting = true
	newReady := false
	replacement.readyUpdate = func(session string, value bool) error {
		if session != "session-new" {
			t.Errorf("replacement readiness update used unexpected session %q", session)
		}
		newReady = value
		return nil
	}
	if err := replacement.publishReadyAndCheckCurrent("session-new", nil, 1); err != nil {
		t.Fatalf("replacement transport could not become ready: %v", err)
	}
	if !newReady || replacement.session != "session-new" {
		t.Fatal("replacement transport was cleared or remained unavailable")
	}
}

func TestParticipantDataTransportStaleStartFailureCannotClearNewerSession(t *testing.T) {
	transport := NewRuntimeParticipantTransport("https://example.invalid", DecodedHandle{ParticipantID: "agent-a"}, &capabilityTestHandler{}, nil)
	newEngine := &Engine{}
	transport.generation = 2
	transport.session = "session-new"
	transport.engine = newEngine
	transport.starting = true
	transport.finishStartFailure(1, "session-old", nil)
	if transport.session != "session-new" || transport.engine != newEngine || !transport.starting {
		t.Fatal("stale Start failure cleared or replaced the current transport")
	}
}

func boolPtr(value bool) *bool       { return &value }
func uint16Ptr(value uint16) *uint16 { return &value }

func TestCompleteParticipantDataTransportBootstrapSupportsAnswerAndOffer(t *testing.T) {
	for _, test := range []struct {
		name        string
		remote      Description
		applyResult string
		localAnswer *Description
		wantCalls   []string
	}{
		{
			name:        "SFU answer",
			remote:      Description{Type: "answer", SDP: "sfu-answer"},
			applyResult: "answer",
			wantCalls:   []string{"apply:answer", "wait"},
		},
		{
			name:        "SFU offer",
			remote:      Description{Type: "offer", SDP: "sfu-offer"},
			applyResult: "offer",
			localAnswer: &Description{Type: "answer", SDP: "local-answer"},
			wantCalls:   []string{"apply:offer", "renegotiate", "wait"},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			var calls []string
			ctx := context.Background()
			err := completeParticipantDataTransportBootstrap(
				ctx,
				"participant-session",
				test.remote,
				func(remote Description) (string, *Description, error) {
					calls = append(calls, "apply:"+remote.Type)
					return test.applyResult, test.localAnswer, nil
				},
				func(session string, answer Description, purpose Purpose) error {
					calls = append(calls, "renegotiate")
					if test.remote.Type != "offer" {
						t.Fatal("answer response must not require renegotiation")
					}
					if session != "participant-session" || answer != *test.localAnswer || purpose != PurposeParticipantReliable {
						t.Fatalf("renegotiation = (%q, %+v, %q), want participant session, local answer, participant-reliable", session, answer, purpose)
					}
					return nil
				},
				func(_ context.Context, timeout time.Duration) error {
					calls = append(calls, "wait")
					if timeout != 30*time.Second {
						t.Fatalf("connection timeout = %s, want 30s", timeout)
					}
					if !reflect.DeepEqual(calls, test.wantCalls) {
						t.Fatalf("calls before connection wait = %v, want %v", calls, test.wantCalls)
					}
					return nil
				},
			)
			if err != nil {
				t.Fatalf("complete bootstrap: %v", err)
			}
			if !reflect.DeepEqual(calls, test.wantCalls) {
				t.Fatalf("bootstrap calls = %v, want %v", calls, test.wantCalls)
			}
		})
	}
}
