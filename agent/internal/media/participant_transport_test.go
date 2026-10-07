package media

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
	"github.com/pion/webrtc/v4"
)

type capabilityTestChannel struct {
	payloads chan []byte
	id       uint16
	closed   bool
}

func (c *capabilityTestChannel) Ready() bool  { return !c.closed }
func (c *capabilityTestChannel) ID() uint16   { return c.id }
func (c *capabilityTestChannel) Close() error { c.closed = true; return nil }
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

func writeParticipantDataChannelCloseResult(t *testing.T, w http.ResponseWriter, ids []uint16) {
	t.Helper()
	results := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		results = append(results, map[string]any{"id": id})
	}
	if err := json.NewEncoder(w).Encode(map[string]any{"dataChannels": results}); err != nil {
		t.Errorf("encode DataChannel close result: %v", err)
	}
}

func TestParticipantDataTransportRetiresRotatedHumanLaneAndFencesOldChannel(t *testing.T) {
	appID := "generated:123e4567-e89b-12d3-a456-426614174000"
	route := func(humanID string) types.RuntimeParticipantTransportRoute {
		return types.RuntimeParticipantTransportRoute{
			AppInstanceID: appID, BundleRevision: 1, TaskRequestID: "task-a",
			AgentParticipantID: "agent-a", HumanParticipantID: humanID,
			RuntimeHostID: "host-route-1", CapabilityIDs: []string{"printer_status"},
		}
	}
	handler := &capabilityTestHandler{calls: make(chan types.ResidentCapabilityRequest, 8), descriptors: []types.RuntimeCapabilityProjection{validCapabilityTestDescriptor("printer_status", true)}}
	transport := NewRuntimeParticipantTransport("https://example.invalid", DecodedHandle{ParticipantID: "agent-a"}, handler, nil)
	transport.ctx = context.Background()
	humanA := &capabilityTestChannel{payloads: make(chan []byte, 8), id: 42}
	humanB1 := &capabilityTestChannel{payloads: make(chan []byte, 8), id: 43}
	labelA := participantDirectReliableChannelName("agent-a", "human-a")
	labelB := participantDirectReliableChannelName("agent-a", "human-b")
	transport.outbound = map[string]reliableParticipantDataChannel{"human-a": humanA, "human-b": humanB1}
	transport.sources = map[string]string{labelA: "human-a", labelB: "human-b"}
	transport.peerSessions = map[string]string{"human-a": "session-a", "human-b": "session-b-1"}
	transport.channelTokens = map[string]any{"human-a": humanA, "human-b": humanB1}
	transport.channelAllocations = map[string]uint16{"human-a": 42, "human-b": 43}
	transport.routes = map[participantRouteKey]types.RuntimeParticipantTransportRoute{
		{appInstanceID: appID, humanParticipantID: "human-a"}: route("human-a"),
		{appInstanceID: appID, humanParticipantID: "human-b"}: route("human-b"),
	}

	desiredSources := map[string]string{"human-a": "session-a", "human-b": "session-b-2"}
	desiredRoutes := map[participantRouteKey]types.RuntimeParticipantTransportRoute{
		{appInstanceID: appID, humanParticipantID: "human-a"}: route("human-a"),
		{appInstanceID: appID, humanParticipantID: "human-b"}: route("human-b"),
	}
	for _, lane := range transport.deauthorizeParticipantProjection(desiredSources, desiredRoutes) {
		retireParticipantDataChannel(lane.channel)
	}
	if !humanB1.closed || humanA.closed {
		t.Fatalf("rotation close state: old B closed=%v, unchanged A closed=%v", humanB1.closed, humanA.closed)
	}
	if len(transport.outbound) != 1 || transport.outbound["human-a"] != humanA {
		t.Fatalf("rotated B lane was not removed while A remained: %+v", transport.outbound)
	}

	makeRequest := func(requestID string) []byte {
		t.Helper()
		frame, err := json.Marshal(capabilityFrame{
			Type: capabilityRequestFrame, RequestID: requestID, AppInstanceID: appID,
			BundleRevision: 1, TaskRequestID: "task-a", AgentID: "agent-a",
			CapabilityID: "printer_status", Operation: types.ResidentCapabilityObserve,
		})
		if err != nil {
			t.Fatal(err)
		}
		wire, err := json.Marshal(roomAppEnvelope{ProtocolVersion: 1, Lane: "reliable", AppInstanceID: appID, Payload: frame})
		if err != nil {
			t.Fatal(err)
		}
		return wire
	}
	transport.receive(labelB, humanB1, makeRequest("old-b"))
	transport.receive(labelA, humanA, makeRequest("human-a"))
	select {
	case got := <-handler.calls:
		if got.RequestID != "human-a" {
			t.Fatalf("old B channel was admitted after rotation: %+v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("unchanged Human A lane stopped working during B rotation")
	}

	registerHuman := func(sessionID string, channel *capabilityTestChannel) {
		transport.mu.Lock()
		transport.outbound["human-b"] = channel
		transport.peerSessions["human-b"] = sessionID
		transport.channelTokens["human-b"] = channel
		transport.sources[labelB] = "human-b"
		transport.routes[participantRouteKey{appInstanceID: appID, humanParticipantID: "human-b"}] = route("human-b")
		transport.mu.Unlock()
	}
	current := &capabilityTestChannel{payloads: make(chan []byte, 8), id: 44}
	registerHuman("session-b-2", current)
	transport.receive(labelB, humanB1, makeRequest("old-b-after-replacement"))
	transport.receive(labelB, current, makeRequest("new-b"))
	select {
	case got := <-handler.calls:
		if got.RequestID != "new-b" {
			t.Fatalf("unexpected request after B replacement: %+v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("replacement Human B channel was not admitted")
	}

	for rotation := 3; rotation < 8; rotation++ {
		sessionID := "session-b-" + strconv.Itoa(rotation)
		desiredSources["human-b"] = sessionID
		retired := transport.deauthorizeParticipantProjection(desiredSources, desiredRoutes)
		if len(retired) == 1 {
			retireParticipantDataChannel(retired[0].channel)
		}
		if len(retired) != 1 || retired[0].channel != current || !current.closed {
			t.Fatalf("rotation %d failed to retire exactly the old B lane: retired=%d closed=%v", rotation, len(retired), current.closed)
		}
		current = &capabilityTestChannel{payloads: make(chan []byte, 8), id: uint16(44 + rotation)}
		registerHuman(sessionID, current)
		if len(transport.outbound) != 2 || transport.outbound["human-a"] != humanA {
			t.Fatalf("rotation %d accumulated lanes or disrupted A: %+v", rotation, transport.outbound)
		}
	}
}

func TestParticipantDataTransportPartialUpdateClosesAllocatedChannels(t *testing.T) {
	var closedIDs []uint16
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/sfu/datachannels/new":
			_, _ = io.WriteString(w, `{"dataChannels":[{"id":42},{"id":42}]}`)
		case "/api/sfu/datachannels/close":
			var body struct {
				DataChannels []struct {
					ID uint16 `json:"id"`
				} `json:"dataChannels"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode channel cleanup request: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			for _, channel := range body.DataChannels {
				closedIDs = append(closedIDs, channel.ID)
			}
			writeParticipantDataChannelCloseResult(t, w, closedIDs)
		default:
			t.Errorf("unexpected cleanup request path %q", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	engine := NewEngine(EngineEvents{}, nil)
	if err := engine.Create(); err != nil {
		t.Skipf("Pion unavailable: %v", err)
	}
	defer engine.Close()
	transport := NewRuntimeParticipantTransport(server.URL, DecodedHandle{
		Room: "room-a", ParticipantID: "agent-a", ParticipantToken: "token-a",
	}, &capabilityTestHandler{descriptors: []types.RuntimeCapabilityProjection{validCapabilityTestDescriptor("printer_status", true)}}, nil)
	transport.session = "agent-session"
	transport.engine = engine
	transport.ctx = context.Background()

	projection := types.RuntimeParticipantTransportProjection{
		Routes: []types.RuntimeParticipantTransportRoute{{
			AppInstanceID: "generated:123e4567-e89b-12d3-a456-426614174000", BundleRevision: 1,
			TaskRequestID: "task-a", AgentParticipantID: "agent-a", HumanParticipantID: "human-a",
			RuntimeHostID: "11111111-2222-3333-4444-555555555555", CapabilityIDs: []string{"printer_status"},
		}},
		Sources: []types.RuntimeParticipantTransportSource{{ParticipantID: "human-a", SessionID: "session-a"}},
	}
	projection.Routes = append(projection.Routes, types.RuntimeParticipantTransportRoute{
		AppInstanceID: projection.Routes[0].AppInstanceID, BundleRevision: 1,
		TaskRequestID: projection.Routes[0].TaskRequestID, AgentParticipantID: "agent-a",
		HumanParticipantID: "human-b", RuntimeHostID: projection.Routes[0].RuntimeHostID,
		CapabilityIDs: []string{"printer_status"},
	})
	projection.Sources = append(projection.Sources, types.RuntimeParticipantTransportSource{ParticipantID: "human-b", SessionID: "session-b"})

	if err := transport.Update(context.Background(), projection); err == nil {
		t.Fatal("duplicate negotiated channel id unexpectedly committed an update")
	}
	if len(closedIDs) != 1 || closedIDs[0] != 42 {
		t.Fatalf("partial update did not close all allocated SFU channels: %v", closedIDs)
	}
	if len(transport.routes) != 0 || len(transport.sources) != 0 || len(transport.outbound) != 0 {
		t.Fatalf("failed partial update left authorized state: routes=%d sources=%d lanes=%d", len(transport.routes), len(transport.sources), len(transport.outbound))
	}
}

func TestCloseParticipantDataChannelsRequiresResolvedPerIDResult(t *testing.T) {
	tests := []struct {
		name    string
		result  string
		wantErr bool
	}{
		{name: "closed", result: `{"dataChannels":[{"id":7}]}`},
		{name: "already absent", result: `{"dataChannels":[{"id":7,"errorCode":"close_track_error"}]}`},
		{name: "provider failure", result: `{"dataChannels":[{"id":7,"errorCode":"internal_error"}]}`, wantErr: true},
		{name: "unreported", result: `{"dataChannels":[]}`, wantErr: true},
		{name: "missing result array", result: `{}`, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, test.result)
			}))
			defer server.Close()
			client := NewSfuRestClient(server.URL, DecodedHandle{Room: "room", ParticipantID: "agent-a", ParticipantToken: "token"})
			err := client.CloseParticipantDataChannels("agent-session", []uint16{7})
			if (err != nil) != test.wantErr {
				t.Fatalf("close result error = %v, wantErr=%v", err, test.wantErr)
			}
		})
	}
}

func TestCloseParticipantDataChannelsUsesEndpointSessionAndAllocationIDsOnly(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/api/sfu/datachannels/close" {
			t.Errorf("close request = %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		var body struct {
			SessionID    string                       `json:"sessionId"`
			Purpose      string                       `json:"purpose"`
			DataChannels []map[string]json.RawMessage `json:"dataChannels"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode close request: %v", err)
			http.Error(w, "invalid JSON", http.StatusBadRequest)
			return
		}
		if body.SessionID != "agent-data-session" {
			t.Errorf("top-level sessionId = %q, want Agent participant-data endpoint", body.SessionID)
		}
		if body.Purpose != string(PurposeParticipantReliable) {
			t.Errorf("purpose = %q, want %q", body.Purpose, PurposeParticipantReliable)
		}
		if len(body.DataChannels) != 2 {
			t.Errorf("close allocations = %d, want 2", len(body.DataChannels))
		}
		gotIDs := make([]uint16, 0, len(body.DataChannels))
		for _, channel := range body.DataChannels {
			if len(channel) != 1 {
				t.Errorf("close item = %v, want only id", channel)
			}
			var id uint16
			if err := json.Unmarshal(channel["id"], &id); err != nil {
				t.Errorf("decode allocation id: %v", err)
				continue
			}
			gotIDs = append(gotIDs, id)
		}
		if !reflect.DeepEqual(gotIDs, []uint16{7, 8}) {
			t.Errorf("allocation ids = %v, want [7 8]", gotIDs)
		}
		writeParticipantDataChannelCloseResult(t, w, gotIDs)
	}))
	defer server.Close()

	client := NewSfuRestClient(server.URL, DecodedHandle{
		Room: "room", ParticipantID: "agent", ParticipantToken: "token",
	})
	if err := client.CloseParticipantDataChannels("agent-data-session", []uint16{7, 8}); err != nil {
		t.Fatalf("CloseParticipantDataChannels() error = %v", err)
	}
}

func TestCreateParticipantDataChannelsPreservesPartialResultsAndSanitizesErrors(t *testing.T) {
	tests := []struct {
		name      string
		status    int
		body      string
		wantIDs   []uint16
		wantClass string
		wantErr   bool
	}{
		{
			name:    "partial item failure",
			body:    `{"dataChannels":[{"id":42},{"errorCode":"repeated_local_track_error","errorDescription":"private description"}]}`,
			wantIDs: []uint16{42}, wantClass: "repeated_local_track_error", wantErr: true,
		},
		{
			name:      "request level session error",
			status:    http.StatusConflict,
			body:      `{"error":"private request detail","errorCode":"session_error","errorDescription":"private description"}`,
			wantClass: "session_error", wantErr: true,
		},
		{
			name:    "malformed and unreported item",
			body:    `{"dataChannels":[{"id":43},{}]}`,
			wantIDs: []uint16{43}, wantClass: "unknown", wantErr: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if test.status != 0 {
					w.WriteHeader(test.status)
				}
				_, _ = io.WriteString(w, test.body)
			}))
			defer server.Close()
			client := NewSfuRestClient(server.URL, DecodedHandle{ParticipantID: "agent-a"})
			ids, err := client.CreateParticipantDataChannels("session", []map[string]any{{}, {}})
			if !reflect.DeepEqual(ids, test.wantIDs) {
				t.Fatalf("allocation ids = %v, want %v", ids, test.wantIDs)
			}
			if (err != nil) != test.wantErr {
				t.Fatalf("allocation error = %v, wantErr=%v", err, test.wantErr)
			}
			if err != nil {
				var providerError *SfuProviderError
				if !errors.As(err, &providerError) || providerError.Class != test.wantClass {
					t.Fatalf("provider error = %#v, want sanitized class %q", err, test.wantClass)
				}
				if strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "description") {
					t.Fatalf("provider details leaked through error: %q", err)
				}
			}
		})
	}
}

func TestParticipantDataTransportFailureStagesAndPartialAllocationOwnership(t *testing.T) {
	appID := "generated:123e4567-e89b-12d3-a456-426614174000"
	projection := func(session string) types.RuntimeParticipantTransportProjection {
		return types.RuntimeParticipantTransportProjection{
			Routes: []types.RuntimeParticipantTransportRoute{{
				AppInstanceID: appID, BundleRevision: 1, TaskRequestID: "task",
				AgentParticipantID: "agent-a", HumanParticipantID: "human-a",
				RuntimeHostID: "11111111-2222-3333-4444-555555555555", CapabilityIDs: []string{"printer_status"},
			}},
			Sources: []types.RuntimeParticipantTransportSource{{ParticipantID: "human-a", SessionID: session}},
		}
	}
	handler := &capabilityTestHandler{descriptors: []types.RuntimeCapabilityProjection{validCapabilityTestDescriptor("printer_status", true)}}

	for _, closeResult := range []struct {
		name      string
		body      string
		wantError bool
		wantClass string
	}{
		{name: "closed", body: `{"dataChannels":[{"id":7}]}`},
		{name: "already closed", body: `{"dataChannels":[{"id":7,"errorCode":"close_track_error"}]}`},
		{name: "unresolved close", body: `{"dataChannels":[{"id":7,"errorCode":"internal_error"}]}`, wantError: true, wantClass: "internal_error"},
		{name: "unreported close", body: `{"dataChannels":[]}`, wantError: true, wantClass: "unknown"},
	} {
		t.Run("cleanup_"+closeResult.name, func(t *testing.T) {
			var operations []string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/api/sfu/datachannels/close":
					operations = append(operations, "close")
					_, _ = io.WriteString(w, closeResult.body)
				case "/api/sfu/datachannels/new":
					operations = append(operations, "new")
					_, _ = io.WriteString(w, `{"dataChannels":[{"id":8}]}`)
				default:
					t.Errorf("unexpected request path %q", r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			transport := NewRuntimeParticipantTransport(server.URL, DecodedHandle{ParticipantID: "agent-a"}, handler, nil)
			transport.session, transport.ctx = "agent-session", context.Background()
			transport.engine = NewEngine(EngineEvents{}, nil)
			transport.waitChannelsReady = func(context.Context, context.Context, []reliableParticipantDataChannel, time.Duration) error {
				return nil
			}
			transport.createParticipantChannel = func(_ string, id uint16) (reliableParticipantDataChannel, error) {
				return &capabilityTestChannel{payloads: make(chan []byte, 1), id: id}, nil
			}
			old := &capabilityTestChannel{payloads: make(chan []byte, 1), id: 7}
			transport.outbound = map[string]reliableParticipantDataChannel{"human-a": old}
			transport.peerSessions = map[string]string{"human-a": "H1"}
			transport.channelAllocations = map[string]uint16{"human-a": 7}
			label := participantDirectReliableChannelName("agent-a", "human-a")
			transport.sources = map[string]string{label: "human-a"}
			key := participantRouteKey{appInstanceID: appID, humanParticipantID: "human-a"}
			transport.routes = map[participantRouteKey]types.RuntimeParticipantTransportRoute{key: projection("H1").Routes[0]}

			err := transport.Update(context.Background(), projection("H2"))
			var failure *ParticipantTransportFailure
			if closeResult.wantError {
				if !errors.As(err, &failure) || failure.Stage != ParticipantTransportFailureStageCleanupRetiredAllocation || failure.ProviderErrorClass != closeResult.wantClass {
					t.Fatalf("cleanup failure = %#v, want cleanup stage/provider class %q", err, closeResult.wantClass)
				}
				if !reflect.DeepEqual(operations, []string{"close"}) || !reflect.DeepEqual(transport.pendingCloseIDs, []uint16{7}) {
					t.Fatalf("unresolved cleanup started replacement or lost ownership: operations=%v pending=%v", operations, transport.pendingCloseIDs)
				}
				return
			}
			if err != nil {
				t.Fatalf("replacement after satisfied cleanup failed: %v", err)
			}
			if !reflect.DeepEqual(operations, []string{"close", "new"}) {
				t.Fatalf("operations = %v, want close before new", operations)
			}
		})
	}

	t.Run("partial replacement remains owned after cleanup failure", func(t *testing.T) {
		closeCalls := 0
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			switch r.URL.Path {
			case "/api/sfu/datachannels/new":
				_, _ = io.WriteString(w, `{"dataChannels":[{"id":42},{"errorCode":"repeated_local_track_error","errorDescription":"private"}]}`)
			case "/api/sfu/datachannels/close":
				closeCalls++
				_, _ = io.WriteString(w, `{"dataChannels":[{"id":42,"errorCode":"internal_error"}]}`)
			default:
				t.Errorf("unexpected request path %q", r.URL.Path)
				http.NotFound(w, r)
			}
		}))
		defer server.Close()
		transport := NewRuntimeParticipantTransport(server.URL, DecodedHandle{ParticipantID: "agent-a"}, handler, nil)
		transport.session, transport.ctx = "agent-session", context.Background()
		transport.engine = NewEngine(EngineEvents{}, nil)
		want := projection("H2")
		want.Routes = append(want.Routes, want.Routes[0])
		want.Routes[1].HumanParticipantID = "human-b"
		want.Sources = append(want.Sources, types.RuntimeParticipantTransportSource{ParticipantID: "human-b", SessionID: "H2b"})
		err := transport.Update(context.Background(), want)
		var failure *ParticipantTransportFailure
		if !errors.As(err, &failure) || failure.Stage != ParticipantTransportFailureStageAllocateReplacement || failure.ProviderErrorClass != "repeated_local_track_error" {
			t.Fatalf("replacement failure = %#v, want allocation stage/repeated_local_track_error", err)
		}
		if closeCalls != 1 || !reflect.DeepEqual(transport.pendingCloseIDs, []uint16{42}) {
			t.Fatalf("partial allocation ownership lost: closeCalls=%d pending=%v", closeCalls, transport.pendingCloseIDs)
		}
	})
}

func TestParticipantDataTransportSessionRotationClosesCommittedAllocation(t *testing.T) {
	type operation struct {
		kind string
		id   uint16
	}
	var operations []operation
	nextAllocationID := uint16(42)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/sfu/datachannels/new":
			var body struct {
				DataChannels []map[string]any `json:"dataChannels"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.DataChannels) != 1 {
				t.Errorf("decode DataChannel allocation: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			id := nextAllocationID
			nextAllocationID++
			operations = append(operations, operation{kind: "new", id: id})
			_, _ = io.WriteString(w, `{"dataChannels":[{"id":`+strconv.Itoa(int(id))+`}]}`)
		case "/api/sfu/datachannels/close":
			var body struct {
				DataChannels []struct {
					ID uint16 `json:"id"`
				} `json:"dataChannels"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode DataChannel close: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			for _, channel := range body.DataChannels {
				operations = append(operations, operation{kind: "close", id: channel.ID})
			}
			ids := make([]uint16, 0, len(body.DataChannels))
			for _, channel := range body.DataChannels {
				ids = append(ids, channel.ID)
			}
			writeParticipantDataChannelCloseResult(t, w, ids)
		default:
			t.Errorf("unexpected participant transport request %q", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	engine := NewEngine(EngineEvents{}, nil)
	if err := engine.Create(); err != nil {
		t.Skipf("Pion unavailable: %v", err)
	}
	defer engine.Close()
	transport := NewRuntimeParticipantTransport(server.URL, DecodedHandle{ParticipantID: "agent-a"},
		&capabilityTestHandler{descriptors: []types.RuntimeCapabilityProjection{validCapabilityTestDescriptor("printer_status", true)}}, nil)
	transport.session = "agent-session"
	transport.engine = engine
	transport.ctx = context.Background()
	transport.waitChannelsReady = func(context.Context, context.Context, []reliableParticipantDataChannel, time.Duration) error {
		return nil
	}
	transport.createParticipantChannel = func(_ string, id uint16) (reliableParticipantDataChannel, error) {
		return &capabilityTestChannel{payloads: make(chan []byte, 1), id: id}, nil
	}
	appID := "generated:123e4567-e89b-12d3-a456-426614174000"
	projection := func(sessionID string) types.RuntimeParticipantTransportProjection {
		return types.RuntimeParticipantTransportProjection{
			Routes: []types.RuntimeParticipantTransportRoute{{
				AppInstanceID: appID, BundleRevision: 1, TaskRequestID: "task-a",
				AgentParticipantID: "agent-a", HumanParticipantID: "human-a",
				RuntimeHostID: "11111111-2222-3333-4444-555555555555", CapabilityIDs: []string{"printer_status"},
			}},
			Sources: []types.RuntimeParticipantTransportSource{{ParticipantID: "human-a", SessionID: sessionID}},
		}
	}

	if err := transport.Update(context.Background(), projection("human-session-H1")); err != nil {
		t.Fatalf("commit H1 lane: %v", err)
	}
	oldLane := transport.outbound["human-a"].(*capabilityTestChannel)
	if !oldLane.Ready() || oldLane.ID() != 42 {
		t.Fatalf("H1 lane was not ready on expected committed id: ready=%v id=%d", oldLane.Ready(), oldLane.ID())
	}
	if err := transport.Update(context.Background(), projection("human-session-H2")); err != nil {
		t.Fatalf("replace H1 with H2: %v", err)
	}
	if !oldLane.closed {
		t.Fatal("H1 local Pion DataChannel was not retired before H2 became current")
	}
	want := []operation{{kind: "new", id: 42}, {kind: "close", id: 42}, {kind: "new", id: 43}}
	if !reflect.DeepEqual(operations, want) {
		t.Fatalf("SFU lifecycle operations = %v, want close committed H1 id X before allocating H2: %v", operations, want)
	}
	newLane := transport.outbound["human-a"].(*capabilityTestChannel)
	if got := newLane.ID(); got != 43 || !newLane.Ready() {
		t.Fatalf("H2 lane = id %d ready %v, want committed replacement Y ready", got, newLane.Ready())
	}
}

func TestParticipantDataTransportRepeatedRotationRemovalAndRouteOnlyUpdate(t *testing.T) {
	type operation struct {
		kind string
		id   uint16
	}
	var operations []operation
	active := map[uint16]bool{}
	nextID := uint16(42)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/sfu/datachannels/new":
			var body struct {
				DataChannels []map[string]any `json:"dataChannels"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode DataChannel allocation: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			channels := make([]map[string]any, 0, len(body.DataChannels))
			for range body.DataChannels {
				id := nextID
				nextID++
				active[id] = true
				operations = append(operations, operation{kind: "new", id: id})
				channels = append(channels, map[string]any{"id": id})
			}
			payload, _ := json.Marshal(map[string]any{"dataChannels": channels})
			_, _ = w.Write(payload)
		case "/api/sfu/datachannels/close":
			var body struct {
				DataChannels []struct {
					ID uint16 `json:"id"`
				} `json:"dataChannels"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode DataChannel close: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			for _, channel := range body.DataChannels {
				if !active[channel.ID] {
					t.Errorf("Runtime closed unknown or already retired allocation %d", channel.ID)
				}
				delete(active, channel.ID)
				operations = append(operations, operation{kind: "close", id: channel.ID})
			}
			ids := make([]uint16, 0, len(body.DataChannels))
			for _, channel := range body.DataChannels {
				ids = append(ids, channel.ID)
			}
			writeParticipantDataChannelCloseResult(t, w, ids)
		default:
			t.Errorf("unexpected participant transport request %q", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	engine := NewEngine(EngineEvents{}, nil)
	if err := engine.Create(); err != nil {
		t.Skipf("Pion unavailable: %v", err)
	}
	defer engine.Close()
	transport := NewRuntimeParticipantTransport(server.URL, DecodedHandle{ParticipantID: "agent-a"},
		&capabilityTestHandler{descriptors: []types.RuntimeCapabilityProjection{validCapabilityTestDescriptor("printer_status", true)}}, nil)
	transport.session = "agent-session"
	transport.engine = engine
	transport.ctx = context.Background()
	transport.waitChannelsReady = func(context.Context, context.Context, []reliableParticipantDataChannel, time.Duration) error {
		return nil
	}
	transport.createParticipantChannel = func(_ string, id uint16) (reliableParticipantDataChannel, error) {
		return &capabilityTestChannel{payloads: make(chan []byte, 1), id: id}, nil
	}
	appID := "generated:123e4567-e89b-12d3-a456-426614174000"
	makeProjection := func(aSession, bSession string, revision int64, includeA bool) types.RuntimeParticipantTransportProjection {
		routes := make([]types.RuntimeParticipantTransportRoute, 0, 2)
		sources := make([]types.RuntimeParticipantTransportSource, 0, 2)
		addHuman := func(human, session string) {
			routes = append(routes, types.RuntimeParticipantTransportRoute{
				AppInstanceID: appID, BundleRevision: revision, TaskRequestID: "task-a",
				AgentParticipantID: "agent-a", HumanParticipantID: human,
				RuntimeHostID: "11111111-2222-3333-4444-555555555555", CapabilityIDs: []string{"printer_status"},
			})
			sources = append(sources, types.RuntimeParticipantTransportSource{ParticipantID: human, SessionID: session})
		}
		if includeA {
			addHuman("human-a", aSession)
		}
		addHuman("human-b", bSession)
		return types.RuntimeParticipantTransportProjection{Routes: routes, Sources: sources}
	}
	update := func(projection types.RuntimeParticipantTransportProjection) {
		t.Helper()
		if err := transport.Update(context.Background(), projection); err != nil {
			t.Fatalf("participant transport update failed: %v", err)
		}
	}

	update(makeProjection("H1", "HB", 1, true))
	var priorA *capabilityTestChannel
	for _, nextSession := range []string{"H2", "H3", "H4"} {
		priorA = transport.outbound["human-a"].(*capabilityTestChannel)
		update(makeProjection(nextSession, "HB", 1, true))
		if !priorA.closed {
			t.Fatalf("Human A lane was not locally retired for session %s", nextSession)
		}
	}
	beforeRouteOnly := append([]operation(nil), operations...)
	update(makeProjection("H4", "HB", 2, true))
	if !reflect.DeepEqual(operations, beforeRouteOnly) {
		t.Fatalf("route-only revision churned healthy DataChannels: before=%v after=%v", beforeRouteOnly, operations)
	}
	finalALane := transport.outbound["human-a"].(*capabilityTestChannel)
	update(makeProjection("", "HB", 2, false))
	if !finalALane.closed {
		t.Fatal("removed Human route did not retire its local lane")
	}
	if len(transport.outbound) != 1 || transport.outbound["human-b"] == nil || transport.outbound["human-a"] != nil {
		t.Fatalf("Human removal retained or disrupted the wrong lane: %v", transport.outbound)
	}
	want := []operation{
		{kind: "new", id: 42}, {kind: "new", id: 43},
		{kind: "close", id: 42}, {kind: "new", id: 44},
		{kind: "close", id: 44}, {kind: "new", id: 45},
		{kind: "close", id: 45}, {kind: "new", id: 46},
		{kind: "close", id: 46},
	}
	if !reflect.DeepEqual(operations, want) {
		t.Fatalf("rotation/removal SFU operations = %v, want %v", operations, want)
	}
	if len(active) != 1 || !active[43] {
		t.Fatalf("stale SFU allocations accumulated after rotation/removal: %v", active)
	}
}

func TestParticipantDataTransportUnrelatedCleanupFailureDoesNotBlockHealthyRouteOnlyUpdate(t *testing.T) {
	type operation struct {
		kind  string
		human string
	}
	var operations []operation
	allocationOwner := make(map[uint16]string)
	nextID := uint16(41)
	cleanupBFails := true
	blockNextBCleanup := make(chan struct{}, 1)
	bCleanupEntered := make(chan struct{}, 1)
	releaseBCleanup := make(chan struct{})
	handler := &capabilityTestHandler{
		calls:       make(chan types.ResidentCapabilityRequest, 4),
		descriptors: []types.RuntimeCapabilityProjection{validCapabilityTestDescriptor("printer_status", true)},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/sfu/datachannels/new":
			var body struct {
				DataChannels []struct {
					PeerParticipantID string `json:"peerParticipantId"`
				} `json:"dataChannels"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode DataChannel allocation: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			results := make([]map[string]any, 0, len(body.DataChannels))
			for _, channel := range body.DataChannels {
				id := nextID
				nextID++
				allocationOwner[id] = channel.PeerParticipantID
				operations = append(operations, operation{kind: "new", human: channel.PeerParticipantID})
				results = append(results, map[string]any{"id": id})
			}
			if err := json.NewEncoder(w).Encode(map[string]any{"dataChannels": results}); err != nil {
				t.Errorf("encode DataChannel allocation: %v", err)
			}
		case "/api/sfu/datachannels/close":
			var body struct {
				DataChannels []struct {
					ID uint16 `json:"id"`
				} `json:"dataChannels"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode DataChannel cleanup: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			results := make([]map[string]any, 0, len(body.DataChannels))
			for _, channel := range body.DataChannels {
				human := allocationOwner[channel.ID]
				operations = append(operations, operation{kind: "close", human: human})
				result := map[string]any{"id": channel.ID}
				if human == "human-b" && cleanupBFails {
					select {
					case <-blockNextBCleanup:
						bCleanupEntered <- struct{}{}
						<-releaseBCleanup
					default:
					}
					result["errorCode"] = "internal_error"
				}
				results = append(results, result)
			}
			if err := json.NewEncoder(w).Encode(map[string]any{"dataChannels": results}); err != nil {
				t.Errorf("encode DataChannel cleanup: %v", err)
			}
		default:
			t.Errorf("unexpected participant transport request %q", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	transport := NewRuntimeParticipantTransport(server.URL, DecodedHandle{ParticipantID: "agent-a"}, handler, nil)
	transport.session = "agent-session"
	transport.engine = NewEngine(EngineEvents{}, nil)
	transport.ctx = context.Background()
	transport.waitChannelsReady = func(context.Context, context.Context, []reliableParticipantDataChannel, time.Duration) error {
		return nil
	}
	transport.createParticipantChannel = func(_ string, id uint16) (reliableParticipantDataChannel, error) {
		return &capabilityTestChannel{payloads: make(chan []byte, 4), id: id}, nil
	}
	appID := "generated:123e4567-e89b-12d3-a456-426614174000"
	makeProjection := func(aSession string, revision int64, includeB bool) types.RuntimeParticipantTransportProjection {
		projection := types.RuntimeParticipantTransportProjection{
			Routes: []types.RuntimeParticipantTransportRoute{{
				AppInstanceID: appID, BundleRevision: revision, TaskRequestID: "task-a",
				AgentParticipantID: "agent-a", HumanParticipantID: "human-a",
				RuntimeHostID: "11111111-2222-3333-4444-555555555555", CapabilityIDs: []string{"printer_status"},
			}},
			Sources: []types.RuntimeParticipantTransportSource{{ParticipantID: "human-a", SessionID: aSession}},
		}
		if includeB {
			projection.Routes = append(projection.Routes, types.RuntimeParticipantTransportRoute{
				AppInstanceID: appID, BundleRevision: revision, TaskRequestID: "task-a",
				AgentParticipantID: "agent-a", HumanParticipantID: "human-b",
				RuntimeHostID: "11111111-2222-3333-4444-555555555555", CapabilityIDs: []string{"printer_status"},
			})
			projection.Sources = append(projection.Sources, types.RuntimeParticipantTransportSource{ParticipantID: "human-b", SessionID: "HB"})
		}
		return projection
	}
	keyA := participantRouteKey{appInstanceID: appID, humanParticipantID: "human-a"}
	keyB := participantRouteKey{appInstanceID: appID, humanParticipantID: "human-b"}
	if err := transport.Update(context.Background(), makeProjection("HA", 1, true)); err != nil {
		t.Fatalf("commit initial A/B V1 routes: %v", err)
	}
	laneA := transport.outbound["human-a"].(*capabilityTestChannel)
	laneB := transport.outbound["human-b"].(*capabilityTestChannel)
	if !laneA.Ready() || !laneB.Ready() || laneA == laneB {
		t.Fatal("initial Human lanes were not independently ready")
	}
	allocationA := transport.channelAllocations["human-a"]
	allocationB := transport.channelAllocations["human-b"]

	// Human B leaves. The fake SFU close remains unresolved. Whether Update
	// reports that cleanup failure or commits a route-only projection, B must
	// be immediately revoked while A's committed V1 route/lane stays live.
	_ = transport.Update(context.Background(), makeProjection("HA", 1, false))
	if _, ok := transport.routes[keyB]; ok {
		t.Fatal("removed Human B route remained authorized after cleanup failure")
	}
	if _, ok := transport.routes[keyA]; !ok || transport.outbound["human-a"] != laneA || !laneA.Ready() {
		t.Fatalf("B cleanup failure disrupted healthy A V1 route/lane: route=%v laneSame=%v ready=%v", transport.routes[keyA], transport.outbound["human-a"] == laneA, laneA.Ready())
	}
	if transport.outbound["human-b"] != nil || !laneB.closed || !reflect.DeepEqual(transport.pendingCloseIDs, []uint16{allocationB}) {
		t.Fatalf("B removal did not revoke lane while retaining cleanup ownership: outbound=%v closed=%v pending=%v", transport.outbound["human-b"], laneB.closed, transport.pendingCloseIDs)
	}

	frame, err := json.Marshal(capabilityFrame{
		Type: capabilityRequestFrame, RequestID: "request-b-after-removal", AppInstanceID: appID,
		BundleRevision: 1, TaskRequestID: "task-a", AgentID: "agent-a",
		CapabilityID: "printer_status", Operation: types.ResidentCapabilityObserve,
	})
	if err != nil {
		t.Fatal(err)
	}
	wire, err := json.Marshal(roomAppEnvelope{ProtocolVersion: 1, Lane: "reliable", AppInstanceID: appID, Payload: frame})
	if err != nil {
		t.Fatal(err)
	}
	labelB := participantDirectReliableChannelName("agent-a", "human-b")
	transport.receive(labelB, laneB, wire)
	select {
	case call := <-handler.calls:
		t.Fatalf("removed Human B executed capability after cleanup failure: %+v", call)
	default:
	}
	frameA1, err := json.Marshal(capabilityFrame{
		Type: capabilityRequestFrame, RequestID: "request-a-v1", AppInstanceID: appID,
		BundleRevision: 1, TaskRequestID: "task-a", AgentID: "agent-a",
		CapabilityID: "printer_status", Operation: types.ResidentCapabilityObserve,
	})
	if err != nil {
		t.Fatal(err)
	}
	wireA1, err := json.Marshal(roomAppEnvelope{ProtocolVersion: 1, Lane: "reliable", AppInstanceID: appID, Payload: frameA1})
	if err != nil {
		t.Fatal(err)
	}
	labelA := participantDirectReliableChannelName("agent-a", "human-a")
	transport.receive(labelA, laneA, wireA1)
	select {
	case call := <-handler.calls:
		if call.RequestID != "request-a-v1" {
			t.Fatalf("A V1 route reached capability handler with wrong identity: %q", call.RequestID)
		}
	case <-time.After(time.Second):
		t.Fatal("surviving A V1 route stopped executing after B cleanup failed")
	}

	beforeRouteOnly := len(operations)
	blockNextBCleanup <- struct{}{}
	updateDone := make(chan error, 1)
	go func() { updateDone <- transport.Update(context.Background(), makeProjection("HA", 2, false)) }()
	select {
	case <-bCleanupEntered:
	case <-time.After(time.Second):
		t.Fatal("route-only V2 update did not attempt pending B cleanup")
	}
	transport.mu.Lock()
	routeAAfterV2, hasRouteAAfterV2 := transport.routes[keyA]
	_, hasRouteBAfterV2 := transport.routes[keyB]
	humanBAfterV2 := transport.outbound["human-b"]
	laneAAfterV2 := transport.outbound["human-a"]
	allocationAAfterV2 := transport.channelAllocations["human-a"]
	transport.mu.Unlock()
	if !hasRouteAAfterV2 || routeAAfterV2.BundleRevision != 2 {
		close(releaseBCleanup)
		t.Fatalf("A V2 route was not committed before pending cleanup responded: route=%+v exists=%v", routeAAfterV2, hasRouteAAfterV2)
	}
	if hasRouteBAfterV2 || humanBAfterV2 != nil {
		close(releaseBCleanup)
		t.Fatal("removed Human B regained route or lane while A V2 committed")
	}
	if laneAAfterV2 != laneA || !laneA.Ready() || allocationAAfterV2 != allocationA {
		close(releaseBCleanup)
		t.Fatal("route-only revision did not reuse A's unchanged ready lane")
	}
	frameA, err := json.Marshal(capabilityFrame{
		Type: capabilityRequestFrame, RequestID: "request-a-v2", AppInstanceID: appID,
		BundleRevision: 2, TaskRequestID: "task-a", AgentID: "agent-a",
		CapabilityID: "printer_status", Operation: types.ResidentCapabilityObserve,
	})
	if err != nil {
		close(releaseBCleanup)
		t.Fatal(err)
	}
	wireA, err := json.Marshal(roomAppEnvelope{ProtocolVersion: 1, Lane: "reliable", AppInstanceID: appID, Payload: frameA})
	if err != nil {
		close(releaseBCleanup)
		t.Fatal(err)
	}
	transport.receive(labelA, laneA, wireA)
	select {
	case call := <-handler.calls:
		if call.RequestID != "request-a-v2" {
			close(releaseBCleanup)
			t.Fatalf("V2 request reached capability handler with wrong identity: %q", call.RequestID)
		}
	case <-time.After(time.Second):
		close(releaseBCleanup)
		t.Fatal("healthy A V2 capability could not execute while unrelated cleanup was unresolved")
	}
	close(releaseBCleanup)
	if err := <-updateDone; err != nil {
		t.Fatalf("route-only V2 update failed after cleanup response: %v", err)
	}
	if !reflect.DeepEqual(operations[beforeRouteOnly:], []operation{{kind: "close", human: "human-b"}}) {
		t.Fatalf("route-only update churned A's DataChannel: operations=%v", operations[beforeRouteOnly:])
	}
	if !reflect.DeepEqual(transport.pendingCloseIDs, []uint16{allocationB}) {
		t.Fatalf("route-only commit lost unresolved B cleanup ownership: %v", transport.pendingCloseIDs)
	}
	cleanupBFails = false
	if err := transport.Update(context.Background(), makeProjection("HA", 2, false)); err != nil {
		t.Fatalf("later B cleanup success disturbed committed A V2 route: %v", err)
	}
	if len(transport.pendingCloseIDs) != 0 || transport.routes[keyA].BundleRevision != 2 || transport.outbound["human-a"] != laneA {
		t.Fatalf("later cleanup did not clear only pending ownership while preserving A V2: pending=%v route=%+v laneSame=%v", transport.pendingCloseIDs, transport.routes[keyA], transport.outbound["human-a"] == laneA)
	}
}

func TestParticipantDataTransportUnresolvedCleanupStillGatesNewLaneAllocation(t *testing.T) {
	newCalls := 0
	var closeIDs []uint16
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/sfu/datachannels/new":
			newCalls++
			_, _ = io.WriteString(w, `{"dataChannels":[{"id":51}]}`)
		case "/api/sfu/datachannels/close":
			var body struct {
				DataChannels []struct {
					ID uint16 `json:"id"`
				} `json:"dataChannels"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode pending cleanup: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			results := make([]map[string]any, 0, len(body.DataChannels))
			for _, channel := range body.DataChannels {
				closeIDs = append(closeIDs, channel.ID)
				result := map[string]any{"id": channel.ID}
				if channel.ID == 43 {
					result["errorCode"] = "internal_error"
				}
				results = append(results, result)
			}
			if err := json.NewEncoder(w).Encode(map[string]any{"dataChannels": results}); err != nil {
				t.Errorf("encode pending cleanup: %v", err)
			}
		default:
			t.Errorf("unexpected participant transport request %q", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	appID := "generated:123e4567-e89b-12d3-a456-426614174000"
	handler := &capabilityTestHandler{descriptors: []types.RuntimeCapabilityProjection{validCapabilityTestDescriptor("printer_status", true)}}
	transport := NewRuntimeParticipantTransport(server.URL, DecodedHandle{ParticipantID: "agent-a"}, handler, nil)
	transport.session = "agent-session"
	transport.engine = NewEngine(EngineEvents{}, nil)
	transport.ctx = context.Background()
	laneA := &capabilityTestChannel{payloads: make(chan []byte, 1), id: 42}
	labelA := participantDirectReliableChannelName("agent-a", "human-a")
	routeA := types.RuntimeParticipantTransportRoute{
		AppInstanceID: appID, BundleRevision: 1, TaskRequestID: "task-a",
		AgentParticipantID: "agent-a", HumanParticipantID: "human-a",
		RuntimeHostID: "11111111-2222-3333-4444-555555555555", CapabilityIDs: []string{"printer_status"},
	}
	transport.outbound = map[string]reliableParticipantDataChannel{"human-a": laneA}
	transport.routes = map[participantRouteKey]types.RuntimeParticipantTransportRoute{{appInstanceID: appID, humanParticipantID: "human-a"}: routeA}
	transport.sources = map[string]string{labelA: "human-a"}
	transport.peerSessions = map[string]string{"human-a": "HA"}
	transport.channelTokens = map[string]any{"human-a": laneA}
	transport.channelAllocations = map[string]uint16{"human-a": 42}
	transport.pendingCloseIDs = []uint16{43} // unresolved allocation from removed Human B

	replacement := routeA
	replacement.BundleRevision = 2
	projection := types.RuntimeParticipantTransportProjection{
		Routes:  []types.RuntimeParticipantTransportRoute{replacement},
		Sources: []types.RuntimeParticipantTransportSource{{ParticipantID: "human-a", SessionID: "HA2"}},
	}
	err := transport.Update(context.Background(), projection)
	var failure *ParticipantTransportFailure
	if !errors.As(err, &failure) || failure.Stage != ParticipantTransportFailureStageCleanupRetiredAllocation || failure.ProviderErrorClass != "internal_error" {
		t.Fatalf("replacement update = %#v, want cleanup-stage gate", err)
	}
	if newCalls != 0 {
		t.Fatalf("replacement allocation ran before pending cleanup resolved: new calls=%d", newCalls)
	}
	if !reflect.DeepEqual(closeIDs, []uint16{43, 42}) {
		t.Fatalf("cleanup did not include unrelated and retiring allocations: %v", closeIDs)
	}
	if !reflect.DeepEqual(transport.pendingCloseIDs, []uint16{43, 42}) {
		t.Fatalf("failed cleanup did not retain ownership: %v", transport.pendingCloseIDs)
	}
	if _, ok := transport.routes[participantRouteKey{appInstanceID: appID, humanParticipantID: "human-a"}]; ok || transport.outbound["human-a"] != nil || !laneA.closed {
		t.Fatal("session replacement failure retained the stale Human A route or lane")
	}
}

func TestParticipantDataTransportNewerProjectionFencesAllocationCleanup(t *testing.T) {
	type operation struct {
		kind string
		id   uint16
	}
	var operations []operation
	active := map[uint16]bool{}
	nextID := uint16(42)
	closeEntered := make(chan struct{})
	releaseClose := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/sfu/datachannels/new":
			id := nextID
			nextID++
			active[id] = true
			operations = append(operations, operation{kind: "new", id: id})
			_, _ = io.WriteString(w, `{"dataChannels":[{"id":`+strconv.Itoa(int(id))+`}]}`)
		case "/api/sfu/datachannels/close":
			var body struct {
				DataChannels []struct {
					ID uint16 `json:"id"`
				} `json:"dataChannels"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode DataChannel close: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			if len(body.DataChannels) != 1 {
				t.Errorf("close request has %d channels, want one", len(body.DataChannels))
			}
			select {
			case closeEntered <- struct{}{}:
			default:
			}
			<-releaseClose
			for _, channel := range body.DataChannels {
				if !active[channel.ID] {
					t.Errorf("Runtime closed unknown or already retired allocation %d", channel.ID)
				}
				delete(active, channel.ID)
				operations = append(operations, operation{kind: "close", id: channel.ID})
			}
			ids := make([]uint16, 0, len(body.DataChannels))
			for _, channel := range body.DataChannels {
				ids = append(ids, channel.ID)
			}
			writeParticipantDataChannelCloseResult(t, w, ids)
		default:
			t.Errorf("unexpected participant transport request %q", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	engine := NewEngine(EngineEvents{}, nil)
	if err := engine.Create(); err != nil {
		t.Skipf("Pion unavailable: %v", err)
	}
	defer engine.Close()
	transport := NewRuntimeParticipantTransport(server.URL, DecodedHandle{ParticipantID: "agent-a"},
		&capabilityTestHandler{descriptors: []types.RuntimeCapabilityProjection{validCapabilityTestDescriptor("printer_status", true)}}, nil)
	transport.session = "agent-session"
	transport.engine = engine
	transport.ctx = context.Background()
	transport.waitChannelsReady = func(context.Context, context.Context, []reliableParticipantDataChannel, time.Duration) error {
		return nil
	}
	transport.createParticipantChannel = func(_ string, id uint16) (reliableParticipantDataChannel, error) {
		return &capabilityTestChannel{payloads: make(chan []byte, 1), id: id}, nil
	}
	appID := "generated:123e4567-e89b-12d3-a456-426614174000"
	projection := func(sessionID string) types.RuntimeParticipantTransportProjection {
		return types.RuntimeParticipantTransportProjection{
			Routes: []types.RuntimeParticipantTransportRoute{{
				AppInstanceID: appID, BundleRevision: 1, TaskRequestID: "task-a",
				AgentParticipantID: "agent-a", HumanParticipantID: "human-a",
				RuntimeHostID: "11111111-2222-3333-4444-555555555555", CapabilityIDs: []string{"printer_status"},
			}},
			Sources: []types.RuntimeParticipantTransportSource{{ParticipantID: "human-a", SessionID: sessionID}},
		}
	}
	if err := transport.Update(context.Background(), projection("H1")); err != nil {
		t.Fatalf("commit H1 lane: %v", err)
	}
	h2Done := make(chan error, 1)
	go func() { h2Done <- transport.Update(context.Background(), projection("H2")) }()
	select {
	case <-closeEntered:
	case <-time.After(time.Second):
		t.Fatal("H2 update did not begin closing the committed H1 allocation")
	}
	h3Done := make(chan error, 1)
	h3Started := make(chan struct{})
	go func() {
		close(h3Started)
		h3Done <- transport.Update(context.Background(), projection("H3"))
	}()
	<-h3Started
	close(releaseClose)
	if err := <-h2Done; err != nil {
		t.Fatalf("H2 update failed: %v", err)
	}
	if err := <-h3Done; err != nil {
		t.Fatalf("newer H3 update failed: %v", err)
	}
	final := transport.outbound["human-a"].(*capabilityTestChannel)
	if final.ID() != 44 || transport.peerSessions["human-a"] != "H3" {
		t.Fatalf("newest projection not committed: id=%d session=%s", final.ID(), transport.peerSessions["human-a"])
	}
	want := []operation{{kind: "new", id: 42}, {kind: "close", id: 42}, {kind: "new", id: 43}, {kind: "close", id: 43}, {kind: "new", id: 44}}
	if !reflect.DeepEqual(operations, want) {
		t.Fatalf("fenced SFU operations = %v, want %v", operations, want)
	}
	if len(active) != 1 || !active[44] {
		t.Fatalf("stale update closed or leaked the newer allocation: %v", active)
	}
}

func TestParticipantDataTransportH1ToH2FailureThenReplayRecoversRoute(t *testing.T) {
	var mu sync.Mutex
	var allocated []uint16
	channelCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/sfu/datachannels/new":
			mu.Lock()
			channelCalls++
			call := channelCalls
			if call == 1 {
				mu.Unlock()
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = io.WriteString(w, `{"error":"private allocation detail"}`)
				return
			}
			id := uint16(70 + len(allocated))
			allocated = append(allocated, id)
			mu.Unlock()
			_, _ = io.WriteString(w, `{"dataChannels":[{"id":`+strconv.Itoa(int(id))+`}]}`)
		case "/api/sfu/datachannels/close":
			var body struct {
				DataChannels []struct {
					ID uint16 `json:"id"`
				} `json:"dataChannels"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode DataChannel close: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			ids := make([]uint16, 0, len(body.DataChannels))
			for _, channel := range body.DataChannels {
				ids = append(ids, channel.ID)
			}
			writeParticipantDataChannelCloseResult(t, w, ids)
		default:
			t.Errorf("unexpected participant transport request %q", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	engine := NewEngine(EngineEvents{}, nil)
	if err := engine.Create(); err != nil {
		t.Skipf("Pion unavailable: %v", err)
	}
	defer engine.Close()
	handler := &capabilityTestHandler{
		calls:       make(chan types.ResidentCapabilityRequest, 1),
		descriptors: []types.RuntimeCapabilityProjection{validCapabilityTestDescriptor("printer_status", true)},
	}
	transport := NewRuntimeParticipantTransport(server.URL, DecodedHandle{ParticipantID: "agent-a"}, handler, nil)
	transport.session = "agent-session"
	transport.engine = engine
	transport.ctx = context.Background()
	appID := "generated:123e4567-e89b-12d3-a456-426614174000"
	route := func(human string) types.RuntimeParticipantTransportRoute {
		return types.RuntimeParticipantTransportRoute{
			AppInstanceID: appID, BundleRevision: 1, TaskRequestID: "task-a", AgentParticipantID: "agent-a",
			HumanParticipantID: human, RuntimeHostID: "11111111-2222-3333-4444-555555555555", CapabilityIDs: []string{"printer_status"},
		}
	}
	oldLane := &capabilityTestChannel{payloads: make(chan []byte, 1), id: 5}
	oldLabel := participantDirectReliableChannelName("agent-a", "human-a")
	transport.outbound = map[string]reliableParticipantDataChannel{"human-a": oldLane}
	transport.routes = map[participantRouteKey]types.RuntimeParticipantTransportRoute{{appInstanceID: appID, humanParticipantID: "human-a"}: route("human-a")}
	transport.sources = map[string]string{oldLabel: "human-a"}
	transport.peerSessions = map[string]string{"human-a": "session-H1"}
	transport.channelTokens = map[string]any{"human-a": oldLane}
	transport.channelAllocations = map[string]uint16{"human-a": 41}

	var waits int
	transport.waitChannelsReady = func(context.Context, context.Context, []reliableParticipantDataChannel, time.Duration) error {
		waits++
		if waits == 1 {
			return participantTransportFailure(ParticipantTransportFailureChannelReadyTimeout, errors.New("private timeout detail"))
		}
		return nil
	}
	var nextChannel uint16
	createdChannels := 0
	var h2Lane *capabilityTestChannel
	transport.createParticipantChannel = func(_ string, id uint16) (reliableParticipantDataChannel, error) {
		createdChannels++
		nextChannel = id
		lane := &capabilityTestChannel{payloads: make(chan []byte, 1), id: id}
		if createdChannels > 2 {
			t.Fatal("replayed H2 update created multiple new lanes")
		}
		if createdChannels == 1 {
			return lane, nil // this partial lane is retired by the injected readiness failure
		}
		h2Lane = lane
		return lane, nil
	}
	h2 := types.RuntimeParticipantTransportProjection{
		Routes:  []types.RuntimeParticipantTransportRoute{route("human-b")},
		Sources: []types.RuntimeParticipantTransportSource{{ParticipantID: "human-b", SessionID: "session-H2"}},
	}
	err := transport.Update(context.Background(), h2)
	var classified *ParticipantTransportFailure
	if !errors.As(err, &classified) || classified.Class != ParticipantTransportFailureAllocationFailed {
		t.Fatalf("H2 allocation failure = %v, want typed allocation failure", err)
	}
	if !oldLane.closed || len(transport.routes) != 0 || len(transport.outbound) != 0 {
		t.Fatalf("allocation failure retained H1 state: closed=%v routes=%v outbound=%v", oldLane.closed, transport.routes, transport.outbound)
	}

	err = transport.Update(context.Background(), h2)
	if !errors.As(err, &classified) || classified.Class != ParticipantTransportFailureChannelReadyTimeout {
		t.Fatalf("H2 readiness failure = %v, want typed channel-ready timeout", err)
	}
	if !oldLane.closed {
		t.Fatal("failed H2 update retained the stale H1 lane")
	}
	if _, ok := transport.routes[participantRouteKey{appInstanceID: appID, humanParticipantID: "human-a"}]; ok || len(transport.outbound) != 0 || len(transport.sources) != 0 {
		t.Fatalf("failed H2 update retained stale route/lane: routes=%v outbound=%v sources=%v", transport.routes, transport.outbound, transport.sources)
	}

	if err := transport.Update(context.Background(), h2); err != nil {
		t.Fatalf("identical H2 replay failed: %v", err)
	}
	if waits != 2 || len(allocated) != 2 || createdChannels != 2 || h2Lane == nil || nextChannel != allocated[1] {
		t.Fatalf("replay did not establish H2 lane: waits=%d allocated=%v lane=%v", waits, allocated, h2Lane != nil)
	}
	if _, ok := transport.routes[participantRouteKey{appInstanceID: appID, humanParticipantID: "human-b"}]; !ok || transport.outbound["human-b"] != h2Lane {
		t.Fatalf("replay did not restore H2 route/lane: routes=%v outbound=%v", transport.routes, transport.outbound)
	}

	frame := capabilityFrame{Type: capabilityRequestFrame, RequestID: "request-h2", AppInstanceID: appID, BundleRevision: 1,
		TaskRequestID: "task-a", AgentID: "agent-a", CapabilityID: "printer_status", Operation: types.ResidentCapabilityObserve}
	framePayload, _ := json.Marshal(frame)
	wire, _ := json.Marshal(roomAppEnvelope{ProtocolVersion: 1, Lane: "reliable", AppInstanceID: appID, Payload: framePayload})
	transport.receive(participantDirectReliableChannelName("agent-a", "human-b"), h2Lane, wire)
	select {
	case request := <-handler.calls:
		if request.RequestID != "request-h2" || request.RuntimeHostID != route("human-b").RuntimeHostID {
			t.Fatalf("recovered H2 capability route used unexpected request: %+v", request)
		}
	case <-time.After(time.Second):
		t.Fatal("recovered H2 route did not reach capability controller")
	}
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
	transport.channelTokens = map[string]any{"human-a": channel}
	transport.receive(label, channel, request)
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
	transport.channelTokens = map[string]any{"human-a": humanA, "human-b": humanB}
	transport.receive(labelB, humanB, wireB)
	transport.receive(labelA, humanA, wire)
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
	channel := &capabilityTestChannel{payloads: make(chan []byte, 1)}
	transport.outbound = map[string]reliableParticipantDataChannel{"human-a": channel}
	transport.routes = map[participantRouteKey]types.RuntimeParticipantTransportRoute{}
	transport.sources = map[string]string{participantDirectReliableChannelName("agent-a", "human-a"): "human-a"}
	transport.channelTokens = map[string]any{"human-a": channel}
	payload, _ := json.Marshal(roomAppEnvelope{ProtocolVersion: 1, Lane: "reliable", AppInstanceID: "generated:123e4567-e89b-12d3-a456-426614174000", Payload: json.RawMessage(`{"type":"runtime-capability-request","requestId":"request-a","appInstanceId":"generated:123e4567-e89b-12d3-a456-426614174000","bundleRevision":2,"taskRequestId":"task-a","agentParticipantId":"agent-a","capabilityId":"printer_status","operation":"observe"}`)})
	transport.receive("participant-direct-reliable-unknown", channel, payload)
	transport.receive(participantDirectReliableChannelName("agent-a", "human-a"), channel, payload)
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
			transport.channelTokens = map[string]any{"human-a": outbound}
			frame := capabilityFrame{
				Type: capabilityRequestFrame, RequestID: "request-a", AppInstanceID: appID,
				BundleRevision: 2, TaskRequestID: "task-a", AgentID: "agent-a",
				CapabilityID: "printer_status", Operation: test.operation,
				Action: test.action, Args: test.args,
			}
			framePayload, _ := json.Marshal(frame)
			wire, _ := json.Marshal(roomAppEnvelope{ProtocolVersion: 1, Lane: "reliable", AppInstanceID: appID, Payload: framePayload})
			transport.receive(label, outbound, wire)

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
	engine := NewEngine(EngineEvents{OnDataChannelMessage: func(label string, _ *ParticipantDataChannel, payload []byte) {
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
