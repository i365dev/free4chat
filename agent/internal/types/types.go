// Package types defines the core contracts shared across the Go Agent
// Runtime: room wire events, Harness turn inputs/results, and the
// Free4Chat client interface.
//
// Ported from the frozen Node reference (tag node-agent-runtime-e2e-2026-08-27,
// src/types.ts) preserving product/security semantics, not TypeScript shape.
package types

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
)

const runtimeProviderClaimDomain = "free4chat-runtime-provider-v1"

// MaxLogicalTaskScopes bounds the resident-local non-Room cognition
// conversations retained by one Agent process. It is a safety limit for this
// spike, not a product entitlement or a task lifecycle policy.
const MaxLogicalTaskScopes = 8

// MaxLogicalScopeLength bounds the opaque scope label carried by the narrow
// Agent wire projection. Producers must reject longer labels rather than
// silently rewriting them into the ordinary Room scope.
const MaxLogicalScopeLength = 128

// MaxLogicalSourceCursors bounds the source-local checkpoints retained per
// logical scope. Current producers are a small fixed set; this keeps an
// accidental arbitrary source label from becoming another unbounded map.
const MaxLogicalSourceCursors = 8

// ValidRuntimeProviderCredential accepts an opaque 256-bit base64url value.
// It is deliberately distinct from the public Runtime Host id grammar.
func ValidRuntimeProviderCredential(value string) bool {
	if len(value) != 43 {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size
}

// DeriveRuntimeProviderClaimHash is the cross-language Phase-B claim
// derivation. The raw secret is used only in the local Runtime, never in
// Room state, status, diagnostics, or a Harness prompt.
func DeriveRuntimeProviderClaimHash(roomID, secret string) (string, error) {
	if roomID == "" || len(roomID) > 64 || !ValidRuntimeProviderCredential(secret) {
		return "", errors.New("runtime provider claim is malformed")
	}
	material := runtimeProviderClaimDomain + "\x00" + roomID + "\x00" + secret
	digest := sha256.Sum256([]byte(material))
	return base64.RawURLEncoding.EncodeToString(digest[:]), nil
}

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
	// TaskSessionContinuation is the ONE centralized product-level support
	// policy for Task Session Continuation (#409): may a Human continue one of
	// this Harness's existing native sessions from the Room Start Task surface?
	//
	// It is deliberately NOT derived from ACP capability advertisement.
	// `sessionCapabilities.list` + `loadSession` only say the bridge implements
	// two methods: the #409 spike proved OpenCode and Hermes advertise both and
	// still cannot continue a native session, while Pi was verified end-to-end.
	// Support is therefore a named product decision recorded here, next to the
	// launcher it describes, and nowhere else.
	//
	//	pi   true  (verified end-to-end)
	//	...  false until that exact native-CLI -> ACP continuation path is
	//	           verified for the pinned bridge, then only this flag changes
	//
	// Enabling a Harness later is: flip this flag + add its provider-specific
	// regression/probe. It is never a UI, Room-protocol, or Runtime redesign.
	//
	// This flag is presentation/discovery policy only, and is therefore NEVER
	// authorization: the Room still validates the current resident socket and
	// the Human's Task ownership, and the Runtime re-checks this policy before
	// it lists or prepares anything.
	TaskSessionContinuation bool `json:"taskSessionContinuation,omitempty"`
	// SessionListGlobalCwd declares how THIS bridge expresses "no cwd filter"
	// on the session/list wire.
	//
	// ACP makes `cwd` optional, but bridges disagree about what omission
	// MEANS. Verified against the pinned bridge while dogfooding:
	//
	//	pi-acp@0.0.33
	//	  const effectiveCwd = params.cwd ?? this.lastSessionCwd
	//	  const filtered = effectiveCwd ? all.filter(s => s.cwd === effectiveCwd) : all
	//
	// so an OMITTED cwd silently resolves to that bridge's own last session
	// cwd (the Runtime's disposable workspace), while an explicitly EMPTY
	// string is what actually means "every project". Recorded here, next to
	// the launcher it describes, because it is a property of the pinned bridge
	// and nothing else in Free4Chat may branch on a Harness identity.
	SessionListGlobalCwd LauncherSessionListGlobalCwd `json:"sessionListGlobalCwd,omitempty"`
	// TaskExecution is the ONE centralized product-level EXECUTION policy for
	// this Harness (#421): how many of its retained conversations may make
	// progress at the same time.
	//
	// It is deliberately NOT derived from ACP capability advertisement. ACP
	// advertising multiple sessions says nothing about whether the provider
	// safely serves concurrent prompts; the #421 probes showed every pinned
	// bridge accepts a second concurrent `session/prompt`, but only Pi was
	// additionally verified for conversation isolation, exact cancel
	// isolation, per-session crash isolation, and stream routing. Support is
	// therefore a named product decision recorded here, next to the launcher
	// it describes, and nowhere else.
	//
	// The zero value is the fail-safe default: serial, one lane. Enabling a
	// Harness later is: run its provider probe, change this value, add its
	// provider-specific regression. It is never a Room, UI, or Runtime
	// redesign.
	TaskExecution TaskExecutionPolicy `json:"taskExecution,omitempty"`
}

// TaskExecutionConcurrency is the closed cross-session concurrency capability
// of one Harness: may two DIFFERENT retained conversations of this Harness
// execute a turn at the same time?
//
// It never relaxes the hard invariant that ONE retained conversation executes
// at most one turn at a time: that is enforced independently, at the adapter,
// by native session identity.
type TaskExecutionConcurrency string

const (
	// TaskExecutionSerial is the fail-safe default. Independent conversations
	// still queue behind one another.
	TaskExecutionSerial TaskExecutionConcurrency = "serial"
	// TaskExecutionCrossSession permits a small bounded number of independent
	// conversations to execute concurrently. It requires a real probe.
	TaskExecutionCrossSession TaskExecutionConcurrency = "cross-session"
)

func (c TaskExecutionConcurrency) Valid() bool {
	return c == TaskExecutionSerial || c == TaskExecutionCrossSession
}

// TaskExecutionProbe is the EVIDENCE label behind a TaskExecutionPolicy. It is
// documentation that travels with the decision so a later reader can tell a
// measured capability from an assumption. It is never read by behavior.
type TaskExecutionProbe string

const (
	// TaskExecutionProbeVerifiedCrossSession means the pinned bridge passed
	// the full #421 probe suite: concurrent prompts on two sessions with
	// correct stream routing, isolated conversation memory, exact cancel
	// isolation, and per-session crash isolation.
	TaskExecutionProbeVerifiedCrossSession TaskExecutionProbe = "verified-cross-session"
	// TaskExecutionProbeConcurrencyObserved means concurrent cross-session
	// prompts with correct stream routing were measured, but the rest of the
	// isolation suite has not been run for this bridge yet. It is explicitly
	// NOT sufficient to enable cross-session execution.
	TaskExecutionProbeConcurrencyObserved TaskExecutionProbe = "concurrency-observed"
	// TaskExecutionProbeUnverified means no concurrency evidence exists:
	// either the probe could not authenticate, or the Harness was never
	// probed.
	TaskExecutionProbeUnverified TaskExecutionProbe = "unverified"
)

// TaskExecutionPolicy is the closed execution policy of one Harness.
type TaskExecutionPolicy struct {
	// Probe is the evidence label. It never changes behavior; it exists so a
	// policy can be reviewed against the measurement that justified it.
	Probe TaskExecutionProbe `json:"probe,omitempty"`
	// Concurrency is serial or cross-session. Empty means serial.
	Concurrency TaskExecutionConcurrency `json:"concurrency,omitempty"`
	// MaxConcurrent is the product bound on simultaneously executing turns
	// for this Harness. Zero (or any value below one) means one lane.
	MaxConcurrent int `json:"maxConcurrent,omitempty"`
}

// Lanes reports the bounded number of execution lanes this policy allows. It
// is always at least one: every Harness can run a turn.
func (p TaskExecutionPolicy) Lanes() int {
	if p.Concurrency != TaskExecutionCrossSession {
		return 1
	}
	if p.MaxConcurrent < 1 {
		return 1
	}
	return p.MaxConcurrent
}

// LauncherSessionListGlobalCwd is the closed set of "no cwd filter" spellings.
type LauncherSessionListGlobalCwd string

const (
	// GlobalSessionListCwdOmitted is the ACP-correct default: an unfiltered
	// request omits `cwd` from session/list entirely.
	GlobalSessionListCwdOmitted LauncherSessionListGlobalCwd = ""
	// GlobalSessionListCwdEmpty sends an explicitly EMPTY `cwd`. It is
	// required by a bridge that substitutes its own last session cwd when the
	// field is absent, so omission there is a silent PROJECT filter, not
	// global discovery.
	GlobalSessionListCwdEmpty LauncherSessionListGlobalCwd = "empty"
)

// HarnessCapabilities reports what the negotiated Harness session supports
// and that Free4Chat can actually use. There is deliberately no Resume field:
// the adapter observes the Harness's sessionCapabilities.resume advertisement
// but Free4Chat has no `session/load` implementation, so it must not report
// usable resume to any upper layer.
type HarnessCapabilities struct {
	Text   bool
	Images bool
}

// HarnessSessionDiagnostic is bounded local diagnostic information for one
// retained Harness conversation. ACP session ids are opaque adapter-local
// identities: this type is used only at the daemon/CLI status boundary and
// must never enter Room state, prompts, telemetry, or public responses.
type HarnessSessionDiagnostic struct {
	Scope      string `json:"scope"`
	SessionID  string `json:"sessionId"`
	Generation int64  `json:"generation"`
}

// HarnessSessionDiagnostics is an optional adapter capability for local
// status observability. It deliberately does not broaden HarnessAdapter, so
// legacy/custom adapters remain compatible and simply omit diagnostics.
type HarnessSessionDiagnostics interface {
	SessionDiagnostics() []HarnessSessionDiagnostic
}

// RuntimeHostProjection is the complete, secret-free capability projection a
// Runtime Host shares about itself (#176 Phase A). runtimeHostId is a stable
// opaque grouping key for one local Runtime installation/root; the speech
// booleans mean "this host can currently produce STT/TTS if a Room grant
// authorizes it". It must never carry provider keys, credential sources,
// hostnames, or any other machine-identifying metadata, and it is discovery
// metadata only — never authorization.
type RuntimeHostProjection struct {
	RuntimeHostID string              `json:"runtimeHostId"`
	Speech        HostSpeechReadiness `json:"speech"`
}

// HostSpeechReadiness is the coarse STT/TTS readiness of one Runtime Host.
type HostSpeechReadiness struct {
	STT bool `json:"stt"`
	TTS bool `json:"tts"`
}

// Valid enforces the #176 wire contract fail-closed: the id must satisfy the
// shared opaque charset rule and the projection is otherwise fixed by its
// type shape. Callers must omit (never repair) an invalid projection.
func (p RuntimeHostProjection) Valid() bool {
	return ValidRuntimeHostID(p.RuntimeHostID)
}

// RuntimeFeatureProjection is the additive, coarse, PARTICIPANT-scoped
// projection of product-level Runtime features that a resident publishes when
// it joins or creates a Room. It is the discovery half of Task Session
// Continuation: the Room stores it on the Agent participant and shows the
// browser whether "Continue session" may be offered for THAT Agent.
//
// It is deliberately participant-scoped rather than host-scoped: one local
// Runtime Host can run several residents with different Harnesses, and a Pi
// resident must never make a Codex resident on the same host look capable.
//
// It is also deliberately NOT a slice of arbitrary capability tokens. A
// Runtime feature is a closed, Runtime-owned fact with a fixed shape, so it
// cannot be forged by naming a string, and it never has to share a namespace
// with user-advertised capability descriptions.
//
// Every field is omitempty, so an older Runtime that does not know this
// projection simply omits it and an older Room never sees it. It is discovery
// metadata only — NEVER authorization. The Room still validates the current
// resident socket and Task ownership; the Runtime re-checks its own product
// policy on every private session-control request.
type RuntimeFeatureProjection struct {
	// TaskSessionContinuation means "this resident can list and load one of
	// its Harness's existing native sessions for a Human-created Task".
	TaskSessionContinuation bool `json:"taskSessionContinuation,omitempty"`
	// TaskExecutionReconciliation means "this resident understands the private
	// fire-and-forget `task-execution-resync` control and will re-state the
	// CURRENT transient execution projection of every Task scope it owns".
	//
	// It exists for ONE reason (#421): Room execution projections are
	// deliberately transient and memory-only, so a Durable Object that
	// hibernates loses them while the resident Agent socket survives and the
	// local Harness keeps working. A returning Human then has no truthful
	// state to recover unless the Room can ask the Runtime to re-state it.
	//
	// A Room must NEVER send that control to a resident that does not
	// advertise this, because an older Runtime would receive an unknown private
	// frame. Support is therefore advertised, never inferred from a version
	// string.
	TaskExecutionReconciliation bool `json:"taskExecutionReconciliation,omitempty"`
}

// Empty reports whether this projection carries no feature at all, so a caller
// can omit the wire field entirely instead of sending an empty object.
func (p RuntimeFeatureProjection) Empty() bool {
	return !p.TaskSessionContinuation && !p.TaskExecutionReconciliation
}

// ValidRuntimeHostID is the single validation rule shared with the Room
// side (#176): opaque charset, bounded length. No semantics are attached.
func ValidRuntimeHostID(id string) bool {
	if len(id) < 8 || len(id) > 64 {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '-', r == '_', r == '.', r == ':':
		default:
			return false
		}
	}
	return true
}

// DeriveRuntimeHostID derives the Room-scoped public runtimeHostId for one
// Room from the private Runtime root seed (#176 Phase A): a deterministic
// HMAC-SHA256 over the final non-empty roomId, keyed by the seed. Same root
// + same Room → the same id across restarts and rejoins; different Rooms on
// one root → different ids (no cross-Room correlation via the seed); the
// raw seed is never exposed to the Room.
func DeriveRuntimeHostID(seed, roomID string) (string, error) {
	if !ValidRuntimeHostID(seed) {
		return "", errors.New("runtime host seed is malformed")
	}
	if roomID == "" || len(roomID) > 64 {
		return "", errors.New("runtime host id requires a final non-empty roomId")
	}
	mac := hmac.New(sha256.New, []byte(seed))
	mac.Write([]byte(roomID))
	id := hex.EncodeToString(mac.Sum(nil))
	if !ValidRuntimeHostID(id) {
		return "", errors.New("derived runtime host id is malformed")
	}
	return id, nil
}

// RoomAttachmentMetadata is the sanitized attachment projection carried on
// room events and upload results.
type RoomAttachmentMetadata struct {
	ID            string `json:"id"`
	FileName      string `json:"fileName"`
	MimeType      string `json:"mimeType"`
	Size          int64  `json:"size"`
	TaskRequestID string `json:"taskRequestId,omitempty"`
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

// AgentActivityState is the deliberately coarse, transient activity
// projection shown to other Room participants. It is not a Harness trace and
// must never carry thought text, tool arguments, commands, or paths.
type AgentActivityState string

const (
	AgentActivityWorking    AgentActivityState = "working"
	AgentActivityThinking   AgentActivityState = "thinking"
	AgentActivityUsingTools AgentActivityState = "using_tools"
	AgentActivityResponding AgentActivityState = "responding"
)

func (state AgentActivityState) Valid() bool {
	switch state {
	case AgentActivityWorking, AgentActivityThinking,
		AgentActivityUsingTools, AgentActivityResponding:
		return true
	default:
		return false
	}
}

// TaskExecutionPhase is the closed transient phase of the exact turn a Runtime
// currently owns for one Task. It is control truth only: it does not replace
// the retained Task lifecycle and it carries no Harness activity.
type TaskExecutionPhase string

const (
	TaskExecutionPhaseRunning TaskExecutionPhase = "running"
	// TaskExecutionPhaseInterrupting means a Human interrupt for this exact
	// turn was authorized and dispatched; the turn has not settled yet.
	TaskExecutionPhaseInterrupting TaskExecutionPhase = "interrupting"
	// TaskExecutionPhaseQueued means this Task has accepted work that is NOT
	// executing yet: no execution lane is running it. It is the truthful
	// "waiting for capacity" state, so a Task behind a bounded lane bound is
	// distinguishable from a Task that is simply hanging (#421). It is valid
	// only with no current turn and a positive queue depth.
	TaskExecutionPhaseQueued TaskExecutionPhase = "queued"
)

func (phase TaskExecutionPhase) Valid() bool {
	switch phase {
	case TaskExecutionPhaseRunning, TaskExecutionPhaseInterrupting,
		TaskExecutionPhaseQueued:
		return true
	default:
		return false
	}
}

// TaskExecutionOutcome is the closed transient outcome of the last settled
// turn of one Task. It never claims a Harness-provided reason.
type TaskExecutionOutcome string

const (
	// TaskExecutionOutcomeInterrupted means Free4Chat dispatched an interrupt
	// for that exact turn and that same turn subsequently settled.
	TaskExecutionOutcomeInterrupted TaskExecutionOutcome = "interrupted"
)

func (outcome TaskExecutionOutcome) Valid() bool {
	return outcome == TaskExecutionOutcomeInterrupted
}

// TaskExecutionAvailability is the closed transient availability of one Task's
// retained Harness session. It is never an ACP session id, process id, path, or
// credential.
type TaskExecutionAvailability string

const (
	// TaskExecutionAvailabilitySessionLost means the retained Harness session
	// for this Task died unexpectedly and no replacement turn has started yet.
	TaskExecutionAvailabilitySessionLost TaskExecutionAvailability = "session_lost"
)

func (availability TaskExecutionAvailability) Valid() bool {
	return availability == TaskExecutionAvailabilitySessionLost
}

// TaskExecutionProjection is the Runtime-authoritative TRANSIENT execution
// state of exactly one Task: which exact canonical turn this Runtime owns now,
// how many accepted instructions wait behind it, the last intentional
// settlement, and whether the retained Harness session is gone.
//
// It is deliberately NOT: the retained Task lifecycle
// (Starting|Working|Completed|Failed), Harness activity
// (working|thinking|using_tools|responding), a queue of its own, or persisted
// history. "Running with N queued" is a valid single state, which is why this
// is a projection and not an enum. It is presented to Humans and never carries
// task text, prompts, paths, credentials, or ACP identifiers.
type TaskExecutionProjection struct {
	TaskRequestID string `json:"taskRequestId"`
	// CurrentTurnSequence is the canonical Room sequence of the exact turn this
	// Runtime owns for the Task; 0 means no turn is current.
	CurrentTurnSequence int64 `json:"currentTurnSequence,omitempty"`
	// Phase is present only while CurrentTurnSequence is.
	Phase TaskExecutionPhase `json:"phase,omitempty"`
	// QueuedCount counts accepted instructions waiting behind the current turn
	// (or all of them when no turn is current).
	QueuedCount int `json:"queuedCount"`
	// LastOutcome is present only while it is still meaningful.
	LastOutcome TaskExecutionOutcome `json:"lastOutcome,omitempty"`
	// Availability is present only while the retained session is known lost.
	Availability TaskExecutionAvailability `json:"availability,omitempty"`
}

// Valid enforces the projection's closed shape fail-closed: a RUNNING or
// INTERRUPTING phase may only exist with a positive current turn, and a QUEUED
// phase may only exist with no current turn and real accepted work waiting.
func (p TaskExecutionProjection) Valid() bool {
	if p.TaskRequestID == "" || len(p.TaskRequestID) > MaxResidentTaskRequestID {
		return false
	}
	if p.QueuedCount < 0 || p.QueuedCount > MaxTaskExecutionQueuedCount {
		return false
	}
	if p.CurrentTurnSequence < 0 || p.CurrentTurnSequence > MaxResidentTurnSequence {
		return false
	}
	if p.CurrentTurnSequence == 0 {
		// No current turn: the only truthful phase is "nothing is executing",
		// stated either as absent or as QUEUED when accepted work is waiting.
		if p.Phase != "" && p.Phase != TaskExecutionPhaseQueued {
			return false
		}
		if p.Phase == TaskExecutionPhaseQueued && p.QueuedCount == 0 {
			return false
		}
	} else if !p.Phase.Valid() || p.Phase == TaskExecutionPhaseQueued {
		return false
	}
	if p.LastOutcome != "" && !p.LastOutcome.Valid() {
		return false
	}
	if p.Availability != "" && !p.Availability.Valid() {
		return false
	}
	return true
}

// MaxResidentTaskRequestID bounds a Task correlation id on private control
// transports.
const MaxResidentTaskRequestID = 64

// MaxTaskExecutionQueuedCount bounds a reported queue depth. The Runtime's own
// serial queue is bounded well below this; the bound exists so a malformed or
// hostile publisher can never project an absurd number.
const MaxTaskExecutionQueuedCount = 64

// RoomPermissionToolCall is the bounded Human-facing projection of one ACP
// tool call. Raw ACP input/content and native protocol identifiers stay local
// to the Harness adapter.
type RoomPermissionToolCall struct {
	Title   string            `json:"title"`
	Kind    string            `json:"kind,omitempty"`
	Summary string            `json:"summary,omitempty"`
	Details map[string]string `json:"details,omitempty"`
}

// RoomPermissionOption preserves the exact option identity/presentation the
// Harness offered. Free4Chat does not interpret the native Kind value.
type RoomPermissionOption struct {
	OptionID string `json:"optionId"`
	Name     string `json:"name"`
	Kind     string `json:"kind,omitempty"`
}

// RoomPermissionRequest is the narrow Runtime-only ingress shape from #291.
// RequestID is a fresh Room-correlation id generated by the resident Runtime
// for every ACP permission request; it is never the Harness ACP JSON-RPC id.
type RoomPermissionRequest struct {
	RequestID     string                 `json:"requestId"`
	TaskRequestID string                 `json:"taskRequestId,omitempty"`
	ToolCall      RoomPermissionToolCall `json:"toolCall"`
	Options       []RoomPermissionOption `json:"options"`
	ExpiresInMs   int64                  `json:"expiresInMs,omitempty"`
}

// RoomPermissionEvent is the sanitized lifecycle event delivered to the
// originating Agent through the resident event stream.
type RoomPermissionEvent struct {
	RequestID          string `json:"requestId"`
	Kind               string `json:"kind"` // resolved | expired
	AgentParticipantID string `json:"agentParticipantId"`
	SelectedOptionID   string `json:"selectedOptionId,omitempty"`
	HumanParticipantID string `json:"humanParticipantId,omitempty"`
	HumanName          string `json:"humanName,omitempty"`
	CreatedAt          int64  `json:"createdAt"`
	ExpiresAt          int64  `json:"expiresAt"`
}

// RoomEvent is one room event delivered through wait_for_events.
type RoomEvent struct {
	Sequence    int64               `json:"sequence"`
	Type        string              `json:"type"` // text | action | image
	Participant ParticipantIdentity `json:"participant"`
	// ScopeID is an optional bounded cognition-routing hint. Empty means the
	// ordinary Room conversation; task/request producers may set it to route
	// an addressed event to one logical Agent scope without changing Room
	// transport ownership.
	ScopeID       string                  `json:"scopeId,omitempty"`
	Text          string                  `json:"text,omitempty"`
	ActionType    string                  `json:"actionType,omitempty"`
	ActionPayload map[string]string       `json:"actionPayload,omitempty"`
	Collab        *WireCollabEvent        `json:"collab,omitempty"`
	Permission    *RoomPermissionEvent    `json:"permission,omitempty"`
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

// HarnessReferencedAttachment is the bounded content view of an attachment
// referenced by a structured collaboration envelope. The collaboration
// envelope already carries the opaque reference id; this type adds only the
// Runtime-resolved content needed by the local Harness for this turn.
// Unavailable is a safe fail-open marker for an unknown, evicted, unsupported,
// or unreadable attachment. It never carries Room credentials or raw errors.
type HarnessReferencedAttachment struct {
	ID          string           `json:"id"`
	FileName    string           `json:"fileName,omitempty"`
	MimeType    string           `json:"mimeType,omitempty"`
	TextFile    *TextFileContent `json:"textFile,omitempty"`
	Image       *HarnessImage    `json:"image,omitempty"`
	Unavailable bool             `json:"unavailable,omitempty"`
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
	// RuntimeHostID (#176 Phase A): the Room-scoped opaque Runtime Host
	// grouping key of the local Runtime behind this Agent, when its Runtime
	// projects one. Host readiness travels once per host in the Room's
	// runtimeHosts projection, shared by all same-host Agents. Absent for
	// Humans.
	RuntimeHostID string `json:"runtimeHostId,omitempty"`
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
	// ReferencedAttachments contains bounded content resolved from the
	// Collab.AttachmentIDs references for this event. It is deliberately
	// separate from Attachment so plural collaboration references cannot drop
	// all but the first artifact.
	ReferencedAttachments []HarnessReferencedAttachment `json:"referencedAttachments,omitempty"`
	Sequence              int64                         `json:"sequence"`
	CreatedAt             int64                         `json:"createdAt"`
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

// HarnessTranscriptSegment is one committed attributed utterance.
type HarnessTranscriptSegment struct {
	Sequence      int64  `json:"sequence"`
	ParticipantID string `json:"participantId"`
	Speaker       string `json:"speaker"`
	Text          string `json:"text"`
}

// HarnessMeetingTranscript is the runtime-local Meeting Notes snapshot
// surfaced to the Harness: a local temp file path plus bounded segments.
// Never a Worker/DO attachment or URL.
type HarnessMeetingTranscript struct {
	Path     string                     `json:"path"`
	Segments []HarnessTranscriptSegment `json:"segments"`
}

// LiveTranscriptInfo is the Room-wide Live Transcript control-plane state.
// It is room-visible metadata only; it never carries media credentials.
type LiveTranscriptInfo struct {
	Active                      bool   `json:"active"`
	ProducerRuntimeHostID       string `json:"producerRuntimeHostId,omitempty"`
	StartedByHumanParticipantID string `json:"startedByHumanParticipantId,omitempty"`
	Epoch                       int64  `json:"epoch,omitempty"`
	StartedAt                   int64  `json:"startedAt,omitempty"`
}

// ResidentMediaState is the self-targeted media projection delivered on the
// private resident event stream. It contains authorization epochs only; it
// never carries media/session identifiers or another Agent's grants.
type ResidentMediaState struct {
	MeetingNotes        ResidentMeetingNotesState   `json:"meetingNotes"`
	AgentVoiceEnabledAt int64                       `json:"agentVoiceEnabledAt,omitempty"`
	MediaAvailable      bool                        `json:"mediaAvailable"`
	LiveTranscript      ResidentLiveTranscriptState `json:"liveTranscript"`
}

type ResidentMeetingNotesState struct {
	Active    bool  `json:"active"`
	StartedAt int64 `json:"startedAt,omitempty"`
}

type ResidentLiveTranscriptState struct {
	Active                bool   `json:"active"`
	ProducerRuntimeHostID string `json:"producerRuntimeHostId,omitempty"`
	Epoch                 int64  `json:"epoch,omitempty"`
}

// LiveTranscriptSegment is one committed Room-shared utterance. It is
// bounded by the Room Durable Object and intentionally has no audio or media
// identifiers.
type LiveTranscriptSegment struct {
	SegmentID     string `json:"segmentId"`
	Epoch         int64  `json:"epoch"`
	Sequence      int64  `json:"sequence"`
	ParticipantID string `json:"participantId"`
	Speaker       string `json:"speaker"`
	Text          string `json:"text"`
	CreatedAt     int64  `json:"createdAt"`
}

// HarnessLiveTranscript is the sanitized, bounded Room-wide snapshot
// refreshed immediately before an addressed Harness turn.
type HarnessLiveTranscript struct {
	Segments []LiveTranscriptSegment `json:"segments"`
}

// HarnessSessionContext tells prompt rendering two independent facts about the
// retained ACP conversation this turn runs on. It carries no ACP id or Room
// capability: the generation itself stays Runtime-local.
//
// New and Bootstrap are deliberately separate:
//   - New means the Runtime created a genuinely new ACP conversation for this
//     scope, so the prompt may say so.
//   - Bootstrap means this turn still needs the Free4Chat host, authority, and
//     collaboration contract, which is true both for a new conversation and for
//     the first Free4Chat-controlled turn of an EXISTING conversation that was
//     adopted from a native Harness session (#409). An adopted conversation is
//     not new, but its first Free4Chat turn must still be taught the contract.
type HarnessSessionContext struct {
	New                 bool  `json:"new"`
	Bootstrap           bool  `json:"bootstrap"`
	CurrentRoomSequence int64 `json:"currentRoomSequence"`
}

// HarnessTurnInput is the bounded, untrusted-safe context handed to the
// Harness for one addressed turn. It never contains the participant handle.
type HarnessTurnInput struct {
	Room              RoomTurnContext           `json:"room"`
	Events            []HarnessEvent            `json:"events"`
	MeetingTranscript *HarnessMeetingTranscript `json:"meetingTranscript,omitempty"`
	LiveTranscript    *HarnessLiveTranscript    `json:"liveTranscript,omitempty"`
	Session           *HarnessSessionContext    `json:"session,omitempty"`
	// TaskRequestID is the exact canonical Task this turn belongs to, when
	// the turn's logical scope is a Task scope. It exists so the rendered
	// prompt can state the correlation id directly: artifacts produced for a
	// Task must be published with `attach --task-request-id <id>` instead of
	// falling back to an unscoped Room artifact (#421 dogfood finding E).
	// Empty for an ordinary Room conversation turn, which is exactly what
	// makes an unscoped `attach` a Room artifact.
	TaskRequestID string `json:"taskRequestId,omitempty"`
}

// LifecycleIntent is the closed, local Harness-to-Runtime control result.
// It never travels over the Room/MCP protocol and deliberately contains only
// the one bounded action the Runtime may currently honor.
type LifecycleIntent string

const (
	LifecycleIntentNone  LifecycleIntent = ""
	LifecycleIntentLeave LifecycleIntent = "leave"
)

// HarnessTurnResult is what the Harness produced for a turn.
//
// TargetParticipantIDs is the outbound addressing contract (#165): explicit
// structured targets the Harness decided for its reply, derived ONLY from a
// strict machine envelope — never inferred from the visible prose. Empty for
// ordinary unaddressed replies (plain-text-only Harnesses are unaffected).
// LifecycleIntent is a separate, strict local control intent. It is never a
// Room message, is mutually exclusive with targets, and must be structurally
// authorized by the Runtime before it can affect participation.
type HarnessTurnResult struct {
	Text                 string
	TargetParticipantIDs []string
	LifecycleIntent      LifecycleIntent
}

// AdapterFailureHandler is invoked when the Harness process dies unexpectedly.
type AdapterFailureHandler func(error)

// ScopedAdapterFailureHandler identifies the logical conversations owned by
// a failed provider process. Isolated adapters use it so one lane failure does
// not invalidate sessions that belong to another process.
type ScopedAdapterFailureHandler func(scopes []string, err error)

// ScopedAdapterFailureNotifier is an optional failure seam for adapters that
// own multiple independently failing provider processes.
type ScopedAdapterFailureNotifier interface {
	OnScopedFailure(handler ScopedAdapterFailureHandler)
}

// ErrHarnessSessionGenerationChanged means an adapter could no longer bind a
// turn to the ACP conversation generation the Runtime prepared it for. The
// Runtime must rebuild the turn after observing the replacement session so a
// bootstrap/security contract can never be omitted on a fresh conversation.
var ErrHarnessSessionGenerationChanged = errors.New("harness session generation changed")

// HarnessAdapter is the real boundary between room turns and the local
// Harness process (ACP).
type HarnessAdapter interface {
	Name() string
	Capabilities() *HarnessCapabilities
	EnsureSession() error
	// SessionGeneration increases only after the adapter has successfully
	// created a fresh ACP session/new conversation. It lets the Runtime keep
	// Room delivery acknowledgement scoped to actual Harness memory rather
	// than to transport reconnects or process ids.
	SessionGeneration() int64
	// RunTurn binds the prepared input to expectedSessionGeneration. It must
	// never create or silently switch to another session while sending a turn:
	// the Runtime derives Session.New and the bootstrap contract from this exact
	// generation.
	RunTurn(input HarnessTurnInput, expectedSessionGeneration int64) (HarnessTurnResult, error)
	OnFailure(handler AdapterFailureHandler)
	CancelTurn() error
	Close() error
}

// ScopedHarnessAdapter is the small optional seam for one resident Agent to
// retain more than one logical Harness conversation. Scope is an opaque
// Runtime-owned value; ACP session ids never leave the adapter.
// Implementations may run turns of different scopes concurrently while
// preserving each scope's conversation, generation, and exact-turn control
// independently (#421).
type ScopedHarnessAdapter interface {
	EnsureSessionFor(scope string) error
	SessionGenerationFor(scope string) int64
	RunTurnFor(scope string, input HarnessTurnInput, expectedSessionGeneration int64) (HarnessTurnResult, error)
}

// ScopedTurnCanceller is the small optional seam that keeps a remote interrupt
// exact once more than one conversation may execute at a time: the Runtime
// names the ONE scope whose turn it proved it owns, and the adapter cancels
// that conversation only. It never carries a native session id.
type ScopedTurnCanceller interface {
	CancelTurnFor(scope string) error
}

// ScopedTurnOwnership is the small optional seam that lets the Runtime avoid
// scheduling a turn the adapter would only refuse. It answers "which logical
// scope currently holds a turn on the native conversation this scope is bound
// to?" without ever exposing the native session id.
//
// It exists because two Free4Chat Task scopes may be bound to the SAME native
// conversation. The hard invariant is that such a conversation still executes
// one turn at a time; the Runtime serializes them by simply not scheduling the
// second while the first is executing, instead of dispatching a turn that the
// adapter must refuse.
type ScopedTurnOwnership interface {
	TurnOwnerFor(scope string) (ownerScope string, busy bool)
}

// JoinResult is what join_room returns; the participantHandle is the bearer
// capability kept strictly inside the runtime.
type JoinResult struct {
	ParticipantID     string
	ParticipantHandle string // secret; never logged, prompted, or surfaced
	// RuntimeProviderHandle is a second private bearer returned only when a
	// one-time Human provider claim was redeemed. It stays daemon-memory only.
	RuntimeProviderHandle string
	Cursor                int64
	ExpiresAt             int64
	// AgentLeaseMs is the server's current Agent lease. The resident Runtime
	// derives a sparse WebSocket heartbeat interval from it instead of
	// duplicating a product timing constant locally.
	AgentLeaseMs int64
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

// AgentVoiceGrant is one participant-specific outbound voice authorization.
// Its presence (not a display name or Runtime Host) is the only Runtime-side
// permission to speak; EnabledAt is the authorization epoch.
type AgentVoiceGrant struct {
	EnabledAt int64 `json:"enabledAt"`
}

// RoomInfo is the sanitized room_info projection. It never contains tokens,
// connection nonces, SFU session/track identifiers, or message history.
type RoomInfo struct {
	Exists       bool                     `json:"exists"`
	Participants []ParticipantRosterEntry `json:"participants,omitempty"`
	MeetingNotes MeetingNotesInfo         `json:"meetingNotes"`
	// Fail closed: only explicit true counts. The resident event stream carries
	// the equivalent bounded self-targeted projection; these fields remain part
	// of the compatibility transport contract.
	MeetingNotesMediaAvailable bool                       `json:"meetingNotesMediaAvailable"`
	AgentVoice                 map[string]AgentVoiceGrant `json:"agentVoice"`
	AgentVoiceMediaAvailable   bool                       `json:"agentVoiceMediaAvailable"`
	LiveTranscript             LiveTranscriptInfo         `json:"liveTranscript"`
	LiveTranscriptSegments     []LiveTranscriptSegment    `json:"liveTranscriptSegments,omitempty"`
}

// RoomContextReadOptions bounds one read-only historical Room observation.
// Room event and Live Transcript sequences intentionally remain separate
// domains, so their cursors and limits are never interchanged. Cursor
// pointers preserve an omitted cursor separately from an explicit zero.
type RoomContextReadOptions struct {
	BeforeSequence           *int64
	AfterSequence            *int64
	Limit                    int
	BeforeTranscriptSequence *int64
	AfterTranscriptSequence  *int64
	TranscriptLimit          int
}

// RoomContextWindow is a retained, sanitized Room-event page. Sequence zero
// denotes an empty retained window; Truncated means the requested `after`
// cursor predates the bounded retained window.
type RoomContextWindow struct {
	Events         []RoomEvent `json:"events"`
	OldestSequence int64       `json:"oldestSequence"`
	NewestSequence int64       `json:"newestSequence"`
	HasMoreBefore  bool        `json:"hasMoreBefore"`
	HasMoreAfter   bool        `json:"hasMoreAfter"`
	Truncated      bool        `json:"truncated,omitempty"`
}

// LiveTranscriptContextWindow is the analogous bounded page in the separate
// Room-wide Live Transcript sequence domain.
type LiveTranscriptContextWindow struct {
	Segments       []LiveTranscriptSegment `json:"segments"`
	OldestSequence int64                   `json:"oldestSequence"`
	NewestSequence int64                   `json:"newestSequence"`
	HasMoreBefore  bool                    `json:"hasMoreBefore"`
	HasMoreAfter   bool                    `json:"hasMoreAfter"`
	Truncated      bool                    `json:"truncated,omitempty"`
}

// RoomContextReadResult is a bounded, observation-only response. It never
// contains a participant handle, token, connection nonce, media data, or any
// lifecycle/mutation authority.
type RoomContextReadResult struct {
	Room           RoomContextWindow           `json:"room"`
	LiveTranscript LiveTranscriptContextWindow `json:"liveTranscript"`
}

// WaitResult is wait_for_events' long-poll result with the advanced cursor.
type WaitResult struct {
	Events       []RoomEvent
	Cursor       int64
	ExpiresAt    int64
	Participants []ParticipantRosterEntry
	// RuntimeHosts (#176 Phase A): one coarse readiness projection per
	// Runtime Host id present in the Room, shared by all same-host Agents.
	RuntimeHosts map[string]RuntimeHostProjection
	// MediaState is populated only by the private resident event stream. The
	// public wait_for_events contract remains text/roster-only.
	MediaState *ResidentMediaState `json:"mediaState,omitempty"`
	// TaskControl is populated only by the private resident event stream: a
	// transient Task-scoped control frame, never a Room event. It is
	// deliberately excluded from JSON so no public/MCP surface can observe or
	// re-emit it, and it carries no cursor of its own.
	TaskControl *ResidentTaskControl `json:"-"`
	// SessionControl is populated only by the private resident event stream:
	// one bounded Task Session Continuation request (list/prepare/cancel).
	// Like TaskControl it is excluded from JSON, carries no cursor, and never
	// reaches the public wait_for_events projection.
	SessionControl *ResidentSessionControl `json:"-"`
	// TaskExecutionResync is populated only by the private resident event
	// stream (#421): a FIRE-AND-FORGET request to re-state the current
	// transient execution projection of every Task scope this Runtime owns.
	//
	// It has no request id and no response by design. It is not a Task Session
	// Continuation control, shares none of its correlation state, and can
	// never be answered into it. Like the other private frames it carries no
	// cursor and never reaches the public wait_for_events projection.
	TaskExecutionResync bool `json:"-"`
}

// ResidentTaskControlKind is the closed set of private resident control
// frames. It is not a Room message, a lifecycle intent, or a Harness prompt.
type ResidentTaskControlKind string

const (
	// ResidentTaskControlInterrupt asks the Runtime to cancel the Harness turn
	// it currently owns for exactly one Task scope. It is edge-triggered: a
	// control that arrives with no matching active turn is a local no-op and
	// is never retained for a later turn.
	ResidentTaskControlInterrupt ResidentTaskControlKind = "interrupt"
)

// MaxResidentTurnSequence bounds the canonical Room sequence used as transient
// turn identity: it is the JavaScript safe-integer limit, so the browser, the
// Room, and the Runtime all compare the exact same value.
const MaxResidentTurnSequence = int64(1)<<53 - 1

// ResidentTaskControl is a PRIVATE RESIDENT TRANSPORT ONLY control frame
// (#409). It travels on the Agent's own resident event socket, is never
// persisted in Room state, never increments a Room sequence, and is never
// returned by the public wait_for_events contract.
//
// It carries no authority by itself: the Runtime authorizes it against the
// exact Harness turn it currently owns. TaskRequestID stays a Room-visible
// correlation id, and TurnSequence is the canonical addressed Room sequence of
// the trigger — never an ACP session id, participant handle, or token.
type ResidentTaskControl struct {
	Kind          ResidentTaskControlKind `json:"kind"`
	TaskRequestID string                  `json:"taskRequestId"`
	// TurnSequence is the canonical Room sequence of the EXACT turn the Human
	// saw running. A Task scope alone is not turn identity: the same Task can
	// run many turns, and a stale control must never cancel a later one.
	TurnSequence int64 `json:"turnSequence"`
}

/*
 * Task Session Continuation over the private resident socket (#409).
 *
 * This is the second, narrower family on the SAME resident socket as
 * ResidentTaskControl. It is the product path behind
 * "Start Task -> Continue session -> pick a local session -> Start", and it is
 * deliberately generic: nothing here mentions Pi, ACP, or any Harness. Pi is
 * simply the first built-in Harness whose launcher policy enables it.
 *
 * The whole family is PRIVATE and TRANSIENT:
 *
 *   - it is never a Room message, sequence, waiter wake, or analytics event;
 *   - it is never persisted in Room or Runtime durable state;
 *   - the Room relays only bounded, sanitized presentation data to the ONE
 *     requesting Human socket;
 *   - real ACP session ids, real cwd values, and real ACP pagination cursors
 *     never leave the Runtime (see ResidentTaskSession).
 */

// ResidentSessionControlKind is the closed set of private session-control
// operations. An unknown operation is rejected, never degraded.
type ResidentSessionControlKind string

const (
	// ResidentSessionControlList asks for one bounded page of the Harness's
	// existing native sessions, optionally filtered to one project.
	ResidentSessionControlList ResidentSessionControlKind = "list"
	// ResidentSessionControlPrepare asks the Runtime to arm ONE adoption of
	// the selected session, pinned to the EXACT canonical Task requestId the
	// Room is about to create. Nothing is created in the Room by this frame.
	ResidentSessionControlPrepare ResidentSessionControlKind = "prepare"
	// ResidentSessionControlCancel is a best-effort release of a prepared
	// adoption whose canonical Task will now never exist. Correctness never
	// depends on it: the prepared adoption is bounded by its own short TTL and
	// can only ever bind to its own exact requestId.
	ResidentSessionControlCancel ResidentSessionControlKind = "cancel"
)

// MaxResidentSessionRequestID bounds the Room-generated correlation id that
// pairs one control with its result.
const MaxResidentSessionRequestID = 64

// MaxResidentSessionRows bounds one product discovery page. It is deliberately
// far below the adapter's own 50-entry ACP page bound: this feeds a compact
// picker, and the browser must never receive a bulk export.
const MaxResidentSessionRows = 10

// MaxResidentSessionProjects bounds the Runtime-local project catalog one
// Human can grow through discovery.
const MaxResidentSessionProjects = 24

// MaxResidentSessionTokenLength bounds every opaque Runtime-issued selection,
// project, and pagination token.
const MaxResidentSessionTokenLength = 64

// MaxResidentSessionTitleLength bounds the display-only Harness-provided
// session title.
const MaxResidentSessionTitleLength = 256

// MaxResidentSessionProjectLabelLength bounds the display-only project label.
const MaxResidentSessionProjectLabelLength = 256

// ResidentSessionControl is one PRIVATE resident-only session-control request.
// Every field except Kind/RequestID is operation-specific and optional.
//
// The tokens are opaque Runtime-local handles. The Room relays them unchanged
// and can never resolve one itself: a token is not authority, not a session
// id, and not a cwd. TaskRequestID is the canonical Room collaboration
// requestId the ROOM already generated for the Task it is about to create; it
// is the exact identity the prepared adoption is pinned to.
type ResidentSessionControl struct {
	Kind      ResidentSessionControlKind
	RequestID string
	// ProjectToken/PageToken are list-only and mutually usable: a project
	// filter selects an exact cwd locally, a page token continues a previous
	// page.
	ProjectToken string
	PageToken    string
	// SessionToken is prepare-only: the exact selection to adopt.
	SessionToken string
	// TaskRequestID is prepare-only: the canonical Task this adoption may
	// bind to, and the ONLY one it can ever bind to.
	TaskRequestID string
	// HumanParticipantID is the Room participant id of the authenticated Human
	// that made this request. It is required for every operation: a selection,
	// project, or page token is bound to exactly one Human, and an adoption may
	// only ever bind to a Task that Human owns. It is a Room-visible
	// correlation id, never a capability or token.
	HumanParticipantID string
}

// ResidentTaskSession is the bounded, sanitized presentation of one native
// Harness session. It is the ONLY session shape a browser may ever see.
//
// Token is a cryptographically random, Human-bound, short-lived Runtime-local
// handle. The real ACP session id and the real cwd stay in Runtime memory: the
// browser never receives them, never round-trips them, and never uses a
// display string as identity.
type ResidentTaskSession struct {
	Token string `json:"token"`
	// Title is UNTRUSTED presentation: arbitrary user or model text, already
	// bounded and control-folded by the adapter. It is plain text, never HTML
	// and never markdown.
	Title string `json:"title"`
	// ProjectToken is the Runtime-issued handle for the exact project this
	// session belongs to. ProjectLabel is its human-facing display path.
	ProjectToken string `json:"projectToken"`
	ProjectLabel string `json:"projectLabel"`
	// UpdatedAt is an optional RFC3339 timestamp, passed through only when the
	// adapter already validated it.
	UpdatedAt string `json:"updatedAt,omitempty"`
}

// ResidentTaskSessionProject is one bounded project choice built from
// discovered session metadata. Projects are ONLY directories the Harness
// reported for its own sessions: the Runtime never scans the filesystem.
type ResidentTaskSessionProject struct {
	Token string `json:"token"`
	Label string `json:"label"`
}

// ResidentSessionErrorCode is the closed set of bounded, actionable failure
// classes a Human may be shown. Raw adapter, ACP, or path text is never
// forwarded: a Harness error message can quote local identity.
type ResidentSessionErrorCode string

const (
	// ResidentSessionErrorUnsupported means this resident's product policy
	// does not enable Task Session Continuation at all.
	ResidentSessionErrorUnsupported ResidentSessionErrorCode = "session_continuation_unsupported"
	// ResidentSessionErrorInvalid means the control frame was malformed.
	ResidentSessionErrorInvalid ResidentSessionErrorCode = "invalid_session_control"
	// ResidentSessionErrorBusy means another session-control operation is
	// already in flight for this Runtime (one outstanding, always).
	ResidentSessionErrorBusy ResidentSessionErrorCode = "session_control_busy"
	// ResidentSessionErrorExpired means a selection, project, or page token is
	// unknown, expired, or belongs to another Human. The UI reloads discovery;
	// it never falls back to a fresh session.
	ResidentSessionErrorExpired ResidentSessionErrorCode = "session_selection_expired"
	// ResidentSessionErrorUnavailable means discovery or preparation could not
	// be completed (Harness gone, list/load failed, adoption already armed).
	ResidentSessionErrorUnavailable ResidentSessionErrorCode = "session_continuation_unavailable"
)

// ResidentSessionResult is the Runtime's bounded answer to one
// ResidentSessionControl. Exactly one result is sent per requestId, on the
// same resident socket the control arrived on.
type ResidentSessionResult struct {
	Kind      ResidentSessionControlKind
	RequestID string
	OK        bool
	// Error is set only when OK is false and is always one of the closed
	// ResidentSessionErrorCode values above.
	Error ResidentSessionErrorCode
	// Sessions/Projects/NextPageToken are list-only. NextPageToken is a FRESH
	// Runtime-issued token, never the provider's opaque cursor.
	Sessions      []ResidentTaskSession        `json:"sessions,omitempty"`
	Projects      []ResidentTaskSessionProject `json:"projects,omitempty"`
	NextPageToken string                       `json:"nextPageToken,omitempty"`
	HasMore       bool                         `json:"hasMore,omitempty"`
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
	FileName      string
	MimeType      string
	DataBase64    string
	TaskRequestID string
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

// TaskLiveViewClient is the optional Runtime transport extension for #316.
// The Room remains the authority: the Runtime only keeps the participant
// handle private while forwarding the bounded declarative snapshot.
type TaskLiveViewClient interface {
	PublishLiveView(participantHandle, taskRequestID string, surface map[string]any) (map[string]any, error)
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
	// JoinRoom optionally carries the #176 Phase A Runtime Host projection
	// (nil omits it from the wire payload entirely) and the additive
	// RuntimeFeatureProjection (nil/empty omits it too, so an old Room and an
	// old Runtime keep working unchanged in both directions).
	JoinRoom(roomID, name string, capabilities []string, host *RuntimeHostProjection, features *RuntimeFeatureProjection) (JoinResult, error)
	// CreateRoom NEVER carries a runtimeHost: the Room-scoped id is derived
	// from the final server-generated roomId, which does not exist at call
	// time (#178 review fix 3). Push the derived projection afterwards via
	// UpdateRuntimeHost.
	CreateRoom(name string, capabilities []string, features *RuntimeFeatureProjection) (CreateRoomResult, error)
	// UpdateRuntimeHost re-projects this Agent's Runtime Host capability
	// projection (#176 Phase A) after a local readiness change (e.g. #167
	// credential hot reload) without rejoining the room.
	UpdateRuntimeHost(participantHandle string, host RuntimeHostProjection) error
	WaitForEvents(participantHandle string, cursor int64, timeoutSeconds int) (WaitResult, error)
	// SendText publishes one agent message. targetParticipantIDs carries
	// explicit addressing (#165): validated participant IDs that persist
	// into RoomMessage.targets and wake exactly the targeted resident
	// Runtimes. Nil keeps the message an ordinary unaddressed one.
	SendText(participantHandle, text string, targetParticipantIDs []string) (SendTextResult, error)
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

// TaskTextClient is the optional narrow transport extension for preserving an
// existing Room collaboration request on ordinary task text. Legacy clients
// remain valid for ordinary Room text; a Runtime must not silently use that
// legacy path for a non-Room scope.
type TaskTextClient interface {
	SendTextForTask(participantHandle, text string, targetParticipantIDs []string, taskRequestID string) (SendTextResult, error)
}

// RoomContextClient is an optional narrow historical-observation extension.
// The Runtime keeps the participant handle private while mediating every call.
type RoomContextClient interface {
	ReadRoomContext(participantHandle string, options RoomContextReadOptions) (RoomContextReadResult, error)
}

// ResidentEventStream is the Runtime-owned Room event transport. It is
// intentionally narrower than Free4ChatClient: the stream only delivers the
// canonical Room event envelope and refreshes the existing Agent lease.
// Participant capabilities remain private to the Runtime and are never
// passed through this interface to a Harness.
//
// SendSessionResult is the ONLY Runtime -> Room application frame on this
// socket besides Heartbeat. It answers exactly one ResidentSessionControl on
// the same connection the control arrived on, carries no cursor, and is never
// a Room event. Implementations must serialize it with Heartbeat: the resident
// socket is a one-writer transport.
type ResidentEventStream interface {
	Receive(context.Context) (WaitResult, error)
	Heartbeat(context.Context, int64) error
	SendSessionResult(context.Context, ResidentSessionResult) error
	Close() error
}

// ResidentEventClient is an optional extension for injected test/compatibility
// clients. The built-in Free4Chat client implements it, so the official
// resident Runtime never falls back to an endless MCP long-poll loop.
type ResidentEventClient interface {
	OpenResidentEventStream(context.Context, string, int64) (ResidentEventStream, error)
}

// RuntimeHostProviderClient is an optional extension so existing test and
// adapter clients retain the small Phase-A interface. The production MCP
// client implements it; both values are private bearer material.
type RuntimeHostProviderClient interface {
	JoinRoomWithRuntimeProvider(roomID, name string, capabilities []string, host *RuntimeHostProjection, features *RuntimeFeatureProjection, providerClaimHash, runtimeProviderHandle string) (JoinResult, error)
	UpdateRuntimeHostWithRuntimeProvider(participantHandle string, host RuntimeHostProjection, runtimeProviderHandle string) error
}

// RuntimeProviderConnector is the optional control-plane extension used by
// the Human-facing local Runtime connection flow. It is deliberately kept
// separate from RuntimeHostProviderClient so older adapters and test doubles
// that only support join/update proofing continue to retain their behavior.
type RuntimeProviderConnector interface {
	ConnectRuntimeProvider(participantHandle string, host RuntimeHostProjection, providerClaimHash string) (string, error)
}

// LiveTranscriptAppendClient is an optional direct Room-control extension.
// The opaque participant handle remains local to the runtime and is sent only
// to the Free4Chat endpoint.
type LiveTranscriptAppendClient interface {
	AppendLiveTranscript(participantHandle string, epoch int64, segmentID, sourceParticipantID, text string) error
}

// PermissionRequestClient is an optional narrow Runtime-only Room control
// extension. It intentionally stays outside Free4ChatClient so older test
// clients and compatibility adapters do not acquire a new mutation surface.
type PermissionRequestClient interface {
	RequestPermission(participantHandle string, request RoomPermissionRequest) error
}

// ResidentActivityClient is an optional narrow Runtime-to-Room transport for
// coarse transient Harness activity. Empty activity means clear. Keeping it
// outside Free4ChatClient preserves existing test doubles and compatibility
// clients while allowing the production client to expose only this bounded
// mutation.
//
// turnSequence is the exact canonical Room turn the activity belongs to (>0
// while an activity is published, 0 when clearing). It is transient control
// correlation only: it is never persisted, never enters a Harness prompt, and
// never leaves Room activity state.
type ResidentActivityClient interface {
	UpdateAgentActivity(participantHandle, scope string, activity AgentActivityState, turnSequence int64) error
}

// ResidentTaskExecutionClient is the one narrow Runtime-to-Room transport for
// the transient Task execution projection. Publication is best-effort
// presentation: a failure here must never fail a Harness turn, the pending
// queue, a Room join, or the Agent lifecycle, so callers log and continue.
type ResidentTaskExecutionClient interface {
	UpdateTaskExecution(participantHandle string, projection TaskExecutionProjection) error
}

// AttachmentRead is read_attachment's normalized result: either an image
// payload or a decoded text-like attachment copy.
type AttachmentRead struct {
	FileName string // returned attachment metadata, when available
	Data     string // base64 for images
	MimeType string
	Text     string // present only for text-like attachments
}
