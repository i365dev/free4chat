// Package types defines the core contracts shared across the Go Agent
// Runtime: room wire events, Harness turn inputs/results, and the
// Free4Chat client interface.
//
// Ported from the frozen Node reference (tag node-agent-runtime-e2e-2026-08-27,
// src/types.ts) preserving product/security semantics, not TypeScript shape.
package types

// LauncherMaturity mirrors the Node launcher maturity classification.
type LauncherMaturity string

const (
	MaturityNative  LauncherMaturity = "native"
	MaturityBridge  LauncherMaturity = "bridge"
	MaturityPreview LauncherMaturity = "preview"
)

// LauncherSecurity mirrors the Node security classification. Every built-in
// launcher stays "trusted-room"/experimental until a verified restricted
// mode exists: ACP is a control protocol, not a sandbox.
type LauncherSecurity string

const (
	SecurityTrustedRoom LauncherSecurity = "trusted-room"
	SecurityUnverified  LauncherSecurity = "unverified"
)

// AgentLauncher describes one local ACP Harness process recipe.
type AgentLauncher struct {
	ID          string           `json:"id"`
	DisplayName string           `json:"displayName"`
	Command     string           `json:"command"`
	Args        []string         `json:"args"`
	Maturity    LauncherMaturity `json:"maturity"`
	Security    LauncherSecurity `json:"security"`
	Notes       string           `json:"notes,omitempty"`
	// Environment holds explicit launch-time overrides for this trusted
	// launcher (e.g. Codex read-only mode).
	Environment map[string]string `json:"-"`
}

// HarnessCapabilities reports what the negotiated Harness session supports.
type HarnessCapabilities struct {
	Text   bool
	Images bool
	Resume bool
}

// RoomAttachmentMetadata is the sanitized attachment projection carried on
// room events and upload results.
type RoomAttachmentMetadata struct {
	ID       string `json:"id"`
	FileName string `json:"fileName"`
	MimeType string `json:"mimeType"`
	Size     int64  `json:"size"`
}

// CollabKind enumerates the collaboration envelope kinds (#106 Phase B).
type CollabKind string

const (
	CollabRequest  CollabKind = "request"
	CollabAccepted CollabKind = "accepted"
	CollabDeclined CollabKind = "declined"
	CollabComplete CollabKind = "completed"
	CollabFailed   CollabKind = "failed"
)

// WireCollabEvent is the structured collaboration envelope riding an action
// message with actionType "collab".
type WireCollabEvent struct {
	RequestID           string            `json:"requestId"`
	Kind                CollabKind        `json:"kind"`
	FromParticipantID   string            `json:"fromParticipantId"`
	TargetParticipantID string            `json:"targetParticipantId"`
	Summary             string            `json:"summary,omitempty"`
	Details             map[string]string `json:"details,omitempty"`
	AttachmentIDs       []string          `json:"attachmentIds,omitempty"`
}

// ParticipantKind distinguishes humans from agents on the wire.
type ParticipantKind string

const (
	KindHuman ParticipantKind = "human"
	KindAgent ParticipantKind = "agent"
)

// RoomEvent is one room event delivered through wait_for_events.
type RoomEvent struct {
	Sequence      int64                   `json:"sequence"`
	Type          string                  `json:"type"` // text | action | image
	Participant   ParticipantIdentity     `json:"participant"`
	Text          string                  `json:"text,omitempty"`
	ActionType    string                  `json:"actionType,omitempty"`
	ActionPayload map[string]string       `json:"actionPayload,omitempty"`
	Collab        *WireCollabEvent        `json:"collab,omitempty"`
	Attachment    *RoomAttachmentMetadata `json:"attachment,omitempty"`
	Addressed     bool                    `json:"addressed"`
	CreatedAt     int64                   `json:"createdAt"`

	// Runtime-enriched fields set by attachment enrichment before the event
	// reaches the Harness (never present in raw server payloads).

	// TextFile carries decoded UTF-8 content of a text-like attachment,
	// size-capped before it ever reaches the Harness.
	TextFile *TextFileContent `json:"textFile,omitempty"`
	// Image carries a bounded ephemeral base64 image copy decoded by the
	// runtime via read_attachment.
	Image *HarnessImage `json:"image,omitempty"`
}

// TextFileContent is the bounded inline text-file view of an attachment.
type TextFileContent struct {
	FileName string
	MimeType string
	Content  string
}

// HarnessImage is a base64 image block supplied to image-capable Harnesses.
type HarnessImage struct {
	Data     string
	MimeType string
}

// ParticipantIdentity is the public identity attached to every event.
type ParticipantIdentity struct {
	ID   string          `json:"id"`
	Name string          `json:"name"`
	Kind ParticipantKind `json:"kind"`
}

// RoomSurfaceMetadataV1 is the sanitized workspace-snapshot metadata
// projection (#111). Never bytes or capture sources.
type RoomSurfaceMetadataV1 struct {
	SnapshotID string `json:"snapshotId"`
	MimeType   string `json:"mimeType"`
	Size       int64  `json:"size"`
	UpdatedAt  int64  `json:"updatedAt"`
}

// ParticipantRosterEntry is one sanitized roster entry: identity, kind, and
// self-advertised capability tokens only.
type ParticipantRosterEntry struct {
	ID         string                 `json:"id"`
	Name       string                 `json:"name"`
	Kind       ParticipantKind        `json:"kind"`
	Advertised []string               `json:"advertised,omitempty"`
	Surface    *RoomSurfaceMetadataV1 `json:"surface,omitempty"`
}

// CollabEventView is the Harness-facing collaboration view: the wire
// envelope plus a resolved fromName so the recipient never parses prose or
// joins rosters itself.
type CollabEventView struct {
	WireCollabEvent
	FromName string `json:"fromName"`
}

// HarnessEvent is a single normalized event inside a Harness turn input.
type HarnessEvent struct {
	Sender        string                  `json:"sender"`
	Kind          ParticipantKind         `json:"kind"`
	Text          string                  `json:"text,omitempty"`
	ActionType    string                  `json:"actionType,omitempty"`
	ActionPayload map[string]string       `json:"actionPayload,omitempty"`
	Collab        *CollabEventView        `json:"collab,omitempty"`
	Addressed     bool                    `json:"addressed"`
	Attachment    *RoomAttachmentMetadata `json:"attachment,omitempty"`
	Image         *HarnessImage           `json:"image,omitempty"`
	TextFile      *TextFileContent        `json:"textFile,omitempty"`
	Sequence      int64                   `json:"sequence"`
	CreatedAt     int64                   `json:"createdAt"`
}

// RoomSelfContext tells the Harness who it is for this room. It never
// contains the participant capability handle.
type RoomSelfContext struct {
	InstanceID    string   `json:"instanceId"`
	ParticipantID string   `json:"participantId,omitempty"`
	Name          string   `json:"name"`
	Capabilities  []string `json:"capabilities,omitempty"`
}

// RoomTurnContext is the stable per-room context injected into every turn.
type RoomTurnContext struct {
	Ephemeral    bool                     `json:"ephemeral"`
	Self         *RoomSelfContext         `json:"self,omitempty"`
	Participants []ParticipantRosterEntry `json:"participants,omitempty"`
}

// HarnessTurnInput is the bounded, untrusted-safe context handed to the
// Harness for one addressed turn. It never contains the participant handle.
type HarnessTurnInput struct {
	Room   RoomTurnContext `json:"room"`
	Events []HarnessEvent  `json:"events"`
}

// HarnessTurnResult is what the Harness produced for a turn.
type HarnessTurnResult struct {
	Text string
}

// AdapterFailureHandler is invoked when the Harness process dies unexpectedly.
type AdapterFailureHandler func(error)

// HarnessAdapter is the real boundary between room turns and the local
// Harness process (ACP).
type HarnessAdapter interface {
	Name() string
	Capabilities() *HarnessCapabilities
	EnsureSession() error
	RunTurn(input HarnessTurnInput) (HarnessTurnResult, error)
	OnFailure(handler AdapterFailureHandler)
	CancelTurn() error
	Close() error
}

// JoinResult is what join_room returns; the participantHandle is the bearer
// capability kept strictly inside the runtime.
type JoinResult struct {
	ParticipantID     string
	ParticipantHandle string // secret; never logged, prompted, or surfaced
	Cursor            int64
	ExpiresAt         int64
}

// RoomInviteDescriptorV1 is the portable public invite descriptor (#51).
// Safe to hand to any Agent or Human over an existing channel.
type RoomInviteDescriptorV1 struct {
	Kind    string `json:"kind"`
	Version int    `json:"version"`
	RoomID  string `json:"roomId"`
	RoomURL string `json:"roomUrl"`
}

// CreateRoomResult is create_room's result extended with the public invite.
type CreateRoomResult struct {
	JoinResult
	Invite RoomInviteDescriptorV1
}

// MeetingNotesInfo is the room-visible grant state; it is public room state,
// not a capability secret.
type MeetingNotesInfo struct {
	Active             bool   `json:"active"`
	AgentParticipantID string `json:"agentParticipantId,omitempty"`
	StartedAt          int64  `json:"startedAt,omitempty"`
}

// VoiceReplyInfo is the room-visible voiceReply grant state (#83).
type VoiceReplyInfo struct {
	Active             bool   `json:"active"`
	AgentParticipantID string `json:"agentParticipantId,omitempty"`
	StartedAt          int64  `json:"startedAt,omitempty"`
}

// RoomInfo is the sanitized room_info projection. It never contains tokens,
// connection nonces, SFU session/track identifiers, or message history.
type RoomInfo struct {
	Exists       bool                     `json:"exists"`
	Participants []ParticipantRosterEntry `json:"participants,omitempty"`
	MeetingNotes MeetingNotesInfo         `json:"meetingNotes"`
	// Fail closed: only explicit true counts. Media is PR 2 scope in the Go
	// runtime; these fields remain part of the transport contract.
	MeetingNotesMediaAvailable bool           `json:"meetingNotesMediaAvailable"`
	VoiceReply                 VoiceReplyInfo `json:"voiceReply"`
	VoiceReplyMediaAvailable   bool           `json:"voiceReplyMediaAvailable"`
}

// WaitResult is wait_for_events' long-poll result with the advanced cursor.
type WaitResult struct {
	Events       []RoomEvent
	Cursor       int64
	ExpiresAt    int64
	Participants []ParticipantRosterEntry
}

// CollabRequestArgs are the arguments for send_collab_request.
type CollabRequestArgs struct {
	TargetParticipantID string
	Summary             string
	RequestID           string
	Details             map[string]string
	AttachmentIDs       []string
}

// CollabRequestOutcome is send_collab_request's reply. Duplicate marks a
// replay of an already-known requestId (dedup semantics preserved end-to-end).
type CollabRequestOutcome struct {
	RequestID string
	Sequence  int64
	Duplicate bool
}

// CollabResponseArgs are the arguments for send_collab_response.
type CollabResponseArgs struct {
	RequestID string
	Decision  string // accepted | declined
	Summary   string
}

// CollabResultArgs are the arguments for send_collab_result.
type CollabResultArgs struct {
	RequestID     string
	Status        string // completed | failed
	Summary       string
	Details       map[string]string
	AttachmentIDs []string
}

// AttachmentUpload is a caller-provided file for send_attachment.
type AttachmentUpload struct {
	FileName   string
	MimeType   string
	DataBase64 string
}

// UploadedAttachment is the stored attachment metadata; the ID is what a
// collaboration result references via --attach.
type UploadedAttachment struct {
	RoomAttachmentMetadata
	Sequence int64 `json:"sequence"`
}

// SurfacePublishPayload is publish_surface's body.
type SurfacePublishPayload struct {
	MimeType   string
	DataBase64 string
}

// SurfaceReadResult is read_surface's validated result. Data is valid only
// for the exact requested snapshot ID.
type SurfaceReadResult struct {
	Surface RoomSurfaceMetadataV1
	Data    string // base64 image bytes
}

// SendTextResult is send_text's reply.
type SendTextResult struct {
	Sequence int64 `json:"sequence"`
}

// Free4ChatClient is the real external MCP transport boundary used by the
// resident runtime. The participantHandle parameter is the bearer capability
// and implementations must keep it out of logs and error surfaces.
type Free4ChatClient interface {
	Connect() error
	ListTools() ([]string, error)
	RoomInfo(roomID string) (RoomInfo, error)
	JoinRoom(roomID, name string, capabilities []string) (JoinResult, error)
	CreateRoom(name string, capabilities []string) (CreateRoomResult, error)
	WaitForEvents(participantHandle string, cursor int64, timeoutSeconds int) (WaitResult, error)
	SendText(participantHandle, text string) (SendTextResult, error)
	ReadAttachment(participantHandle, attachmentID string) (AttachmentRead, error)
	UpdateCapabilities(participantHandle string, capabilities []string) error
	SendCollabRequest(participantHandle string, args CollabRequestArgs) (CollabRequestOutcome, error)
	SendCollabResponse(participantHandle string, args CollabResponseArgs) (SendTextResult, error)
	SendCollabResult(participantHandle string, args CollabResultArgs) (SendTextResult, error)
	UploadAttachment(participantHandle string, file AttachmentUpload) (UploadedAttachment, error)
	PublishSurface(participantHandle string, payload SurfacePublishPayload) (RoomSurfaceMetadataV1, error)
	ClearSurface(participantHandle string) error
	ReadSurface(participantHandle, sourceParticipantID, snapshotID string) (SurfaceReadResult, error)
	LeaveRoom(participantHandle string) error
	Close() error
}

// AttachmentRead is read_attachment's normalized result: either an image
// payload or a decoded text-like attachment copy.
type AttachmentRead struct {
	Data     string // base64 for images
	MimeType string
	Text     string // present only for text-like attachments
}
