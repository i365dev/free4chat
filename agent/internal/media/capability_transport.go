package media

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

const (
	capabilityRequestFrame = "runtime-capability-request"
	capabilityResultFrame  = "runtime-capability-result"
	capabilityRequestLimit = 4
	capabilityPayloadLimit = 16 * 1024
	capabilitySeenLimit    = 64
)

type capabilityFrame struct {
	Type           string                            `json:"type"`
	RequestID      string                            `json:"requestId"`
	AppInstanceID  string                            `json:"appInstanceId"`
	BundleRevision int64                             `json:"bundleRevision"`
	TaskRequestID  string                            `json:"taskRequestId"`
	AgentID        string                            `json:"agentParticipantId"`
	RuntimeHostID  string                            `json:"runtimeHostId,omitempty"`
	CapabilityID   string                            `json:"capabilityId"`
	Operation      types.ResidentCapabilityOperation `json:"operation"`
	Action         string                            `json:"action,omitempty"`
	Args           map[string]any                    `json:"args,omitempty"`
	OK             bool                              `json:"ok,omitempty"`
	Result         map[string]any                    `json:"result,omitempty"`
	Error          string                            `json:"error,omitempty"`
}

type roomAppEnvelope struct {
	ProtocolVersion int             `json:"protocolVersion"`
	AppInstanceID   string          `json:"appInstanceId"`
	Lane            string          `json:"lane"`
	Payload         json.RawMessage `json:"payload"`
}

type reliableParticipantDataChannel interface {
	Ready() bool
	Send([]byte) error
}

// ParticipantCapabilityTransport owns a media-free Pion connection for the
// currently projected Generated App association. It has no queue: requests
// are admitted only while the peer and the matching source channel are live.
type ParticipantCapabilityTransport struct {
	siteOrigin string
	handle     DecodedHandle
	handler    types.ResidentCapabilityController
	log        func(string, map[string]string)

	mu       sync.Mutex
	closed   bool
	ctx      context.Context
	cancel   context.CancelFunc
	session  string
	engine   *Engine
	outbound reliableParticipantDataChannel
	routes   map[string]types.CapabilityTransportRoute
	sources  map[string]string // negotiated subscriber label -> participant id
	inflight chan struct{}
	seen     map[string]time.Time
}

func NewParticipantCapabilityTransport(siteOrigin string, handle DecodedHandle, handler types.ResidentCapabilityController, log func(string, map[string]string)) *ParticipantCapabilityTransport {
	if log == nil {
		log = func(string, map[string]string) {}
	}
	return &ParticipantCapabilityTransport{siteOrigin: siteOrigin, handle: handle, handler: handler, log: log, inflight: make(chan struct{}, capabilityRequestLimit), seen: map[string]time.Time{}}
}

func (t *ParticipantCapabilityTransport) Start(ctx context.Context, projection types.CapabilityTransportProjection) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if !projection.Valid() || len(projection.Routes) == 0 {
		return errors.New("capability_transport_unavailable")
	}
	if t.handler == nil {
		return errors.New("capability_controller_unavailable")
	}
	available := make(map[string]struct{})
	for _, capability := range t.handler.DescribeCapabilities() {
		if capability.Valid() {
			available[capability.CapabilityID] = struct{}{}
		}
	}
	filteredRoutes := make([]types.CapabilityTransportRoute, 0, len(projection.Routes))
	for _, route := range projection.Routes {
		if route.AgentParticipantID != t.handle.ParticipantID {
			return errors.New("capability_route_participant_mismatch")
		}
		capabilityIDs := make([]string, 0, len(route.CapabilityIDs))
		for _, id := range route.CapabilityIDs {
			if _, ok := available[id]; ok {
				capabilityIDs = append(capabilityIDs, id)
			}
		}
		if len(capabilityIDs) == 0 {
			return errors.New("capability_controller_unavailable")
		}
		route.CapabilityIDs = capabilityIDs
		filteredRoutes = append(filteredRoutes, route)
	}
	projection.Routes = filteredRoutes
	transportCtx, cancel := context.WithCancel(ctx)
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		cancel()
		return errors.New("capability_transport_closed")
	}
	t.ctx, t.cancel = transportCtx, cancel
	t.mu.Unlock()
	rest := NewSfuRestClient(t.siteOrigin, t.handle)
	session, err := rest.CreateAgentCapabilitySession()
	if err != nil {
		cancel()
		return err
	}
	t.mu.Lock()
	t.session = session
	t.mu.Unlock()
	events := EngineEvents{OnDataChannelMessage: func(label string, payload []byte) { t.receive(label, payload) }}
	engine := NewEngine(events, t.log)
	fail := func(err error) error {
		cancel()
		engine.Close()
		_ = rest.SetAgentCapabilityReady(session, false)
		return err
	}
	if err := engine.Create(); err != nil {
		return fail(err)
	}
	if err := engine.CreateServerEventsChannel(); err != nil {
		return fail(err)
	}
	offer, err := engine.GatherCompleteOffer()
	if err != nil {
		return fail(err)
	}
	answer, err := rest.EstablishDataChannelTransport(session, *offer, PurposeGeneratedAppCapability)
	if err != nil {
		return fail(err)
	}
	if _, _, err := engine.ApplyRemote(answer); err != nil {
		return fail(err)
	}
	if err := engine.WaitConnected(transportCtx, 30*time.Second); err != nil {
		return fail(err)
	}

	channels := []map[string]any{{"location": "local", "dataChannelName": "room-app-reliable-" + t.handle.ParticipantID, "ordered": true}}
	for _, source := range projection.Sources {
		channels = append(channels, map[string]any{"location": "remote", "sessionId": source.SessionID, "dataChannelName": "room-app-reliable-" + source.ParticipantID, "ordered": true, "waitForAck": true})
	}
	ids, err := rest.CreateParticipantDataChannels(session, channels)
	if err != nil {
		return fail(err)
	}
	outbound, err := engine.CreateParticipantDataChannel("room-app-reliable-"+t.handle.ParticipantID, ids[0])
	if err != nil {
		return fail(err)
	}
	sources := make(map[string]string, len(projection.Sources))
	channelsReady := []*ParticipantDataChannel{outbound}
	for i, source := range projection.Sources {
		label := "room-app-reliable-" + source.ParticipantID + "-subscriber"
		channel, err := engine.CreateParticipantDataChannel(label, ids[i+1])
		if err != nil {
			return fail(err)
		}
		channelsReady = append(channelsReady, channel)
		sources[label] = source.ParticipantID
	}
	allReady := func() bool {
		for _, channel := range channelsReady {
			if !channel.Ready() {
				return false
			}
		}
		return true
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && !allReady() {
		select {
		case <-transportCtx.Done():
			return fail(transportCtx.Err())
		case <-time.After(50 * time.Millisecond):
		}
	}
	if !allReady() {
		return fail(errors.New("capability_datachannel_timeout"))
	}
	routes := make(map[string]types.CapabilityTransportRoute, len(projection.Routes))
	for _, route := range projection.Routes {
		routes[route.AppInstanceID] = route
	}
	t.mu.Lock()
	if t.closed || transportCtx.Err() != nil {
		t.mu.Unlock()
		return fail(errors.New("capability_transport_closed"))
	}
	t.session, t.engine, t.outbound, t.routes, t.sources = session, engine, outbound, routes, sources
	t.mu.Unlock()
	if err := rest.SetAgentCapabilityReady(session, true); err != nil {
		return fail(err)
	}
	return nil
}

func (t *ParticipantCapabilityTransport) receive(label string, payload []byte) {
	if len(payload) == 0 || len(payload) > capabilityPayloadLimit {
		return
	}
	t.mu.Lock()
	if t.closed || t.sources[label] == "" || t.outbound == nil || !t.outbound.Ready() {
		t.mu.Unlock()
		return
	}
	sourceID := t.sources[label]
	var envelope roomAppEnvelope
	var frame capabilityFrame
	if err := json.Unmarshal(payload, &envelope); err != nil || envelope.ProtocolVersion != 1 || envelope.Lane != "reliable" || json.Unmarshal(envelope.Payload, &frame) != nil || frame.Type != capabilityRequestFrame || envelope.AppInstanceID != frame.AppInstanceID {
		t.mu.Unlock()
		return
	}
	route, ok := t.routes[frame.AppInstanceID]
	if !ok || frame.BundleRevision != route.BundleRevision || frame.TaskRequestID != route.TaskRequestID || frame.AgentID != route.AgentParticipantID || !containsString(route.CapabilityIDs, frame.CapabilityID) || frame.RequestID == "" || len(frame.RequestID) > 64 || strings.TrimSpace(frame.RequestID) != frame.RequestID {
		t.mu.Unlock()
		return
	}
	now := time.Now()
	for id, expiry := range t.seen {
		if expiry.Before(now) {
			delete(t.seen, id)
		}
	}
	if _, duplicate := t.seen[frame.RequestID]; duplicate {
		t.mu.Unlock()
		return
	}
	if len(t.seen) >= capabilitySeenLimit {
		t.mu.Unlock()
		return
	}
	if len(t.inflight) >= capabilityRequestLimit {
		t.mu.Unlock()
		return
	}
	select {
	case t.inflight <- struct{}{}:
	default:
		t.mu.Unlock()
		return
	}
	t.seen[frame.RequestID] = now.Add(30 * time.Second)
	out := t.outbound
	transportCtx := t.ctx
	t.mu.Unlock()
	if transportCtx == nil {
		<-t.inflight
		return
	}
	go t.execute(transportCtx, out, sourceID, route, frame)
}

func (t *ParticipantCapabilityTransport) execute(transportCtx context.Context, out reliableParticipantDataChannel, sourceID string, route types.CapabilityTransportRoute, frame capabilityFrame) {
	defer func() { <-t.inflight }()
	ctx, cancel := context.WithTimeout(transportCtx, 8*time.Second)
	defer cancel()
	request := types.ResidentCapabilityRequest{RequestID: frame.RequestID, RuntimeHostID: route.RuntimeHostID, CapabilityID: frame.CapabilityID, Operation: frame.Operation, Action: frame.Action, Args: frame.Args}
	result := capabilityFrame{Type: capabilityResultFrame, RequestID: frame.RequestID, AppInstanceID: route.AppInstanceID, BundleRevision: route.BundleRevision, TaskRequestID: route.TaskRequestID, AgentID: route.AgentParticipantID, CapabilityID: frame.CapabilityID, Operation: frame.Operation}
	if !request.Valid() {
		result.Error = "invalid_request"
	} else if t.handler == nil {
		result.Error = "unavailable"
	} else if value, err := t.handler.HandleCapabilityRequest(ctx, request); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			result.Error = "timeout"
		} else {
			result.Error = "unavailable"
		}
	} else {
		result.OK = true
		result.Result = value
		if !types.ResidentCapabilityResultPayloadValid(value) {
			result.OK = false
			result.Result = nil
			result.Error = "controller_error"
		}
	}
	payload, err := json.Marshal(result)
	if err != nil {
		return
	}
	wire, err := json.Marshal(roomAppEnvelope{ProtocolVersion: 1, AppInstanceID: route.AppInstanceID, Lane: "reliable", Payload: payload})
	if err != nil || len(wire) > capabilityPayloadLimit || !out.Ready() {
		return
	}
	if err := out.Send(wire); err != nil {
		t.log("runtime_capability_result_failed", map[string]string{"source": sourceID})
	}
}

func containsString(items []string, value string) bool {
	for _, item := range items {
		if item == value {
			return true
		}
	}
	return false
}

func (t *ParticipantCapabilityTransport) Close() {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return
	}
	t.closed = true
	session, engine := t.session, t.engine
	cancel := t.cancel
	t.cancel = nil
	t.ctx = nil
	t.session = ""
	t.engine = nil
	t.outbound = nil
	t.routes = nil
	t.sources = nil
	t.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if session != "" {
		_ = NewSfuRestClient(t.siteOrigin, t.handle).SetAgentCapabilityReady(session, false)
	}
	if engine != nil {
		engine.Close()
	}
}
