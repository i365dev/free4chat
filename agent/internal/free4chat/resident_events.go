package free4chat

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
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

	// residentSessionControlType / residentSessionResultType are the second
	// private family on this socket (#409 Task Session Continuation). Both are
	// strictly private: never a Room event, never persisted, never returned by
	// the public wait_for_events contract.
	residentSessionControlType = "task-session-control"
	residentSessionResultType  = "task-session-result"
	// maxResidentSessionToken bounds every opaque Runtime-issued token the
	// Room relays back. The Runtime mints them well below this.
	maxResidentSessionToken = 128
	// maxResidentSessionResultBytes bounds one outbound result frame. The
	// product page bounds (10 rows, 24 projects) sit far below it; this is the
	// fail-closed transport guard.
	maxResidentSessionResultBytes = 64 * 1024

	// residentTaskExecutionResyncType is the third private frame family
	// (#421): a FIRE-AND-FORGET request asking the Runtime to re-state the
	// CURRENT transient execution projection of every Task scope it owns.
	//
	// It exists because Room execution projections are memory-only, so a
	// hibernated Durable Object loses them while the resident socket survives
	// and the local Harness keeps working. The Room sends it only to a
	// resident that advertises RuntimeFeatureProjection
	// .TaskExecutionReconciliation.
	//
	// It carries no payload, no request id, and no tokens: it can never
	// correlate with, overwrite, or be answered into the Task Session
	// Continuation request/response family.
	residentTaskExecutionResyncType = "task-execution-resync"
)

// residentEventStream is deliberately a one-reader/one-writer wrapper around
// coder/websocket. The Runtime reads server envelopes and sends only sparse
// heartbeat messages; ordinary Room mutations continue to use the existing
// authenticated MCP/Room client methods.
type residentEventStream struct {
	conn *websocket.Conn
	// writeMu serializes every outbound frame. This socket has more than one
	// legitimate writer now (the heartbeat ticker and a session-control
	// reply), and coder/websocket only guarantees that all methods except
	// Reader/Read may be called concurrently — it does NOT make two
	// concurrent Writes safe on the wire.
	writeMu sync.Mutex
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
	// Private resident-only Task control (#409, #484).
	Control       string `json:"control,omitempty"`
	TaskRequestID string `json:"taskRequestId,omitempty"`
	TurnSequence  int64  `json:"turnSequence,omitempty"`
	// SteerInstructionSequence is the canonical Room sequence of the already
	// persisted steer instruction. Identity only: never instruction text.
	SteerInstructionSequence int64 `json:"steerInstructionSequence,omitempty"`
	// Private resident-only Task Session Continuation control (#409).
	// Operation is the closed "list" | "prepare" | "cancel" set; the tokens
	// are opaque Runtime-local handles relayed unchanged.
	Operation          string            `json:"operation,omitempty"`
	RequestID          string            `json:"requestId,omitempty"`
	ProjectToken       string            `json:"projectToken,omitempty"`
	PageToken          string            `json:"pageToken,omitempty"`
	SessionToken       string            `json:"sessionToken,omitempty"`
	HumanParticipantID string            `json:"humanParticipantId,omitempty"`
	ModeID             string            `json:"modeId,omitempty"`
	ConfigOptions      map[string]string `json:"configOptions,omitempty"`
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
	if envelope.Type == residentTaskExecutionResyncType {
		// PRIVATE RESIDENT TRANSPORT ONLY: a fire-and-forget reconciliation
		// request. It is deliberately matched BEFORE the session-control and
		// "events" branches so it can never be degraded into another family,
		// and it carries no cursor, so the reader's cursor is untouched.
		return types.WaitResult{TaskExecutionResync: true}, nil
	}
	if envelope.Type == residentSessionControlType {
		// PRIVATE RESIDENT TRANSPORT ONLY: one bounded session-control
		// request, not a Room event. Like a Task control it carries no cursor
		// and must never be projected as wait_for_events content.
		control, err := parseResidentSessionControl(envelope)
		if err != nil {
			return types.WaitResult{}, err
		}
		return types.WaitResult{SessionControl: control}, nil
	}
	if envelope.Type == residentTaskControlType {
		// PRIVATE RESIDENT TRANSPORT ONLY: a transient control frame, not a
		// Room event. It carries no cursor and must never be projected as
		// wait_for_events content.
		control, err := parseResidentTaskControl(
			envelope.Control,
			envelope.TaskRequestID,
			envelope.TurnSequence,
			envelope.SteerInstructionSequence,
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
//
// Two shapes exist (#484):
//
//	interrupt  names only the EXACT active turn to yield;
//	steer      names that same exact turn AND the canonical Room sequence of the
//	           already-persisted steer instruction.
//
// The instruction text is deliberately absent: it is ordinary canonical Room
// input, and the control only carries its identity. An interrupt that carries a
// steer sequence, or a steer that carries none, is rejected outright instead of
// being guessed at.
func parseResidentTaskControl(rawControl, rawTaskRequestID string, rawTurnSequence, rawSteerSequence int64) (*types.ResidentTaskControl, error) {
	kind := types.ResidentTaskControlKind(rawControl)
	if kind != types.ResidentTaskControlInterrupt && kind != types.ResidentTaskControlSteer {
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
	control := &types.ResidentTaskControl{
		Kind:          kind,
		TaskRequestID: rawTaskRequestID,
		TurnSequence:  rawTurnSequence,
	}
	if kind == types.ResidentTaskControlInterrupt {
		if rawSteerSequence != 0 {
			return nil, &Error{Message: "resident event stream returned an invalid task control", Code: CodeToolError}
		}
		return control, nil
	}
	// The steer identity is a canonical Room sequence of an instruction this
	// Runtime can still deliver; anything else cannot name one.
	if rawSteerSequence <= 0 || rawSteerSequence > types.MaxResidentTurnSequence {
		return nil, &Error{Message: "resident event stream returned an invalid task steer", Code: CodeToolError}
	}
	control.SteerInstructionSequence = rawSteerSequence
	return control, nil
}

// parseResidentSessionControl validates one private session-control frame
// fail-closed. An unknown operation, a missing/oversized correlation id, or a
// token that is not a bounded opaque value is rejected outright: it is never
// degraded into an ordinary Room event and never partially applied.
func parseResidentSessionControl(envelope residentEventEnvelope) (*types.ResidentSessionControl, error) {
	kind := types.ResidentSessionControlKind(envelope.Operation)
	switch kind {
	case types.ResidentSessionControlList, types.ResidentSessionControlPrepare, types.ResidentSessionControlCancel:
	default:
		return nil, &Error{Message: "resident event stream returned an unsupported session control", Code: CodeToolError}
	}
	if !validResidentTaskRequestID(envelope.RequestID) {
		return nil, &Error{Message: "resident event stream returned an invalid session control", Code: CodeToolError}
	}
	// Every operation is Human-scoped. A control that names no Human cannot be
	// bound to a selection, so it is rejected rather than widened to "anyone".
	if !validResidentTaskRequestID(envelope.HumanParticipantID) {
		return nil, &Error{Message: "resident event stream returned an invalid session control", Code: CodeToolError}
	}
	for _, token := range []string{envelope.ProjectToken, envelope.PageToken, envelope.SessionToken} {
		if token != "" && !validResidentSessionToken(token) {
			return nil, &Error{Message: "resident event stream returned an invalid session control", Code: CodeToolError}
		}
	}
	if envelope.SessionToken != "" && kind != types.ResidentSessionControlPrepare {
		return nil, &Error{Message: "resident event stream returned an invalid session control", Code: CodeToolError}
	}
	if envelope.ProjectToken != "" && kind != types.ResidentSessionControlList && kind != types.ResidentSessionControlPrepare {
		return nil, &Error{Message: "resident event stream returned an invalid session control", Code: CodeToolError}
	}
	if envelope.ModeID != "" && (kind != types.ResidentSessionControlPrepare || !validHarnessControlValue(envelope.ModeID)) {
		return nil, &Error{Message: "resident event stream returned an invalid session control", Code: CodeToolError}
	}
	if len(envelope.ConfigOptions) > 16 || (len(envelope.ConfigOptions) > 0 && kind != types.ResidentSessionControlPrepare) {
		return nil, &Error{Message: "resident event stream returned an invalid session control", Code: CodeToolError}
	}
	for id, value := range envelope.ConfigOptions {
		if !validHarnessControlValue(id) || !validHarnessControlValue(value) {
			return nil, &Error{Message: "resident event stream returned an invalid session control", Code: CodeToolError}
		}
	}
	if envelope.TaskRequestID != "" {
		// prepare pins the adoption to exactly this canonical Task id; cancel
		// names the preparation it releases. Any other operation carrying one
		// is malformed.
		if (kind != types.ResidentSessionControlPrepare && kind != types.ResidentSessionControlCancel) ||
			!validResidentTaskRequestID(envelope.TaskRequestID) {
			return nil, &Error{Message: "resident event stream returned an invalid session control", Code: CodeToolError}
		}
	}
	if kind == types.ResidentSessionControlPrepare && ((envelope.SessionToken == "") == (envelope.ProjectToken == "") || envelope.TaskRequestID == "") {
		return nil, &Error{Message: "resident event stream returned an invalid session control", Code: CodeToolError}
	}
	return &types.ResidentSessionControl{
		Kind:               kind,
		RequestID:          envelope.RequestID,
		ProjectToken:       envelope.ProjectToken,
		PageToken:          envelope.PageToken,
		SessionToken:       envelope.SessionToken,
		ModeID:             envelope.ModeID,
		ConfigOptions:      envelope.ConfigOptions,
		TaskRequestID:      envelope.TaskRequestID,
		HumanParticipantID: envelope.HumanParticipantID,
	}, nil
}

func validHarnessControlValue(value string) bool {
	if value == "" || len([]rune(value)) > 512 {
		return false
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// validResidentSessionToken bounds one opaque Runtime-issued token. The value
// is never trimmed or repaired: a padded token is rejected rather than
// silently resolved into a different selection.
func validResidentSessionToken(value string) bool {
	if value == "" || len(value) > maxResidentSessionToken {
		return false
	}
	for _, r := range value {
		if r <= ' ' || r == 0x7f {
			return false
		}
	}
	return true
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
	if err := s.write(ctx, payload); err != nil {
		return &Error{Message: "resident event heartbeat failed", Code: CodeTransient}
	}
	return nil
}

// SendSessionResult answers exactly one private session-control request on the
// SAME connection it arrived on. It is a transient control-plane frame: no
// cursor, no Room sequence, no storage, no analytics.
//
// The result is bounded before it is encoded. An oversized result fails closed
// with one minimal error result instead of a truncated payload, so the Room can
// never mistake an incomplete page for a complete one.
func (s *residentEventStream) SendSessionResult(ctx context.Context, result types.ResidentSessionResult) error {
	frame := map[string]any{
		"type":          residentSessionResultType,
		"operation":     string(result.Kind),
		"requestId":     result.RequestID,
		"ok":            result.OK,
		"error":         string(result.Error),
		"sessions":      result.Sessions,
		"projects":      result.Projects,
		"nextPageToken": result.NextPageToken,
		"hasMore":       result.HasMore,
	}
	if result.Controls != nil {
		frame["controls"] = result.Controls
	}
	payload, err := json.Marshal(frame)
	if err != nil || len(payload) > maxResidentSessionResultBytes {
		fallback, fallbackErr := json.Marshal(map[string]any{
			"type":      residentSessionResultType,
			"operation": string(result.Kind),
			"requestId": result.RequestID,
			"ok":        false,
			"error":     string(types.ResidentSessionErrorUnavailable),
		})
		if fallbackErr != nil {
			return &Error{Message: "encode resident session result", Code: CodeToolError}
		}
		payload = fallback
	}
	if err := s.write(ctx, payload); err != nil {
		return &Error{Message: "resident session result failed", Code: CodeTransient}
	}
	return nil
}

// write is the ONE outbound path for this socket, so the heartbeat ticker and
// a session-control reply can never interleave a frame on the wire.
func (s *residentEventStream) write(ctx context.Context, payload []byte) error {
	if len(payload) > maxResidentEventBytes {
		return &Error{Message: "resident event stream frame exceeds its limit", Code: CodeToolError}
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.conn.Write(ctx, websocket.MessageText, payload)
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
