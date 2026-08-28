// Package free4chat implements the modern-era MCP transport for the
// Free4Chat room endpoint.
//
// The deployed /mcp serves the 2026-07-28 protocol revision only: every
// tools/call carries a per-request _meta envelope (protocol version +
// client capabilities) plus matching Mcp-Method/Mcp-Name headers, and the
// legacy initialize handshake is rejected outright. This client speaks the
// wire format directly over HTTP — the same decision as the Node reference's
// ModernMcpFree4ChatClient.
package free4chat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

const (
	modernProtocolVersion = "2026-07-28"
	defaultEndpoint       = "https://www.free4.chat/mcp"

	// defaultUserAgent identifies the Go runtime client. Cloudflare's bot
	// protection rejects Go's default "Go-http-client/1.1" UA with a 403
	// challenge page, so an explicit product UA is mandatory (the Node
	// reference sent "node" for the same reason).
	defaultUserAgent = "free4chat-agent/0.5.4"

	headerContentType = "application/json"
	headerAccept      = "application/json, text/event-stream"
)

var requiredTools = []string{
	"room_info", "join_room", "create_room", "wait_for_events",
	"send_text", "read_attachment", "leave_room", "update_capabilities",
	"send_collab_request", "send_collab_response", "send_collab_result",
	"send_attachment", "publish_surface", "clear_surface", "read_surface",
}

// lifecycleErrorStrings are server strings that may surface at the HTTP
// layer; seeing one reclassifies the failure for the runtime lifecycle.
var lifecycleErrorStrings = []string{
	string(CodeInvalidParticipantHandle),
	string(CodeRoomExpired),
}

// Client implements types.Free4ChatClient over the modern wire format.
// No session state is kept — every call is self-contained.
type Client struct {
	Endpoint string
	HTTP     *http.Client

	rpcID     int64
	connected bool
}

// New builds a client for the given endpoint (default production).
//
// The HTTP client carries an explicit overall timeout: wait_for_events
// long-polls for up to 25s on the server, so 45s covers the poll plus
// network/CF margins. Without this bound an in-flight poll (or a stalled
// connection) would make runtime Stop/leave unbounded — the CLI observed
// that exact hang during E2E.
func New(endpoint string) *Client {
	if endpoint == "" {
		endpoint = defaultEndpoint
	}
	return &Client{
		Endpoint: endpoint,
		HTTP:     &http.Client{Timeout: 45 * time.Second},
	}
}

func envelopeMeta() map[string]any {
	return map[string]any{
		"io.modelcontextprotocol/protocolVersion":    modernProtocolVersion,
		"io.modelcontextprotocol/clientCapabilities": map[string]any{},
	}
}

// Connect verifies the endpoint answers a modern tools/call with the
// expected tool set.
func (c *Client) Connect() error {
	names, err := c.ListTools()
	if err != nil {
		return err
	}
	present := make(map[string]bool, len(names))
	for _, name := range names {
		present[name] = true
	}
	var missing []string
	for _, required := range requiredTools {
		if !present[required] {
			missing = append(missing, required)
		}
	}
	if len(missing) > 0 {
		return &Error{
			Message: fmt.Sprintf(
				"Free4Chat MCP tool set is incomplete (missing %s)",
				strings.Join(missing, ", ")),
			Code: CodeToolError,
		}
	}
	c.connected = true
	return nil
}

// ListTools issues a stateless tools/list request.
func (c *Client) ListTools() ([]string, error) {
	body := c.envelope("tools/list", map[string]any{})
	raw, err := c.post(body, map[string]string{"Mcp-Method": "tools/list"})
	if err != nil {
		return nil, err
	}
	result, err := asObject(raw)
	if err != nil {
		return nil, err
	}
	tools, _ := result["tools"].([]any)
	names := make([]string, 0, len(tools))
	for _, tool := range tools {
		record, ok := tool.(map[string]any)
		if !ok {
			continue
		}
		name, _ := record["name"].(string)
		names = append(names, name)
	}
	return names, nil
}

func (c *Client) envelope(method string, params map[string]any) map[string]any {
	c.rpcID++
	params["_meta"] = envelopeMeta()
	return map[string]any{
		"jsonrpc": "2.0",
		"id":      c.rpcID,
		"method":  method,
		"params":  params,
	}
}

type rpcResponse struct {
	Error  *rpcError `json:"error"`
	Result any       `json:"result"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// post performs one JSON-RPC POST and decodes either a plain JSON response
// or an SSE stream's last data frame.
func (c *Client) post(body any, extraHeaders map[string]string) (any, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, &Error{Message: err.Error(), Code: CodeTransient}
	}
	request, err := http.NewRequest(http.MethodPost, c.Endpoint, bytes.NewReader(encoded))
	if err != nil {
		return nil, &Error{Message: err.Error(), Code: CodeTransient}
	}
	request.Header.Set("Content-Type", headerContentType)
	request.Header.Set("Accept", headerAccept)
	request.Header.Set("User-Agent", defaultUserAgent)
	for key, value := range extraHeaders {
		request.Header.Set(key, value)
	}

	response, err := c.HTTP.Do(request)
	if err != nil {
		return nil, &Error{Message: err.Error(), Code: CodeTransient}
	}
	defer response.Body.Close()
	text, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, &Error{Message: err.Error(), Code: CodeTransient}
	}
	bodyText := string(text)

	if response.StatusCode < 200 || response.StatusCode > 299 {
		// Lifecycle errors can surface at the HTTP layer; classify them so
		// the runtime rejoin/expiry logic keeps working like Node does.
		for _, known := range lifecycleErrorStrings {
			if strings.Contains(bodyText, known) {
				return nil, &Error{Message: known, Code: ErrorCode(known)}
			}
		}
		return nil, &Error{
			Message: fmt.Sprintf("Free4Chat MCP HTTP %d: %s",
				response.StatusCode, truncate(bodyText, 200)),
			Code: ClassifyHTTPStatus(response.StatusCode),
		}
	}

	contentType := response.Header.Get("Content-Type")
	var payload rpcResponse
	if strings.Contains(contentType, "text/event-stream") {
		last := ""
		for _, line := range strings.Split(bodyText, "\n") {
			line = strings.TrimRight(line, "\r")
			if strings.HasPrefix(line, "data:") {
				last = strings.TrimSpace(line[len("data:"):])
			}
		}
		if last == "" {
			return nil, &Error{
				Message: "Free4Chat MCP SSE response carried no data frame",
				Code:    CodeTransient,
			}
		}
		if err := json.Unmarshal([]byte(last), &payload); err != nil {
			return nil, &Error{Message: err.Error(), Code: CodeTransient}
		}
	} else if err := json.Unmarshal(text, &payload); err != nil {
		return nil, &Error{Message: err.Error(), Code: CodeTransient}
	}

	if payload.Error != nil {
		return nil, &Error{
			Message: fmt.Sprintf("Free4Chat MCP RPC %d: %s",
				payload.Error.Code, payload.Error.Message),
			Code: CodeTransient,
		}
	}
	return payload.Result, nil
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

// rawCall posts tools/call with the mandatory headers and decodes the
// embedded JSON payload from the first text content block.
func (c *Client) rawCall(toolName string, args map[string]any) (map[string]any, error) {
	body := c.envelope("tools/call", map[string]any{
		"name":      toolName,
		"arguments": args,
	})
	raw, err := c.post(body, map[string]string{
		"Mcp-Method": "tools/call",
		"Mcp-Name":   toolName,
	})
	if err != nil {
		return nil, err
	}
	return decodeTextPayload(raw)
}

func (c *Client) callTool(toolName string, args map[string]any) (map[string]any, error) {
	result, err := c.rawCall(toolName, args)
	if err != nil {
		if e, ok := err.(*Error); ok {
			return nil, e
		}
		return nil, &Error{
			Message: fmt.Sprintf("Free4Chat tool %s failed", toolName),
			Code:    CodeTransient,
		}
	}
	return result, nil
}

// RoomInfo returns the sanitized room projection. Only explicit values are
// trusted; anything malformed deactivates grants (fail closed).
func (c *Client) RoomInfo(roomID string) (types.RoomInfo, error) {
	result, err := c.callTool("room_info", map[string]any{"roomId": roomID})
	if err != nil {
		return types.RoomInfo{}, err
	}
	info := types.RoomInfo{Exists: result["exists"] == true}
	if participants, ok := result["participants"].([]any); ok {
		info.Participants = NormalizeRoster(participants)
	}
	info.MeetingNotes = parseGrantState(result["meetingNotes"])
	info.MeetingNotesMediaAvailable = result["meetingNotesMediaAvailable"] == true
	info.VoiceReply = parseVoiceReplyState(result["voiceReply"])
	info.VoiceReplyMediaAvailable = result["voiceReplyMediaAvailable"] == true
	return info, nil
}

func parseGrantState(raw any) types.MeetingNotesInfo {
	record, _ := raw.(map[string]any)
	info := types.MeetingNotesInfo{}
	if record == nil {
		return info
	}
	info.Active = record["active"] == true
	if id, ok := record["agentParticipantId"].(string); ok {
		info.AgentParticipantID = id
	}
	if started, ok := record["startedAt"].(float64); ok {
		info.StartedAt = int64(started)
	}
	return info
}

func parseVoiceReplyState(raw any) types.VoiceReplyInfo {
	record, _ := raw.(map[string]any)
	info := types.VoiceReplyInfo{}
	if record == nil {
		return info
	}
	info.Active = record["active"] == true
	if id, ok := record["agentParticipantId"].(string); ok {
		info.AgentParticipantID = id
	}
	if started, ok := record["startedAt"].(float64); ok {
		info.StartedAt = int64(started)
	}
	return info
}

func parseJoinLike(result map[string]any) (types.JoinResult, error) {
	handle, handleOK := result["participantHandle"].(string)
	participant, _ := result["participant"].(map[string]any)
	participantID, idOK := "", false
	if participant != nil {
		participantID, idOK = participant["id"].(string)
	}
	cursor, err := requiredNumber(result, "cursor")
	if err != nil {
		return types.JoinResult{}, err
	}
	expiresAt, err := requiredNumber(result, "expiresAt")
	if err != nil {
		return types.JoinResult{}, err
	}
	if !handleOK || handle == "" || !idOK || participantID == "" {
		return types.JoinResult{}, &Error{
			Message: "Free4Chat returned an invalid join result",
			Code:    CodeToolError,
		}
	}
	return types.JoinResult{
		ParticipantID:     participantID,
		ParticipantHandle: handle,
		Cursor:            cursor,
		ExpiresAt:         expiresAt,
	}, nil
}

// JoinRoom joins an existing room and returns the new capability set.
// host optionally carries the #176 Phase A Runtime Host projection; the
// payload omits it entirely for legacy callers.
func (c *Client) JoinRoom(roomID, name string, capabilities []string, host *types.RuntimeHostProjection) (types.JoinResult, error) {
	args := map[string]any{"roomId": roomID, "name": name}
	if len(capabilities) > 0 {
		args["capabilities"] = capabilities
	}
	if host != nil {
		args["runtimeHost"] = *host
	}
	result, err := c.callTool("join_room", args)
	if err != nil {
		return types.JoinResult{}, err
	}
	return parseJoinLike(result)
}

// CreateRoom creates a fresh room registering this agent as participant #1
// and validates the returned public invite shape.
func (c *Client) CreateRoom(name string, capabilities []string, host *types.RuntimeHostProjection) (types.CreateRoomResult, error) {
	args := map[string]any{"name": name}
	if len(capabilities) > 0 {
		args["capabilities"] = capabilities
	}
	if host != nil {
		args["runtimeHost"] = *host
	}
	result, err := c.callTool("create_room", args)
	if err != nil {
		return types.CreateRoomResult{}, err
	}
	if err := validateInvite(result["invite"]); err != nil {
		return types.CreateRoomResult{}, err
	}
	joined, err := parseJoinLike(result)
	if err != nil {
		return types.CreateRoomResult{}, err
	}
	invite := result["invite"].(map[string]any)
	return types.CreateRoomResult{
		JoinResult: joined,
		Invite: types.RoomInviteDescriptorV1{
			Kind:    "free4chat.room-invite",
			Version: 1,
			RoomID:  invite["roomId"].(string),
			RoomURL: invite["roomUrl"].(string),
		},
	}, nil
}

// UpdateRuntimeHost re-projects the #176 Phase A Runtime Host capability
// projection for this participant (speech hot reload path).
func (c *Client) UpdateRuntimeHost(participantHandle string, host types.RuntimeHostProjection) error {
	_, err := c.callTool("update_runtime_host", map[string]any{
		"participantHandle": participantHandle,
		"runtimeHost":       host,
	})
	return err
}

// WaitForEvents long-polls room events; it doubles as the lease heartbeat.
func (c *Client) WaitForEvents(participantHandle string, cursor int64, timeoutSeconds int) (types.WaitResult, error) {
	result, err := c.callTool("wait_for_events", map[string]any{
		"participantHandle": participantHandle,
		"cursor":            cursor,
		"timeoutSeconds":    timeoutSeconds,
	})
	if err != nil {
		return types.WaitResult{}, err
	}
	wait := types.WaitResult{}
	events, err := parseRoomEvents(result["events"])
	if err != nil {
		return types.WaitResult{}, err
	}
	wait.Events = events
	if wait.Cursor, err = requiredNumber(result, "cursor"); err != nil {
		return types.WaitResult{}, err
	}
	if wait.ExpiresAt, err = requiredNumber(result, "expiresAt"); err != nil {
		return types.WaitResult{}, err
	}
	if participants, ok := result["participants"].([]any); ok {
		wait.Participants = NormalizeRoster(participants)
	}
	return wait, nil
}

// SendText publishes one agent message. targetParticipantIDs optionally
// carries explicit addressing (#165); when empty the tool payload is
// byte-identical to the pre-#165 ordinary unaddressed send.
func (c *Client) SendText(participantHandle, text string, targetParticipantIDs []string) (types.SendTextResult, error) {
	args := map[string]any{
		"participantHandle": participantHandle,
		"text":              text,
	}
	if len(targetParticipantIDs) > 0 {
		args["targetParticipantIds"] = targetParticipantIDs
	}
	result, err := c.callTool("send_text", args)
	if err != nil {
		return types.SendTextResult{}, err
	}
	sequence, err := requiredNumber(result, "sequence")
	if err != nil {
		return types.SendTextResult{}, err
	}
	return types.SendTextResult{Sequence: sequence}, nil
}

// ReadAttachment fetches one ephemeral attachment copy: images ride an
// ImageContent block; text-like attachments ride the standard JSON envelope
// { attachment, data, text } and are returned decoded as UTF-8 by the server.
func (c *Client) ReadAttachment(participantHandle, attachmentID string) (types.AttachmentRead, error) {
	raw, err := c.post(c.envelope("tools/call", map[string]any{
		"name": "read_attachment",
		"arguments": map[string]any{
			"participantHandle": participantHandle,
			"attachmentId":      attachmentID,
		},
	}), map[string]string{
		"Mcp-Method": "tools/call",
		"Mcp-Name":   "read_attachment",
	})
	if err != nil {
		return types.AttachmentRead{}, err
	}
	result, err := asObject(raw)
	if err != nil {
		return types.AttachmentRead{}, err
	}
	if isError, _ := result["isError"].(bool); isError {
		if _, err := decodeTextPayload(raw); err != nil {
			return types.AttachmentRead{}, err
		}
		return types.AttachmentRead{}, &Error{
			Message: "Free4Chat attachment read failed",
			Code:    CodeToolError,
		}
	}
	content, _ := result["content"].([]any)
	for _, item := range content {
		block, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if blockType, _ := block["type"].(string); blockType == "image" {
			data, _ := block["data"].(string)
			mimeType, _ := block["mimeType"].(string)
			return types.AttachmentRead{Data: data, MimeType: mimeType}, nil
		}
	}
	for _, item := range content {
		block, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if blockType, _ := block["type"].(string); blockType != "text" {
			continue
		}
		text, _ := block["text"].(string)
		var payload struct {
			Data       string `json:"data"`
			Text       string `json:"text"`
			Attachment struct {
				MimeType string `json:"mimeType"`
			} `json:"attachment"`
		}
		if json.Unmarshal([]byte(text), &payload) != nil {
			continue
		}
		if payload.Text != "" {
			return types.AttachmentRead{
				Data:     payload.Data,
				MimeType: payload.Attachment.MimeType,
				Text:     payload.Text,
			}, nil
		}
	}
	return types.AttachmentRead{}, &Error{
		Message: "Free4Chat returned no image content",
		Code:    CodeToolError,
	}
}

// LeaveRoom releases the participant lease explicitly.
func (c *Client) LeaveRoom(participantHandle string) error {
	_, err := c.callTool("leave_room", map[string]any{"participantHandle": participantHandle})
	return err
}

// UpdateCapabilities replaces this agent's advertised tokens in place.
func (c *Client) UpdateCapabilities(participantHandle string, capabilities []string) error {
	_, err := c.callTool("update_capabilities", map[string]any{
		"participantHandle": participantHandle,
		"capabilities":      capabilities,
	})
	return err
}

// SendCollabRequest targets one peer with a structured collaboration request.
func (c *Client) SendCollabRequest(participantHandle string, args types.CollabRequestArgs) (types.CollabRequestOutcome, error) {
	payload := map[string]any{
		"participantHandle":   participantHandle,
		"targetParticipantId": args.TargetParticipantID,
		"summary":             args.Summary,
	}
	if args.RequestID != "" {
		payload["requestId"] = args.RequestID
	}
	if len(args.Details) > 0 {
		payload["details"] = args.Details
	}
	if len(args.AttachmentIDs) > 0 {
		payload["attachmentIds"] = args.AttachmentIDs
	}
	result, err := c.callTool("send_collab_request", payload)
	if err != nil {
		return types.CollabRequestOutcome{}, err
	}
	outcome := types.CollabRequestOutcome{RequestID: stringOrEmpty(result["requestId"])}
	if outcome.Sequence, err = requiredNumber(result, "sequence"); err != nil {
		return types.CollabRequestOutcome{}, err
	}
	outcome.Duplicate = result["duplicate"] == true
	return outcome, nil
}

// SendCollabResponse answers someone else's request targeting us.
func (c *Client) SendCollabResponse(participantHandle string, args types.CollabResponseArgs) (types.SendTextResult, error) {
	payload := map[string]any{
		"participantHandle": participantHandle,
		"requestId":         args.RequestID,
		"decision":          args.Decision,
	}
	if args.Summary != "" {
		payload["summary"] = args.Summary
	}
	return sendSequence(c, "send_collab_response", payload)
}

// SendCollabResult publishes the structured outcome of accepted work.
func (c *Client) SendCollabResult(participantHandle string, args types.CollabResultArgs) (types.SendTextResult, error) {
	payload := map[string]any{
		"participantHandle": participantHandle,
		"requestId":         args.RequestID,
		"status":            args.Status,
		"summary":           args.Summary,
	}
	if len(args.Details) > 0 {
		payload["details"] = args.Details
	}
	if len(args.AttachmentIDs) > 0 {
		payload["attachmentIds"] = args.AttachmentIDs
	}
	return sendSequence(c, "send_collab_result", payload)
}

func sendSequence(c *Client, tool string, payload map[string]any) (types.SendTextResult, error) {
	result, err := c.callTool(tool, payload)
	if err != nil {
		return types.SendTextResult{}, err
	}
	sequence, err := requiredNumber(result, "sequence")
	if err != nil {
		return types.SendTextResult{}, err
	}
	return types.SendTextResult{Sequence: sequence}, nil
}

// UploadAttachment stores an artifact in the room's ephemeral attachment store.
func (c *Client) UploadAttachment(participantHandle string, file types.AttachmentUpload) (types.UploadedAttachment, error) {
	result, err := c.callTool("send_attachment", map[string]any{
		"participantHandle": participantHandle,
		"fileName":          file.FileName,
		"mimeType":          file.MimeType,
		"dataBase64":        file.DataBase64,
	})
	if err != nil {
		return types.UploadedAttachment{}, err
	}
	attachment, _ := result["attachment"].(map[string]any)
	if attachment == nil {
		return types.UploadedAttachment{}, &Error{
			Message: "Free4Chat returned an invalid attachment",
			Code:    CodeToolError,
		}
	}
	size, err := requiredNumber(attachment, "size")
	if err != nil {
		return types.UploadedAttachment{}, err
	}
	sequence, err := requiredNumber(attachment, "sequence")
	if err != nil {
		return types.UploadedAttachment{}, err
	}
	id, _ := attachment["id"].(string)
	fileName, _ := attachment["fileName"].(string)
	if fileName == "" {
		fileName = file.FileName
	}
	mimeType, _ := attachment["mimeType"].(string)
	if mimeType == "" {
		mimeType = file.MimeType
	}
	return types.UploadedAttachment{
		RoomAttachmentMetadata: types.RoomAttachmentMetadata{
			ID:       id,
			FileName: fileName,
			MimeType: mimeType,
			Size:     size,
		},
		Sequence: sequence,
	}, nil
}

// PublishSurface publishes or replaces this agent's single workspace snapshot.
func (c *Client) PublishSurface(participantHandle string, payload types.SurfacePublishPayload) (types.RoomSurfaceMetadataV1, error) {
	result, err := c.callTool("publish_surface", map[string]any{
		"participantHandle": participantHandle,
		"mimeType":          payload.MimeType,
		"dataBase64":        payload.DataBase64,
	})
	if err != nil {
		return types.RoomSurfaceMetadataV1{}, err
	}
	surface := ParseSurfaceMetadataStrict(result["surface"])
	if surface == nil {
		return types.RoomSurfaceMetadataV1{}, &Error{
			Message: "Free4Chat returned an invalid surface payload",
			Code:    CodeToolError,
		}
	}
	return *surface, nil
}

// ClearSurface removes the published snapshot.
func (c *Client) ClearSurface(participantHandle string) error {
	_, err := c.callTool("clear_surface", map[string]any{"participantHandle": participantHandle})
	return err
}

// ReadSurface reads exactly the requested snapshot, cross-checking the
// returned bytes against the strict metadata (#111 review).
func (c *Client) ReadSurface(participantHandle, sourceParticipantID, snapshotID string) (types.SurfaceReadResult, error) {
	raw, err := c.post(c.envelope("tools/call", map[string]any{
		"name": "read_surface",
		"arguments": map[string]any{
			"participantHandle":   participantHandle,
			"sourceParticipantId": sourceParticipantID,
			"snapshotId":          snapshotID,
		},
	}), map[string]string{
		"Mcp-Method": "tools/call",
		"Mcp-Name":   "read_surface",
	})
	if err != nil {
		return types.SurfaceReadResult{}, err
	}
	result, err := asObject(raw)
	if err != nil {
		return types.SurfaceReadResult{}, err
	}
	if isError, _ := result["isError"].(bool); isError {
		if _, decodeErr := decodeTextPayload(raw); decodeErr != nil {
			return types.SurfaceReadResult{}, decodeErr
		}
		return types.SurfaceReadResult{}, &Error{
			Message: "Free4Chat surface read failed",
			Code:    CodeToolError,
		}
	}
	content, _ := result["content"].([]any)
	var data, blockMimeType string
	for _, item := range content {
		block, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if blockType, _ := block["type"].(string); blockType == "image" {
			data, _ = block["data"].(string)
			blockMimeType, _ = block["mimeType"].(string)
		}
	}
	if data == "" || blockMimeType == "" {
		return types.SurfaceReadResult{}, &Error{
			Message: "Free4Chat returned no image content for the surface",
			Code:    CodeToolError,
		}
	}
	// Metadata rides the trailing text envelope; fall back to the image
	// block's own MIME when absent.
	metadataRaw := map[string]any{"mimeType": blockMimeType}
	for _, item := range content {
		block, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if blockType, _ := block["type"].(string); blockType != "text" {
			continue
		}
		text, _ := block["text"].(string)
		var parsed struct {
			Surface map[string]any `json:"surface"`
		}
		if json.Unmarshal([]byte(text), &parsed) == nil && parsed.Surface != nil {
			metadataRaw = parsed.Surface
		}
	}
	strict := ParseSurfaceMetadataStrict(mergeSurfaceDefaults(metadataRaw, blockMimeType))
	if strict == nil {
		return types.SurfaceReadResult{}, &Error{
			Message: "Free4Chat returned an invalid surface payload",
			Code:    CodeToolError,
		}
	}
	if strict.SnapshotID != snapshotID {
		return types.SurfaceReadResult{}, &Error{
			Message: "Free4Chat returned a different snapshot than requested",
			Code:    CodeToolError,
		}
	}
	if strict.MimeType != blockMimeType {
		return types.SurfaceReadResult{}, &Error{
			Message: "Free4Chat returned mismatched surface content type",
			Code:    CodeToolError,
		}
	}
	return types.SurfaceReadResult{Surface: *strict, Data: data}, nil
}

// mergeSurfaceDefaults fills in the strict-parser-required fields when the
// metadata envelope omits them.
func mergeSurfaceDefaults(metadata map[string]any, blockMimeType string) map[string]any {
	merged := map[string]any{
		"kind":      "workspace-snapshot",
		"mimeType":  blockMimeType,
		"size":      float64(-1), // invalid unless overridden below
		"updatedAt": float64(-1), // invalid unless overridden below
	}
	if metadata["mimeType"] != nil {
		merged["mimeType"] = metadata["mimeType"]
	}
	for _, field := range []string{"snapshotId", "size", "updatedAt"} {
		if metadata[field] != nil {
			merged[field] = metadata[field]
		}
	}
	return merged
}

// Close has no persistent session to tear down.
func (c *Client) Close() error {
	c.connected = false
	return nil
}

func stringOrEmpty(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", v)
	}
}
