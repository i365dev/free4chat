package free4chat

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/i365dev/free4chat/agent/internal/types"
)

const (
	residentEventPath       = "/api/room/agent-events"
	maxResidentEventBytes   = 2 * 1024 * 1024
	residentEventReadLimit  = maxResidentEventBytes + 1
	defaultAgentLeaseMillis = 90 * 1000

	// residentTaskControlType is the private control envelope emitted only on
	// this resident socket. It is not part of the public MCP protocol.
	residentTaskControlType = "task-control"
	// maxResidentTaskRequestID bounds the correlation id carried by a private
	// control frame. The Room already bounds task request ids well below this.
	maxResidentTaskRequestID = 64
)

// residentEventStream is deliberately a one-reader/one-writer wrapper around
// coder/websocket. The Runtime reads server envelopes and sends only sparse
// heartbeat messages; ordinary Room mutations continue to use the existing
// authenticated MCP/Room client methods.
type residentEventStream struct {
	conn *websocket.Conn
}

// residentEventEnvelope is kept separate from WaitResult so the public MCP
// wait_for_events contract remains independent of this private transport.
// Control, TaskRequestID, and TurnSequence are read ONLY for the private
// "task-control" envelope type; an ordinary "events" envelope never carries
// them.
type residentEventEnvelope struct {
	Type         string                     `json:"type"`
	Events       []types.RoomEvent          `json:"events"`
	Cursor       int64                      `json:"cursor"`
	ExpiresAt    int64                      `json:"expiresAt"`
	Participants []json.RawMessage          `json:"participants"`
	RuntimeHosts map[string]json.RawMessage `json:"runtimeHosts"`
	MediaState   *types.ResidentMediaState  `json:"mediaState,omitempty"`
	Expired      bool                       `json:"expired,omitempty"`
	Truncated    bool                       `json:"truncated,omitempty"`
	// Private resident-only Task control (#409).
	Control       string `json:"control,omitempty"`
	TaskRequestID string `json:"taskRequestId,omitempty"`
	TurnSequence  int64  `json:"turnSequence,omitempty"`
}

// OpenResidentEventStream opens the Runtime-owned hibernatable Room event
// transport. The participant bearer is sent only in an HTTP header; it never
// enters the URL, WebSocket payload, serialized socket state, or Harness.
func (c *Client) OpenResidentEventStream(
	ctx context.Context,
	participantHandle string,
	cursor int64,
) (types.ResidentEventStream, error) {
	if cursor < 0 {
		return nil, &Error{Message: "invalid resident event cursor", Code: CodeToolError}
	}
	handle, err := parseRoomControlHandle(participantHandle)
	if err != nil {
		return nil, err
	}
	endpoint, err := c.roomControlEndpoint(residentEventPath)
	if err != nil {
		return nil, err
	}
	originScheme := endpoint.Scheme
	if endpoint.Scheme == "https" {
		endpoint.Scheme = "wss"
	} else if endpoint.Scheme == "http" {
		endpoint.Scheme = "ws"
	} else {
		return nil, &Error{Message: "invalid resident event endpoint", Code: CodeToolError}
	}

	header := make(http.Header)
	header.Set("Origin", originScheme+"://"+endpoint.Host)
	header.Set("X-Room-Id", handle.Room)
	header.Set("X-Room-Participant-Id", handle.ParticipantID)
	header.Set("X-Room-Participant-Token", handle.ParticipantToken)
	header.Set("Authorization", "Bearer "+handle.ParticipantToken)
	header.Set("X-Room-Cursor", fmt.Sprintf("%d", cursor))
	header.Set("User-Agent", defaultUserAgent)
	conn, response, err := websocket.Dial(ctx, endpoint.String(), &websocket.DialOptions{
		HTTPClient: c.HTTP,
		HTTPHeader: header,
	})
	if err != nil {
		return nil, classifyResidentEventDialError(response)
	}
	// coder/websocket defaults to 32 KiB. The application cap is derived from
	// RoomSession's retained event window and enforced by the server after JSON
	// serialization; allow one byte above it so Receive can classify an
	// over-cap frame deterministically instead of treating it as a retryable
	// transport failure.
	conn.SetReadLimit(residentEventReadLimit)
	return &residentEventStream{conn: conn}, nil
}

func classifyResidentEventDialError(response *http.Response) error {
	if response != nil {
		switch response.StatusCode {
		case http.StatusGone:
			return &Error{Message: "room expired", Code: CodeRoomExpired}
		case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound:
			return &Error{Message: "resident event stream unauthorized", Code: CodeInvalidParticipantHandle}
		case http.StatusTooManyRequests:
			return &Error{Message: "resident event stream temporarily unavailable", Code: CodeTransient}
		}
		if response.StatusCode >= 500 {
			return &Error{Message: "resident event stream temporarily unavailable", Code: CodeTransient}
		}
	}
	return &Error{Message: "resident event stream connection failed", Code: CodeTransient}
}

func (s *residentEventStream) Receive(ctx context.Context) (types.WaitResult, error) {
	messageType, payload, err := s.conn.Read(ctx)
	if err != nil {
		if websocket.CloseStatus(err) == websocket.StatusMessageTooBig ||
			strings.Contains(err.Error(), "read limited at") {
			return types.WaitResult{}, &Error{Message: "resident event stream exceeded its message limit", Code: CodeToolError}
		}
		return types.WaitResult{}, &Error{Message: "resident event stream read failed", Code: CodeTransient}
	}
	if messageType != websocket.MessageText || len(payload) > maxResidentEventBytes {
		return types.WaitResult{}, &Error{Message: "resident event stream returned an invalid message", Code: CodeToolError}
	}
	var envelope residentEventEnvelope
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return types.WaitResult{}, &Error{Message: "resident event stream returned invalid JSON", Code: CodeToolError}
	}
	if envelope.Type == "error" {
		return types.WaitResult{}, &Error{Message: "resident event stream rejected the event envelope", Code: CodeToolError}
	}
	if envelope.Type == "expired" || envelope.Expired {
		return types.WaitResult{}, &Error{Message: "room expired", Code: CodeRoomExpired}
	}
	if envelope.Type == residentTaskControlType {
		// PRIVATE RESIDENT TRANSPORT ONLY: a transient control frame, not a
		// Room event. It carries no cursor and must never be projected as
		// wait_for_events content.
		control, err := parseResidentTaskControl(
			envelope.Control,
			envelope.TaskRequestID,
			envelope.TurnSequence,
		)
		if err != nil {
			return types.WaitResult{}, err
		}
		return types.WaitResult{TaskControl: control}, nil
	}
	if envelope.Type != "events" || envelope.Cursor < 0 || envelope.ExpiresAt <= 0 {
		return types.WaitResult{}, &Error{Message: "resident event stream returned an invalid envelope", Code: CodeToolError}
	}
	wait := types.WaitResult{
		Events:     envelope.Events,
		Cursor:     envelope.Cursor,
		ExpiresAt:  envelope.ExpiresAt,
		MediaState: envelope.MediaState,
	}
	if envelope.Participants != nil {
		raw := make([]any, 0, len(envelope.Participants))
		for _, item := range envelope.Participants {
			var value any
			if err := json.Unmarshal(item, &value); err == nil {
				raw = append(raw, value)
			}
		}
		wait.Participants = NormalizeRoster(raw)
	}
	if envelope.RuntimeHosts != nil {
		wait.RuntimeHosts = make(map[string]types.RuntimeHostProjection)
		for hostID, item := range envelope.RuntimeHosts {
			var value any
			if err := json.Unmarshal(item, &value); err != nil {
				continue
			}
			host := ParseRuntimeHostStrict(value)
			if host != nil && host.RuntimeHostID == hostID {
				wait.RuntimeHosts[hostID] = *host
			}
		}
	}
	return wait, nil
}

// parseResidentTaskControl validates one private resident control frame. A
// malformed, unknown, unidentified, or oversized control fails closed: it is
// neither degraded into an ordinary Room event nor partially applied.
func parseResidentTaskControl(rawControl, rawTaskRequestID string, rawTurnSequence int64) (*types.ResidentTaskControl, error) {
	kind := types.ResidentTaskControlKind(rawControl)
	if kind != types.ResidentTaskControlInterrupt {
		return nil, &Error{Message: "resident event stream returned an unsupported task control", Code: CodeToolError}
	}
	if !validResidentTaskRequestID(rawTaskRequestID) {
		return nil, &Error{Message: "resident event stream returned an invalid task control", Code: CodeToolError}
	}
	// A control must name the EXACT turn it targets. A missing, zero,
	// negative, or unrepresentable sequence cannot identify one turn, so it is
	// rejected instead of widening into "any turn of this Task".
	if rawTurnSequence <= 0 || rawTurnSequence > types.MaxResidentTurnSequence {
		return nil, &Error{Message: "resident event stream returned an invalid task turn", Code: CodeToolError}
	}
	return &types.ResidentTaskControl{
		Kind:          kind,
		TaskRequestID: rawTaskRequestID,
		TurnSequence:  rawTurnSequence,
	}, nil
}

// validResidentTaskRequestID bounds an opaque Task correlation id without
// rewriting it. The value is never trimmed: a padded id is rejected instead of
// being silently repaired into a different Task identity.
func validResidentTaskRequestID(value string) bool {
	if value == "" || len(value) > maxResidentTaskRequestID {
		return false
	}
	for _, r := range value {
		if r <= ' ' || r == 0x7f {
			return false
		}
	}
	return true
}

func (s *residentEventStream) Heartbeat(ctx context.Context, cursor int64) error {
	if cursor < 0 {
		return &Error{Message: "invalid resident event cursor", Code: CodeToolError}
	}
	payload, err := json.Marshal(map[string]any{
		"type":   "heartbeat",
		"cursor": cursor,
	})
	if err != nil {
		return &Error{Message: "encode resident event heartbeat", Code: CodeToolError}
	}
	if err := s.conn.Write(ctx, websocket.MessageText, payload); err != nil {
		return &Error{Message: "resident event heartbeat failed", Code: CodeTransient}
	}
	return nil
}

func (s *residentEventStream) Close() error {
	return s.conn.Close(websocket.StatusNormalClosure, "")
}

// DefaultAgentLeaseDuration is used only for compatibility with injected
// test clients that predate the server-provided lease field. The built-in
// client receives the current lease in join/create responses and the Runtime
// derives its heartbeat interval from that value.
func DefaultAgentLeaseDuration() time.Duration {
	return defaultAgentLeaseMillis * time.Millisecond
}
