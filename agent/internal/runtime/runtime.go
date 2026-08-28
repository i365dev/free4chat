package runtime

import (
	"errors"
	"strconv"
	"strings"
	"sync"

	"github.com/i365dev/free4chat/agent/internal/free4chat"
	"github.com/i365dev/free4chat/agent/internal/media"
	"github.com/i365dev/free4chat/agent/internal/speech"
	"github.com/i365dev/free4chat/agent/internal/types"
	"github.com/i365dev/free4chat/agent/internal/voice"
)

// State is the resident lifecycle state reported through status.
type State string

const (
	StateStarting     State = "starting"
	StateWaiting      State = "waiting"
	StateTurn         State = "turn"
	StateReconnecting State = "reconnecting"
	StateStopped      State = "stopped"
)

// Status is the side-effect-free status projection returned over IPC.
type Status struct {
	InstanceID    string `json:"instanceId"`
	RoomID        string `json:"roomId,omitempty"`
	Name          string `json:"name"`
	Adapter       string `json:"adapter"`
	State         State  `json:"state"`
	ParticipantID string `json:"participantId,omitempty"`
	LastError     string `json:"lastError,omitempty"`
}

// Options configures one ResidentRuntime.
type Options struct {
	InstanceID string
	// RoomID is known upfront for join lifecycles; empty for the
	// create-first lifecycle where StartByCreate resolves it.
	RoomID string
	Name   string
	Client types.Free4ChatClient
	// Adapter is the local ACP Harness boundary.
	Adapter types.HarnessAdapter
	// Capabilities are advertised verbatim at join time and re-advertised
	// on every (re)join so presence metadata survives reconnects.
	Capabilities []string
	Log          LogFunc
	// WaitSeconds overrides the long-poll window (tests); default 20.
	WaitSeconds int
	// OnRoomExpired is invoked after a natural room expiry has released
	// the runtime resources.
	OnRoomExpired func() error
	// SiteOrigin is the SFU REST origin derived from the MCP URL (media).
	SiteOrigin string
	// TranscriptPath is the per-instance local transcript file; empty
	// disables persistence (tests).
	TranscriptPath string
	// Speech is the resolved local speech configuration (nil = disabled).
	Speech *speech.Config
	// HostSeed is the PRIVATE random seed of this Runtime root (#176 Phase
	// A). The public, Room-scoped runtimeHostId is derived from it per Room
	// (never exposed raw) and re-projected on speech hot reload. Empty =
	// legacy caller; the Room then simply has no host grouping for this
	// participant. Projection failures are additive and never block a text
	// join.
	HostSeed string
	// Voice configures outbound Voice Reply (nil = Meeting Notes only).
	Voice *media.VoiceConfig
}

// ResidentRuntime owns exactly one Free4Chat participant across many Harness
// turns. The capability handle stays strictly inside this object: it never
// reaches a Harness turn, status payload, or log line.
//
// Shutdown semantics mirror the Node reference: Stop signals the loop and
// waits for the in-flight bounded long-poll (<= ~25s) to unwind before
// releasing resources — bounded shutdown without cancelling live HTTP calls.
type ResidentRuntime struct {
	options             Options
	log                 LogFunc
	mu                  sync.Mutex
	participantHandle   string // secret bearer capability
	participantID       string
	cursor              int64
	expiresAt           int64
	state               State
	lastError           string
	stopped             bool
	harnessFailed       bool
	turnRunning         bool
	lastHarnessSequence int64
	pendingAddressed    []int64
	eventBuffer         *EventBuffer
	advertisedCaps      []string
	roster              []types.ParticipantRosterEntry
	resolvedRoomID      string

	loopWG      sync.WaitGroup
	cleanupOnce sync.Once
	stopCh      chan struct{}

	mediaController *media.Controller
	mediaMu         sync.Mutex
	// speechConfig is copied from Options at construction and guarded by mu.
	// Media rebuilds consume an immutable snapshot rather than reading Options
	// concurrently with credential hot reload.
	speechConfig speech.Config
	transcriber  *speech.Transcriber
	transcript   *speech.TranscriptStore
	// voiceSrc is the controller-backed voice boundary; tests may inject a
	// fake to observe dispatch ordering deterministically.
	voiceSrc voiceSource
}

// ReloadSpeech replaces only the optional provider configuration and rebuilds
// the additive media bridge against the current participant capability. It
// never leaves, reconnects, or restarts the text/Harness lifecycle.
func (r *ResidentRuntime) ReloadSpeech(config speech.Config) {
	r.mu.Lock()
	r.speechConfig = config
	// #176 Phase A: host-owned speech readiness changes with the credential
	// state; the derived projection below re-reads the fresh snapshot, so
	// every same-host resident projection updates consistently.
	handle := r.participantHandle
	stopped := r.stopped
	r.mu.Unlock()
	if !stopped && handle != "" {
		r.restartMediaController(handle)
		r.projectRuntimeHost(handle)
	}
}

// hostProjectionFor derives the projection to send with a join/rejoin for
// the given final Room id. Nil on any failure: the projection is additive
// (#178 review fix 5) and never blocks the text join.
func (r *ResidentRuntime) hostProjectionFor(roomID string) *types.RuntimeHostProjection {
	if roomID == "" || r.options.HostSeed == "" {
		return nil
	}
	return r.CurrentHostProjection()
}

// projectRuntimeHost pushes the current Runtime Host projection to the Room
// (#176 Phase A) so readiness hot reload reaches the Room without any
// resident rejoining. Best-effort: text behavior is unaffected on failure.
func (r *ResidentRuntime) projectRuntimeHost(handle string) {
	host := r.CurrentHostProjection()
	if host == nil {
		return
	}
	// #178 review fix 5: additive and bounded. A rejected or failed
	// projection never blocks text behavior; diagnostics carry no seed,
	// handle, or credential material.
	if err := r.options.Client.UpdateRuntimeHost(handle, *host); err != nil {
		r.log("runtime_host_projection_failed", map[string]string{
			"reason": string(free4chat.CodeOf(err)),
		})
	}
}

// speechSnapshot returns a copy that remains stable throughout a media
// rebuild. Credential values never leave the Runtime/media boundary.
func (r *ResidentRuntime) speechSnapshot() speech.Config {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.speechConfig
}

// voiceSource is the minimal voice-output surface the turn pipeline needs.
type voiceSource interface {
	CurrentVoiceOutput() *voice.Speaker
}

// NewResidentRuntime builds a runtime; no network activity yet.
func NewResidentRuntime(options Options) *ResidentRuntime {
	if options.Log == nil {
		options.Log = DefaultLog
	}
	wait := options.WaitSeconds
	if wait <= 0 {
		wait = WaitSeconds
	}
	options.WaitSeconds = wait
	speechConfig := speech.Config{}
	if options.Speech != nil {
		speechConfig = *options.Speech
	}
	return &ResidentRuntime{
		options:        options,
		log:            options.Log,
		state:          StateStarting,
		eventBuffer:    NewEventBuffer(0, 0),
		advertisedCaps: append([]string(nil), options.Capabilities...),
		stopCh:         make(chan struct{}),
		resolvedRoomID: options.RoomID,
		speechConfig:   speechConfig,
	}
}

// activeRoomID prefers the created room id once adoption happened.
func (r *ResidentRuntime) activeRoomID() string {
	if r.resolvedRoomID != "" {
		return r.resolvedRoomID
	}
	return r.options.RoomID
}

// CurrentHostProjection derives the #176 Phase A Room-scoped Runtime Host
// projection for THIS runtime's current Room: opaque grouping key plus
// coarse readiness. The private root seed never appears in the result; a
// missing seed, missing Room, or derivation failure yields nil (the
// projection is additive and never blocks text behavior).
func (r *ResidentRuntime) CurrentHostProjection() *types.RuntimeHostProjection {
	seed := r.options.HostSeed
	if seed == "" {
		return nil
	}
	roomID := r.activeRoomID()
	if roomID == "" {
		return nil
	}
	id, err := types.DeriveRuntimeHostID(seed, roomID)
	if err != nil {
		r.log("runtime_host_projection_unavailable", map[string]string{
			"reason": "derive_failed",
		})
		return nil
	}
	speechConfig := r.speechSnapshot()
	return &types.RuntimeHostProjection{
		RuntimeHostID: id,
		Speech: types.HostSpeechReadiness{
			STT: speechConfig.STTEnabled,
			TTS: speechConfig.TTSEnabled,
		},
	}
}

// CurrentCapabilities returns the currently advertised tokens.
func (r *ResidentRuntime) CurrentCapabilities() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.advertisedCaps...)
}

// Status snapshots the lifecycle state. It never contains the handle.
func (r *ResidentRuntime) Status() Status {
	r.mu.Lock()
	defer r.mu.Unlock()
	return Status{
		InstanceID:    r.options.InstanceID,
		RoomID:        r.activeRoomID(),
		Name:          r.options.Name,
		Adapter:       r.options.Adapter.Name(),
		State:         r.state,
		ParticipantID: r.participantID,
		LastError:     r.lastError,
	}
}

// Start performs the normal join lifecycle and launches the wait loop.
func (r *ResidentRuntime) Start() error {
	if err := r.prepareLifecycle(); err != nil {
		return err
	}
	if err := r.join(); err != nil {
		return err
	}
	r.StartLoop()
	return nil
}

// StartLoop launches the wait loop. It must be called only AFTER any
// external registry admission the owner needs (the daemon registers the
// resident before starting the loop, so a room_expired reported by the very
// first long-poll can never race an unregister against a not-yet-done
// register). Safe to call once per lifecycle; the loop exits immediately on
// a stopped runtime.
func (r *ResidentRuntime) StartLoop() {
	r.loopWG.Add(1)
	go r.waitLoop()
}

// AdoptCreate implements the create-first lifecycle (#51) up to adoption:
// connects the Harness first (a Harness failure must never orphan a created
// room), then atomically creates a fresh room registering this agent as
// participant #1, and adopts the create result exactly like a normal join —
// WITHOUT launching the wait loop. The owner must call StartLoop() after any
// registry admission. JoinRoom is never called for this room until a later
// lease-expiry reconnect, which always uses the normal join path and can
// never re-create.
func (r *ResidentRuntime) AdoptCreate() (types.CreateRoomResult, error) {
	if err := r.prepareLifecycle(); err != nil {
		return types.CreateRoomResult{}, err
	}
	// #176 Phase A: the create-first lifecycle projects the host identity
	// exactly like a normal join.
	created, err := r.options.Client.CreateRoom(
		r.options.Name, r.advertisedCopy(), nil) // create-first derives AFTER the final roomId exists
	if err != nil {
		return types.CreateRoomResult{}, err
	}
	r.mu.Lock()
	r.resolvedRoomID = created.Invite.RoomID
	r.mu.Unlock()
	r.adoptJoin(created.JoinResult)
	// #178 review fix 3: create-first derives the Room-scoped runtimeHostId
	// AFTER the final server-generated roomId exists, then pushes it
	// additively (the register itself carried no projection).
	if handle := r.currentHandle(); handle != "" {
		r.projectRuntimeHost(handle)
	}
	return created, nil
}

// StartByCreate is the combined create-first lifecycle for owners without a
// separate admission step: AdoptCreate + StartLoop.
func (r *ResidentRuntime) StartByCreate() (types.CreateRoomResult, error) {
	created, err := r.AdoptCreate()
	if err != nil {
		return types.CreateRoomResult{}, err
	}
	r.StartLoop()
	return created, nil
}

// prepareLifecycle connects MCP then the Harness session — ordering matters:
// the Harness session exists before any room is joined or created, so local
// readiness failures happen before room admission.
func (r *ResidentRuntime) prepareLifecycle() error {
	if r.options.TranscriptPath != "" {
		store := speech.NewTranscriptStore(r.options.TranscriptPath)
		if err := store.Ready(); err != nil {
			// Transcript persistence is optional; a filesystem failure must
			// never prevent the text Agent from joining the room.
			r.log("meeting_transcript_init_failed", nil)
		} else {
			r.transcript = store
		}
	}
	if err := r.options.Client.Connect(); err != nil {
		return err
	}
	return r.options.Adapter.EnsureSession()
}

func (r *ResidentRuntime) advertisedCopy() []string {
	return append([]string(nil), r.advertisedCaps...)
}

func (r *ResidentRuntime) join() error {
	// #176 Phase A: every (re)join re-projects this Runtime's own host
	// identity — a reconnect can never inherit another host's state.
	joined, err := r.options.Client.JoinRoom(
		r.activeRoomID(), r.options.Name, r.advertisedCopy(), r.hostProjectionFor(r.activeRoomID()))
	if err != nil {
		return err
	}
	r.adoptJoin(joined)
	return nil
}

// adoptJoin is the single adoption path for any successful room acquisition
// (join or create): resets cursor/event state from the returned capability.
func (r *ResidentRuntime) adoptJoin(joined types.JoinResult) {
	r.mu.Lock()
	// The capability is intentionally kept only in this object and never
	// included in turns, status, or logs.
	r.participantHandle = joined.ParticipantHandle
	r.participantID = joined.ParticipantID
	r.cursor = joined.Cursor
	r.lastHarnessSequence = joined.Cursor
	r.expiresAt = joined.ExpiresAt
	r.eventBuffer.Clear()
	r.pendingAddressed = nil
	r.state = StateWaiting
	r.lastError = ""
	r.mu.Unlock()
	// Media controller (re)build happens OUTSIDE the runtime lock: it may
	// stop the previous bridge, create a transcriber, and poll room_info —
	// none of that may hold the runtime mutex.
	r.restartMediaController(joined.ParticipantHandle)
}

// requireHandle returns the live capability or fails closed.
func (r *ResidentRuntime) requireHandle() (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.participantHandle == "" {
		return "", errors.New("runtime is not connected to a room")
	}
	return r.participantHandle, nil
}

func (r *ResidentRuntime) waitLoop() {
	defer r.loopWG.Done()
	retryAttempt := 0
	for {
		if r.isStopped() {
			return
		}
		handle := r.currentHandle()
		if handle == "" {
			return
		}
		result, err := r.options.Client.WaitForEvents(handle, r.currentCursor(), r.options.WaitSeconds)

		if err != nil {
			if r.isStopped() {
				return
			}
			switch free4chat.CodeOf(err) {
			case free4chat.CodeInvalidParticipantHandle:
				if !r.rejoinAfterExpiry() {
					return
				}
				retryAttempt = 0
				continue
			case free4chat.CodeRoomExpired:
				r.cleanupAfterRoomExpiry()
				return
			default:
				retryAttempt++
				delay := RetryDelay(retryAttempt - 1)
				r.setStateLastError(StateReconnecting, err.Error())
				r.log("wait_retry", map[string]string{"delayMs": strconv.FormatInt(delay.Milliseconds(), 10)})
				if !r.sleep(delay) {
					return
				}
				r.restoreStateAfterRetry()
				continue
			}
		}

		retryAttempt = 0
		r.advanceFromWait(result)
		if len(r.pendingAddressedSnapshot()) > 0 && !r.isStopped() {
			r.drainTurns()
		}
	}
}

func (r *ResidentRuntime) advanceFromWait(result types.WaitResult) {
	r.mu.Lock()
	if result.Cursor > r.cursor {
		r.cursor = result.Cursor
	}
	r.expiresAt = result.ExpiresAt
	if len(result.Participants) > 0 {
		r.roster = append([]types.ParticipantRosterEntry(nil), result.Participants...)
	}
	r.mu.Unlock()
	for _, event := range result.Events {
		r.acceptEvent(event)
	}
}

func (r *ResidentRuntime) acceptEvent(event types.RoomEvent) {
	r.mu.Lock()
	r.eventBuffer.Add(event)
	if event.Addressed {
		r.pendingAddressed = BoundedPush(r.pendingAddressed, event.Sequence, MaxPendingTurns)
	}
	r.mu.Unlock()
}

func (r *ResidentRuntime) restoreStateAfterRetry() {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch {
	case r.harnessFailed:
		r.state = StateReconnecting
	case r.turnRunning:
		r.state = StateTurn
	default:
		r.state = StateWaiting
	}
}

// drainTurns serially processes queued addressed events. Events between the
// last delivered sequence and each pending target are replayed from the
// bounded buffer exactly once. Mirroring the Node reference, the first
// failure (Harness turn or send) aborts the remaining queued targets of
// this pass; surviving queue entries are re-driven by the next successful
// wait cycle, and no redelivery of already-consumed sequences ever happens.
func (r *ResidentRuntime) drainTurns() {
	r.mu.Lock()
	if r.turnRunning || r.stopped {
		r.mu.Unlock()
		return
	}
	r.turnRunning = true
	r.state = StateTurn
	r.mu.Unlock()

	defer func() {
		r.mu.Lock()
		r.turnRunning = false
		if !r.stopped {
			if r.harnessFailed {
				r.state = StateReconnecting
			} else {
				r.state = StateWaiting
			}
		}
		r.mu.Unlock()
	}()

	for !r.isStopped() {
		target, ok := r.popPending()
		if !ok {
			return
		}
		events := r.bufferSince(r.lastSeq(), target)
		if len(events) == 0 {
			continue
		}
		maxSeq := events[0].Sequence
		for _, event := range events[1:] {
			if event.Sequence > maxSeq {
				maxSeq = event.Sequence
			}
		}
		r.setLastSeq(maxSeq)

		input := BuildHarnessTurn(events, &TurnContextOptions{
			Self:         r.selfContext(),
			Participants: r.rosterSnapshot(),
		})
		r.enrichAttachments(input)
		r.attachTranscript(input)

		// A newly addressed turn wins the speaker: stale audio from the
		// previous response must never keep playing over the new one.
		if voiceOutput := r.voiceOutput(); voiceOutput != nil {
			voiceOutput.Cancel()
		}

		result, err := r.options.Adapter.RunTurn(*input)
		if err != nil {
			r.setStateLastError(StateReconnecting, err.Error())
			r.log("turn_failed", nil)
			return
		}
		r.mu.Lock()
		r.harnessFailed = false
		r.mu.Unlock()

		text := strings.TrimSpace(result.Text)
		if text == "" {
			continue
		}
		handle, err := r.requireHandle()
		if err != nil {
			r.setStateLastError(StateReconnecting, err.Error())
			r.log("turn_failed", nil)
			return
		}
		sent, err := r.options.Client.SendText(handle, text, result.TargetParticipantIDs)
		if err != nil {
			r.setStateLastError(StateReconnecting, err.Error())
			r.log("turn_failed", nil)
			return
		}
		r.log("message_persisted", map[string]string{
			"sequence": strconv.FormatInt(sent.Sequence, 10),
		})
		// Voice Reply is additive: speak only after the text reply is
		// persisted; a nil/unready output keeps the turn text-only.
		if voiceOutput := r.voiceOutput(); voiceOutput != nil {
			voiceOutput.Speak(text)
		}
	}
}

// enrichAttachments applies the shared enrichment pass with the negotiated
// image capability.
func (r *ResidentRuntime) enrichAttachments(input *types.HarnessTurnInput) {
	imagesSupported := true
	if caps := r.options.Adapter.Capabilities(); caps != nil && !caps.Images {
		imagesSupported = false
	}
	opts := &EnrichOptions{ImagesSupported: &imagesSupported}
	readAttachment := func(attachmentID string) (types.AttachmentRead, error) {
		handle, err := r.requireHandle()
		if err != nil {
			return types.AttachmentRead{}, err
		}
		return r.options.Client.ReadAttachment(handle, attachmentID)
	}
	unavailable := func(event types.HarnessEvent, message string) {
		id := "unknown"
		if event.Attachment != nil {
			id = event.Attachment.ID
		}
		// Diagnostics carry attachment ids and error text only — never
		// capability data or decoded content.
		r.log("attachment_unavailable", map[string]string{
			"attachmentId": id,
			"error":        message,
		})
	}
	EnrichTurnAttachments(input, readAttachment, unavailable, opts)
}

func (r *ResidentRuntime) selfContext() *types.RoomSelfContext {
	caps := r.CurrentCapabilities()
	self := &types.RoomSelfContext{
		InstanceID: r.options.InstanceID,
		Name:       r.options.Name,
	}
	if id := r.currentParticipantID(); id != "" {
		self.ParticipantID = id
	}
	if len(caps) > 0 {
		self.Capabilities = caps
	}
	return self
}

// rejoinAfterExpiry repeatedly joins with back-off after lease loss. Returns
// whether the loop should continue. Room expiry hands over to full cleanup.
func (r *ResidentRuntime) rejoinAfterExpiry() bool {
	if r.isStopped() {
		return false
	}
	r.setState(StateReconnecting)
	r.log("participant_rejoin", nil)
	r.mu.Lock()
	r.participantHandle = ""
	r.participantID = ""
	r.mu.Unlock()

	attempt := 0
	for {
		if r.isStopped() {
			return false
		}
		err := r.join()
		if err == nil {
			return true
		}
		if free4chat.CodeOf(err) == free4chat.CodeRoomExpired {
			r.cleanupAfterRoomExpiry()
			return false
		}
		attempt++
		delay := RetryDelay(attempt - 1)
		r.setStateLastError("", err.Error())
		r.log("rejoin_retry", map[string]string{
			"delayMs": strconv.FormatInt(delay.Milliseconds(), 10),
		})
		if !r.sleep(delay) {
			return false
		}
	}
}

// UpdateCapabilities replaces the advertised list in place (#106 Phase A):
// the room record updates immediately and every future (re)join reuses it,
// so the advertisement survives lease-expiry rejoins.
func (r *ResidentRuntime) UpdateCapabilities(capabilities []string) error {
	handle, err := r.requireHandle()
	if err != nil {
		return err
	}
	if err := r.options.Client.UpdateCapabilities(handle, capabilities); err != nil {
		return err
	}
	r.mu.Lock()
	r.advertisedCaps = append([]string(nil), capabilities...)
	r.mu.Unlock()
	return nil
}

// CollabRequest forwards a structured collaboration request using the live
// handle; duplicate replays flagged by the server are preserved here.
func (r *ResidentRuntime) CollabRequest(args types.CollabRequestArgs) (types.CollabRequestOutcome, error) {
	handle, err := r.requireHandle()
	if err != nil {
		return types.CollabRequestOutcome{}, err
	}
	return r.options.Client.SendCollabRequest(handle, args)
}

// CollabResponse answers someone else's request targeting us.
func (r *ResidentRuntime) CollabResponse(args types.CollabResponseArgs) (types.SendTextResult, error) {
	handle, err := r.requireHandle()
	if err != nil {
		return types.SendTextResult{}, err
	}
	return r.options.Client.SendCollabResponse(handle, args)
}

// CollabResult publishes the structured outcome of accepted work.
func (r *ResidentRuntime) CollabResult(args types.CollabResultArgs) (types.SendTextResult, error) {
	handle, err := r.requireHandle()
	if err != nil {
		return types.SendTextResult{}, err
	}
	return r.options.Client.SendCollabResult(handle, args)
}

// UploadAttachment stores an artifact in the room's ephemeral store; the
// returned attachment ID is what a collab result references via --attach.
func (r *ResidentRuntime) UploadAttachment(file types.AttachmentUpload) (types.UploadedAttachment, error) {
	handle, err := r.requireHandle()
	if err != nil {
		return types.UploadedAttachment{}, err
	}
	return r.options.Client.UploadAttachment(handle, file)
}

// PublishSurface publishes or replaces this agent's single workspace
// snapshot (#111). Thin passthrough; the handle stays inside the runtime.
func (r *ResidentRuntime) PublishSurface(payload types.SurfacePublishPayload) (types.RoomSurfaceMetadataV1, error) {
	handle, err := r.requireHandle()
	if err != nil {
		return types.RoomSurfaceMetadataV1{}, err
	}
	return r.options.Client.PublishSurface(handle, payload)
}

// ClearSurface removes the published snapshot.
func (r *ResidentRuntime) ClearSurface() error {
	handle, err := r.requireHandle()
	if err != nil {
		return err
	}
	return r.options.Client.ClearSurface(handle)
}

// ReadSurface reads exactly the requested peer snapshot.
func (r *ResidentRuntime) ReadSurface(sourceParticipantID, snapshotID string) (types.SurfaceReadResult, error) {
	handle, err := r.requireHandle()
	if err != nil {
		return types.SurfaceReadResult{}, err
	}
	return r.options.Client.ReadSurface(handle, sourceParticipantID, snapshotID)
}

// PeerSurface returns the sanitized metadata of a peer's published snapshot,
// used by CLI `surface read` to pin the exact snapshotId before bytes move.
func (r *ResidentRuntime) PeerSurface(sourceParticipantID string) *types.RoomSurfaceMetadataV1 {
	for _, entry := range r.rosterSnapshot() {
		if entry.ID == sourceParticipantID {
			return entry.Surface
		}
	}
	return nil
}

// cleanupAfterRoomExpiry performs the natural-expiry teardown once.
func (r *ResidentRuntime) cleanupAfterRoomExpiry() {
	r.cleanupOnce.Do(func() {
		r.mu.Lock()
		r.stopped = true
		r.state = StateStopped
		r.lastError = "room_expired"
		r.mu.Unlock()
		close(r.stopCh)
		r.releaseResources()
		if r.options.OnRoomExpired != nil {
			if err := r.options.OnRoomExpired(); err != nil {
				r.log("room_expiry_cleanup_failed", nil)
			}
		}
	})
}

// Stop tears everything down: signal the loop, wait for the in-flight
// bounded long-poll to unwind, best-effort cancel any running Harness turn,
// release the room lease, close the ACP process, and close the client.
func (r *ResidentRuntime) Stop() {
	r.cleanupOnce.Do(func() {
		r.mu.Lock()
		r.stopped = true
		r.state = StateStopped
		r.mu.Unlock()
		close(r.stopCh)
	})
	r.releaseResources()
	r.loopWG.Wait()
}

// releaseResources mirrors the Node cleanupResources ordering: media first
// (bounded teardown), then the lease, then Harness/client.
func (r *ResidentRuntime) releaseResources() {
	r.mediaMu.Lock()
	defer r.mediaMu.Unlock()
	if r.mediaController != nil {
		r.mediaController.Stop()
		r.mediaController = nil
	}
	if r.transcriber != nil {
		r.transcriber.Close()
		r.transcriber = nil
	}
	if r.transcript != nil {
		r.transcript.Dispose()
		r.transcript = nil
	}
	// Cancel a possibly-stuck Harness turn; closing the ACP process below
	// remains the final cancellation boundary.
	_ = r.options.Adapter.CancelTurn()
	if handle := r.currentHandle(); handle != "" {
		_ = r.options.Client.LeaveRoom(handle)
	}
	_ = r.options.Adapter.Close()
	_ = r.options.Client.Close()
}
