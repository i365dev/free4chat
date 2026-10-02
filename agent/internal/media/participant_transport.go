package media

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
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

func participantDirectReliableChannelName(agentParticipantID, humanParticipantID string) string {
	if !participantIDForDirectChannel(agentParticipantID) || !participantIDForDirectChannel(humanParticipantID) || agentParticipantID == humanParticipantID {
		return ""
	}
	return "participant-direct-reliable-" + strconv.Itoa(len(agentParticipantID)) + "-" + agentParticipantID + "-" + humanParticipantID
}

func participantIDForDirectChannel(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, char := range value {
		if (char < 'A' || char > 'Z') && (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '_' && char != '-' {
			return false
		}
	}
	return true
}

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

// RuntimeParticipantTransport owns a media-free Pion connection for the
// currently authorized participant-pair projection. Its first consumer is
// Generated App capability RPC. It has no queue: messages are admitted only
// while the exact peer channel and projected Task/App route are live.
type RuntimeParticipantTransport struct {
	siteOrigin string
	handle     DecodedHandle
	handler    types.ResidentCapabilityController
	log        func(string, map[string]string)

	mu          sync.Mutex
	closed      bool
	starting    bool
	generation  uint64
	ctx         context.Context
	cancel      context.CancelFunc
	session     string
	engine      *Engine
	outbound    map[string]reliableParticipantDataChannel // Human participant id -> private pair lane
	routes      map[string]types.RuntimeParticipantTransportRoute
	sources     map[string]string // local pairwise publisher label -> Human participant id
	inflight    chan struct{}
	seen        map[string]time.Time
	readyUpdate func(session string, ready bool) error
}

func NewRuntimeParticipantTransport(siteOrigin string, handle DecodedHandle, handler types.ResidentCapabilityController, log func(string, map[string]string)) *RuntimeParticipantTransport {
	if log == nil {
		log = func(string, map[string]string) {}
	}
	return &RuntimeParticipantTransport{siteOrigin: siteOrigin, handle: handle, handler: handler, log: log, inflight: make(chan struct{}, capabilityRequestLimit), seen: map[string]time.Time{}}
}

func (t *RuntimeParticipantTransport) Start(ctx context.Context, projection types.RuntimeParticipantTransportProjection) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if !projection.Valid() || len(projection.Routes) == 0 {
		return errors.New("participant_data_transport_unavailable")
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
	filteredRoutes := make([]types.RuntimeParticipantTransportRoute, 0, len(projection.Routes))
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
	if t.closed || t.starting || t.session != "" {
		closed := t.closed
		t.mu.Unlock()
		cancel()
		if closed {
			return errors.New("participant_data_transport_closed")
		}
		return errors.New("participant_data_transport_already_started")
	}
	t.generation++
	generation := t.generation
	t.starting = true
	t.ctx, t.cancel = transportCtx, cancel
	t.mu.Unlock()
	rest := NewSfuRestClient(t.siteOrigin, t.handle)
	session, err := rest.CreateAgentParticipantDataSession()
	if err != nil {
		cancel()
		t.finishStartFailure(generation, "", nil)
		return err
	}
	t.mu.Lock()
	if t.closed || t.generation != generation || transportCtx.Err() != nil {
		t.mu.Unlock()
		cancel()
		_ = t.updateParticipantDataReady(session, false)
		return errors.New("participant_data_transport_closed")
	}
	t.session = session
	t.mu.Unlock()
	events := EngineEvents{OnDataChannelMessage: func(label string, payload []byte) { t.receive(label, payload) }}
	engine := NewEngine(events, t.log)
	fail := func(err error) error {
		cancel()
		engine.Close()
		_ = t.updateParticipantDataReady(session, false)
		t.finishStartFailure(generation, session, engine)
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
	answer, err := rest.EstablishDataChannelTransport(session, *offer, PurposeParticipantReliable)
	if err != nil {
		return fail(err)
	}
	if err := completeParticipantDataTransportBootstrap(
		transportCtx,
		session,
		answer,
		engine.ApplyRemote,
		rest.Renegotiate,
		engine.WaitConnected,
	); err != nil {
		return fail(err)
	}

	channels := make([]map[string]any, 0, len(projection.Sources))
	channelHumans := make([]string, 0, len(projection.Sources))
	for _, source := range projection.Sources {
		name := participantDirectReliableChannelName(t.handle.ParticipantID, source.ParticipantID)
		if name == "" {
			return fail(errors.New("participant_direct_channel_invalid"))
		}
		channels = append(channels, map[string]any{
			"location": "local", "dataChannelName": name, "ordered": true,
			"peerParticipantId": source.ParticipantID,
		})
		channelHumans = append(channelHumans, source.ParticipantID)
	}
	ids, err := rest.CreateParticipantDataChannels(session, channels)
	if err != nil {
		return fail(err)
	}
	outbound := make(map[string]reliableParticipantDataChannel, len(projection.Sources))
	sources := make(map[string]string, len(projection.Sources))
	channelsReady := make([]*ParticipantDataChannel, 0, len(projection.Sources))
	for i, source := range projection.Sources {
		label := participantDirectReliableChannelName(t.handle.ParticipantID, source.ParticipantID)
		channel, err := engine.CreateParticipantDataChannel(label, ids[i])
		if err != nil {
			return fail(err)
		}
		channelsReady = append(channelsReady, channel)
		sources[label] = channelHumans[i]
		outbound[source.ParticipantID] = channel
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
	routes := make(map[string]types.RuntimeParticipantTransportRoute, len(projection.Routes))
	for _, route := range projection.Routes {
		routes[route.AppInstanceID] = route
	}
	t.mu.Lock()
	if t.closed || t.generation != generation || transportCtx.Err() != nil || t.session != session {
		t.mu.Unlock()
		return fail(errors.New("participant_data_transport_closed"))
	}
	t.session, t.engine, t.outbound, t.routes, t.sources = session, engine, outbound, routes, sources
	t.mu.Unlock()
	if err := t.publishReadyAndCheckCurrent(session, engine, generation); err != nil {
		return fail(err)
	}
	return nil
}

func (t *RuntimeParticipantTransport) updateParticipantDataReady(session string, ready bool) error {
	if t.readyUpdate != nil {
		return t.readyUpdate(session, ready)
	}
	return NewSfuRestClient(t.siteOrigin, t.handle).SetAgentParticipantDataReady(session, ready)
}

func (t *RuntimeParticipantTransport) publishReadyAndCheckCurrent(session string, engine *Engine, generation uint64) error {
	if err := t.updateParticipantDataReady(session, true); err != nil {
		return err
	}
	t.mu.Lock()
	current := !t.closed && t.generation == generation && t.session == session && t.engine == engine
	if current {
		t.starting = false
	}
	t.mu.Unlock()
	if current {
		return nil
	}
	// Close may have published ready=false while the true request was in
	// flight. Reassert false after the stale true completes; this exact-session
	// corrective update cannot affect a replacement transport.
	_ = t.updateParticipantDataReady(session, false)
	return errors.New("participant_data_transport_closed")
}

func (t *RuntimeParticipantTransport) finishStartFailure(generation uint64, session string, engine *Engine) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.generation != generation {
		return
	}
	t.ctx = nil
	t.cancel = nil
	if session != "" && t.session == session && (t.engine == nil || t.engine == engine) {
		t.session = ""
		t.engine = nil
		t.outbound = nil
		t.routes = nil
		t.sources = nil
	}
	t.starting = false
}

// completeParticipantDataTransportBootstrap follows the established Bridge
// signaling sequence for either SFU response shape. A remote offer requires a
// local answer to be renegotiated before the PeerConnection can become ready.
// Keeping the callbacks limited to these three protocol steps makes their
// ordering directly testable without adding a transport dependency framework.
func completeParticipantDataTransportBootstrap(
	ctx context.Context,
	session string,
	remote Description,
	applyRemote func(Description) (string, *Description, error),
	renegotiate func(string, Description, Purpose) error,
	waitConnected func(context.Context, time.Duration) error,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if remote.Type == "offer" {
		applied, answer, err := applyRemote(remote)
		if err != nil {
			return err
		}
		if applied != "offer" || answer == nil {
			return errors.New("missing local answer after participant data remote offer")
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := renegotiate(session, *answer, PurposeParticipantReliable); err != nil {
			return err
		}
	} else {
		if _, _, err := applyRemote(remote); err != nil {
			return err
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return waitConnected(ctx, 30*time.Second)
}

func (t *RuntimeParticipantTransport) receive(label string, payload []byte) {
	if len(payload) == 0 || len(payload) > capabilityPayloadLimit {
		return
	}
	t.mu.Lock()
	humanParticipantID := t.sources[label]
	out := t.outbound[humanParticipantID]
	if t.closed || humanParticipantID == "" || out == nil || !out.Ready() {
		t.mu.Unlock()
		return
	}
	var envelope roomAppEnvelope
	var frame capabilityFrame
	if err := json.Unmarshal(payload, &envelope); err != nil || envelope.ProtocolVersion != 1 || envelope.Lane != "reliable" || json.Unmarshal(envelope.Payload, &frame) != nil || frame.Type != capabilityRequestFrame || envelope.AppInstanceID != frame.AppInstanceID {
		t.mu.Unlock()
		return
	}
	route, ok := t.routes[frame.AppInstanceID]
	if !ok || route.HumanParticipantID != humanParticipantID || frame.BundleRevision != route.BundleRevision || frame.TaskRequestID != route.TaskRequestID || frame.AgentID != route.AgentParticipantID || !containsString(route.CapabilityIDs, frame.CapabilityID) || frame.RequestID == "" || len(frame.RequestID) > 64 || strings.TrimSpace(frame.RequestID) != frame.RequestID {
		t.mu.Unlock()
		return
	}
	request := types.ResidentCapabilityRequest{RequestID: frame.RequestID, RuntimeHostID: route.RuntimeHostID, CapabilityID: frame.CapabilityID, Operation: frame.Operation, Action: frame.Action, Args: frame.Args}
	if !t.capabilityRequestAllowed(route, request) {
		t.mu.Unlock()
		t.sendResult(out, route, frame, "unauthorized", nil)
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
	transportCtx := t.ctx
	t.mu.Unlock()
	if transportCtx == nil {
		<-t.inflight
		return
	}
	go t.execute(transportCtx, out, route, frame)
}

func (t *RuntimeParticipantTransport) execute(transportCtx context.Context, out reliableParticipantDataChannel, route types.RuntimeParticipantTransportRoute, frame capabilityFrame) {
	defer func() { <-t.inflight }()
	ctx, cancel := context.WithTimeout(transportCtx, 8*time.Second)
	defer cancel()
	request := types.ResidentCapabilityRequest{RequestID: frame.RequestID, RuntimeHostID: route.RuntimeHostID, CapabilityID: frame.CapabilityID, Operation: frame.Operation, Action: frame.Action, Args: frame.Args}
	failure := ""
	var value map[string]any
	if !request.Valid() || !t.capabilityRequestAllowed(route, request) {
		failure = "unauthorized"
	} else if t.handler == nil {
		failure = "unavailable"
	} else if handled, err := t.handler.HandleCapabilityRequest(ctx, request); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			failure = "timeout"
		} else {
			failure = "unavailable"
		}
	} else {
		value = handled
		if !types.ResidentCapabilityResultPayloadValid(handled) {
			value = nil
			failure = "controller_error"
		}
	}
	t.sendResult(out, route, frame, failure, value)
}

func (t *RuntimeParticipantTransport) capabilityRequestAllowed(route types.RuntimeParticipantTransportRoute, request types.ResidentCapabilityRequest) bool {
	if !containsString(route.CapabilityIDs, request.CapabilityID) || t.handler == nil {
		return false
	}
	for _, descriptor := range t.handler.DescribeCapabilities() {
		if descriptor.CapabilityID == request.CapabilityID && descriptor.AllowsRequest(request) {
			return true
		}
	}
	return false
}

func (t *RuntimeParticipantTransport) sendResult(out reliableParticipantDataChannel, route types.RuntimeParticipantTransportRoute, request capabilityFrame, failure string, value map[string]any) {
	if out == nil {
		return
	}
	result := capabilityFrame{Type: capabilityResultFrame, RequestID: request.RequestID, AppInstanceID: route.AppInstanceID, BundleRevision: route.BundleRevision, TaskRequestID: route.TaskRequestID, AgentID: route.AgentParticipantID, CapabilityID: request.CapabilityID, Operation: request.Operation, Result: value}
	if failure != "" {
		result.Error = failure
	} else {
		result.OK = true
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
		t.log("runtime_participant_result_failed", map[string]string{"source": request.AgentID})
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

func (t *RuntimeParticipantTransport) Close() {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return
	}
	t.closed = true
	t.generation++
	t.starting = false
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
		_ = t.updateParticipantDataReady(session, false)
	}
	if engine != nil {
		engine.Close()
	}
}
