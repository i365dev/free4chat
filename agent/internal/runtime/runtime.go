package runtime

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"time"

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

const roomScope = "room"

var errTaskTextUnsupported = errors.New("task-scoped text transport is unavailable")

// logicalSessionState is Runtime-local cognition state for one logical
// scope. Room transport, participant credentials, roster, and the bounded
// source event buffer remain ResidentRuntime-level state.
type logicalSessionState struct {
	deliveredThrough               int64
	roomDeliveryFloor              int64
	pendingAddressed               []int64
	pendingContexts                map[int64]pendingTurnContext
	observedHarnessGeneration      int64
	bootstrappedHarnessGeneration  int64
	meetingDeliveredThrough        int64
	meetingDeliveryFloor           int64
	liveTranscriptDeliveredThrough int64
	liveTranscriptDeliveryFloor    int64
	sourceCursors                  map[string]int64
}

// Status is the side-effect-free status projection returned over IPC.
type Status struct {
	InstanceID    string `json:"instanceId"`
	RoomID        string `json:"roomId,omitempty"`
	Name          string `json:"name"`
	Adapter       string `json:"adapter"`
	State         State  `json:"state"`
	ParticipantID string `json:"participantId,omitempty"`
	LastError     string `json:"lastError,omitempty"`
	// HarnessSessions is optional local ACP observability. It contains only
	// logical scope, opaque session identity, and generation; it is never
	// copied into Room/MCP state or Harness prompts.
	HarnessSessions []types.HarnessSessionDiagnostic `json:"harnessSessions,omitempty"`
	// ParticipatingSince is the epoch-ms timestamp of the resident's first
	// successful join/create for the CURRENT lifecycle (#228). Preserved
	// across transient retries/reconnects; a new resident lifecycle starts
	// a new timestamp. Room participation age, not socket uptime.
	ParticipatingSince int64 `json:"participatingSince,omitempty"`
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
	// OnSelfLeave is the daemon/host-owned asynchronous cleanup handoff after
	// this Runtime has already confirmed leave_room successfully. It must not
	// synchronously call Stop: the current addressed turn is running inside
	// the wait-loop goroutine that Stop waits for.
	OnSelfLeave func()
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
	// HostVoiceGate is daemon-owned and shared by every resident Runtime on
	// this local Runtime Host. It serializes full TTS+publication operations.
	HostVoiceGate voice.Gate
	// ProviderClaim is a one-time raw Human-created Room capability. It is
	// copied out of Options at construction and cleared immediately after a
	// successful redemption; it never reaches Status or a Harness.
	ProviderClaim string
	// ProviderHandles is daemon-owned volatile storage shared by residents of
	// the same local Runtime Host. It is intentionally never persisted.
	ProviderHandles *ProviderHandleStore
	// TranscriptProducers is the daemon-local lease coordinator for a
	// Room-selected Live Transcript Runtime Host. Nil disables the optional
	// producer path fail-closed while preserving text and legacy media.
	TranscriptProducers media.LiveTranscriptCoordinator
}

// ResidentRuntime owns exactly one Free4Chat participant across many Harness
// turns. The capability handle stays strictly inside this object: it never
// reaches a Harness turn, status payload, or log line.
//
// Shutdown semantics mirror the Node reference: Stop signals the loop and
// closes the hibernatable event stream before releasing resources. The public
// MCP long-poll remains available to direct callers and compatibility test
// clients, but is not the transport used by the built-in resident Runtime.
type ResidentRuntime struct {
	options           Options
	log               LogFunc
	mu                sync.Mutex
	participantHandle string // secret bearer capability
	participantID     string
	cursor            int64
	expiresAt         int64
	agentLeaseMs      int64
	state             State
	lastError         string
	stopped           bool
	harnessFailed     bool
	turnRunning       bool
	// deliveredThrough is the highest Room event sequence successfully
	// consumed by the current retained Harness conversation. It is NOT the
	// Room transport cursor: receiving an event only advances cursor.
	deliveredThrough int64
	// roomDeliveryFloor excludes older bounded Room history from automatic
	// push after a genuine ACP session/new. It is not an acknowledgement:
	// that older history remains available through explicit context read.
	roomDeliveryFloor int64
	pendingAddressed  []int64
	pendingContexts   map[int64]pendingTurnContext
	// observedHarnessGeneration is the ACP session/new generation most
	// recently observed before rendering a prompt. bootstrappedHarnessGeneration
	// advances only after that generation successfully consumes its bootstrap
	// turn; observing a session is never an acknowledgement.
	observedHarnessGeneration     int64
	bootstrappedHarnessGeneration int64
	// Transcript delivery keeps a per-ACP-session success marker plus a
	// baseline captured at session/new. The baseline deliberately leaves old
	// shared context pullable instead of dumping it into a new conversation.
	meetingDeliveredThrough        int64
	meetingDeliveryFloor           int64
	liveTranscriptDeliveredThrough int64
	liveTranscriptDeliveryFloor    int64
	eventBuffer                    *EventBuffer
	// scopedSessions contains only non-default logical scopes. The legacy
	// fields above remain the Room scope so the proven #223 delivery path and
	// its invariants stay structurally unchanged.
	scopedSessions map[string]*logicalSessionState
	scopeOrder     []string
	advertisedCaps []string
	roster         []types.ParticipantRosterEntry
	resolvedRoomID string
	// participatingSince is set once on the lifecycle's first successful
	// adoptJoin and preserved across transient retries/reconnects (#228).
	participatingSince int64
	// lastErrorSource records WHICH runtime subsystem produced the current
	// lastError (#228): wait, harness (RunTurn/requireHandle), or send
	// (SendText). A subsystem's successful operation clears ONLY its own
	// error — a successful wait never hides an unresolved Harness or send
	// failure. Empty = no current unresolved condition.
	lastErrorSource        string
	providerClaim          string
	providerHandles        *ProviderHandleStore
	permissionMu           sync.Mutex
	pendingPermissions     map[string]*pendingRoomPermission
	permissionReaderMu     sync.Mutex
	permissionReaderCancel context.CancelFunc
	permissionReaderDone   chan struct{}

	loopWG      sync.WaitGroup
	cleanupOnce sync.Once
	stopCh      chan struct{}
	residentMu  sync.Mutex
	resident    types.ResidentEventStream

	mediaController *media.Controller
	mediaMu         sync.Mutex
	// residentMediaStateApplyMu serializes cache changes with their Controller
	// application. It is held across the apply call so a replay cannot take a
	// stale snapshot, yield to revocation, and then re-enable media afterward.
	residentMediaStateApplyMu sync.Mutex
	// residentMediaState is the last authenticated media projection. It is
	// replayed only when a live resident controller is rebuilt (for example by
	// speech hot reload); transport loss invalidates it before reconnect.
	residentMediaStateMu    sync.Mutex
	residentMediaState      types.ResidentMediaState
	residentMediaStateValid bool
	activityMu              sync.Mutex
	activities              map[string]types.AgentActivityState
	activityTurnActive      bool
	activityScope           string
	// mediaGeneration invalidates callbacks from a stopped/replaced bridge.
	// Bridge teardown reports TrackEnded asynchronously so it cannot re-enter
	// mediaMu; without this generation fence, a late old callback could end a
	// newly-created transcriber for the same Human track.
	mediaGeneration uint64
	// speechConfig is copied from Options at construction and guarded by mu.
	// Media rebuilds consume an immutable snapshot rather than reading Options
	// concurrently with credential hot reload.
	speechConfig speech.Config
	transcriber  *speech.Transcriber
	transcript   *speech.TranscriptStore
	// Live Transcript producer state is only local callback admission state;
	// committed text lives in the Room control plane, never in this cache.
	liveTranscript          types.LiveTranscriptInfo
	liveTranscriptProducing bool
	sttGeneration           uint64
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
		r.replayResidentMediaState()
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
	var err error
	if providerClient, ok := r.options.Client.(types.RuntimeHostProviderClient); ok {
		providerHandle := r.providerHandles.Get(r.activeRoomID(), host.RuntimeHostID)
		if providerHandle != "" {
			err = providerClient.UpdateRuntimeHostWithRuntimeProvider(handle, *host, providerHandle)
			// A true Human departure revokes the Room association but an
			// already-running daemon still has its volatile proof. Drop only a
			// server-confirmed stale handle, then retry this one projection as
			// ordinary unbound Phase-A discovery. Do not downgrade proof_required
			// or transient failures: those must remain visible diagnostics.
			if free4chat.CodeOf(err) == free4chat.CodeRuntimeProviderHandleInvalid {
				r.providerHandles.Delete(r.activeRoomID(), host.RuntimeHostID)
				err = r.options.Client.UpdateRuntimeHost(handle, *host)
			}
		} else {
			err = r.options.Client.UpdateRuntimeHost(handle, *host)
		}
	} else {
		err = r.options.Client.UpdateRuntimeHost(handle, *host)
	}
	if err != nil {
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
	providerClaim := options.ProviderClaim
	options.ProviderClaim = ""
	providerHandles := options.ProviderHandles
	if providerHandles == nil {
		providerHandles = NewProviderHandleStore()
	}
	runtime := &ResidentRuntime{
		options:            options,
		log:                options.Log,
		state:              StateStarting,
		eventBuffer:        NewEventBuffer(0, 0),
		advertisedCaps:     append([]string(nil), options.Capabilities...),
		stopCh:             make(chan struct{}),
		resolvedRoomID:     options.RoomID,
		speechConfig:       speechConfig,
		providerClaim:      providerClaim,
		providerHandles:    providerHandles,
		pendingPermissions: make(map[string]*pendingRoomPermission),
		activities:         make(map[string]types.AgentActivityState),
	}
	configurePermissionResponder(runtime)
	configureActivityHandler(runtime)
	return runtime
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

// ConnectProviderClaim binds this already-running resident Runtime Host to a
// Human-created Room claim. The existing participant remains the sole Agent;
// only the private daemon-memory provider handle is updated.
func (r *ResidentRuntime) ConnectProviderClaim(providerClaim string) error {
	if !types.ValidRuntimeProviderCredential(providerClaim) {
		return errors.New("runtime provider claim is malformed")
	}
	handle, err := r.requireHandle()
	if err != nil {
		return err
	}
	host := r.CurrentHostProjection()
	if host == nil {
		return errors.New("runtime provider connection requires a Runtime Host identity")
	}
	providerClient, ok := r.options.Client.(types.RuntimeProviderConnector)
	if !ok {
		return errors.New("runtime provider connection is unavailable")
	}
	claimHash, err := types.DeriveRuntimeProviderClaimHash(r.activeRoomID(), providerClaim)
	if err != nil {
		return err
	}
	providerHandle, err := providerClient.ConnectRuntimeProvider(handle, *host, claimHash)
	if err != nil {
		return err
	}
	r.providerHandles.Put(r.activeRoomID(), host.RuntimeHostID, providerHandle)
	return nil
}

// Status snapshots the lifecycle state. It never contains the handle.
func (r *ResidentRuntime) Status() Status {
	var harnessSessions []types.HarnessSessionDiagnostic
	if adapter, ok := r.options.Adapter.(types.HarnessSessionDiagnostics); ok {
		harnessSessions = append(harnessSessions, adapter.SessionDiagnostics()...)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return Status{
		InstanceID:         r.options.InstanceID,
		RoomID:             r.activeRoomID(),
		Name:               r.options.Name,
		Adapter:            r.options.Adapter.Name(),
		State:              r.state,
		ParticipantID:      r.participantID,
		LastError:          r.lastError,
		HarnessSessions:    harnessSessions,
		ParticipatingSince: r.participatingSince,
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
	if resident, ok := r.options.Client.(types.ResidentEventClient); ok {
		go r.residentWaitLoop(resident)
		return
	}
	// Keep the old loop for injected clients that intentionally implement only
	// the public Free4ChatClient interface. The production Client implements
	// ResidentEventClient, so this is not an official-runtime fallback.
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
	created, err := r.options.Client.CreateRoom(r.options.Name, r.advertisedCopy())
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
	roomID := r.activeRoomID()
	host := r.hostProjectionFor(roomID)
	r.mu.Lock()
	providerClaim := r.providerClaim
	r.mu.Unlock()
	if providerClaim != "" && host == nil {
		return errors.New("runtime provider claim requires a Runtime Host identity")
	}

	providerHandle := ""
	if host != nil {
		providerHandle = r.providerHandles.Get(roomID, host.RuntimeHostID)
	}
	var joined types.JoinResult
	var err error
	if providerClient, ok := r.options.Client.(types.RuntimeHostProviderClient); ok && host != nil && (providerClaim != "" || providerHandle != "") {
		claimHash := ""
		if providerClaim != "" {
			claimHash, err = types.DeriveRuntimeProviderClaimHash(roomID, providerClaim)
			if err != nil {
				return err
			}
			providerHandle = ""
		}
		joined, err = providerClient.JoinRoomWithRuntimeProvider(
			roomID, r.options.Name, r.advertisedCopy(), host, claimHash, providerHandle,
		)
		// A true Human departure removes the association. An old daemon-memory
		// handle must not keep the Runtime from retaining text residency, so
		// discard it and rejoin without a Host projection on that exact failure.
		if err != nil && providerHandle != "" && free4chat.CodeOf(err) == free4chat.CodeRuntimeProviderHandleInvalid {
			r.providerHandles.Delete(roomID, host.RuntimeHostID)
			joined, err = r.options.Client.JoinRoom(roomID, r.options.Name, r.advertisedCopy(), nil)
		}
	} else {
		joined, err = r.options.Client.JoinRoom(roomID, r.options.Name, r.advertisedCopy(), host)
		// If a daemon restarted after a claim was redeemed, it has no private
		// proof by design. Preserve text-only residency rather than pretending
		// the public Host projection is authorized.
		if err != nil && host != nil && providerClaim == "" && free4chat.CodeOf(err) == free4chat.CodeRuntimeProviderProofRequired {
			joined, err = r.options.Client.JoinRoom(roomID, r.options.Name, r.advertisedCopy(), nil)
		}
	}
	if err != nil {
		return err
	}
	if host != nil && joined.RuntimeProviderHandle != "" {
		r.providerHandles.Put(roomID, host.RuntimeHostID, joined.RuntimeProviderHandle)
		r.mu.Lock()
		r.providerClaim = ""
		r.mu.Unlock()
	}
	r.adoptJoin(joined)
	return nil
}

// adoptJoin adopts a Room capability. The first join establishes the delivery
// baseline; a later transport reconnect replaces stale Room credentials but
// preserves pending work and retained-Harness delivery knowledge.
func (r *ResidentRuntime) adoptJoin(joined types.JoinResult) {
	r.mu.Lock()
	// The capability is intentionally kept only in this object and never
	// included in turns, status, or logs.
	r.participantHandle = joined.ParticipantHandle
	r.participantID = joined.ParticipantID
	r.cursor = joined.Cursor
	r.expiresAt = joined.ExpiresAt
	r.agentLeaseMs = joined.AgentLeaseMs
	initialJoin := r.participatingSince == 0
	if initialJoin {
		// A brand-new Runtime has no buffered Room history and no prior
		// Harness delivery to preserve. Its first current turn starts from the
		// server cursor captured at admission.
		r.deliveredThrough = joined.Cursor
		r.roomDeliveryFloor = joined.Cursor
		r.eventBuffer.Clear()
		r.pendingAddressed = nil
		r.pendingContexts = nil
		r.scopedSessions = nil
		r.scopeOrder = nil
	}
	r.state = StateWaiting
	r.lastError = ""
	r.lastErrorSource = ""
	// #228: participation age starts at the lifecycle's first successful
	// create/join and survives transient retries and lease recovery.
	if initialJoin {
		r.participatingSince = time.Now().UnixMilli()
	}
	r.mu.Unlock()
	// The Room clears transient activity when the resident event connection is
	// replaced. A new join/rejoin therefore starts with a fresh local cache too.
	r.resetActivityLocal()
	// Media controller (re)build happens OUTSIDE the runtime lock: it may
	// stop the previous bridge, create a transcriber, and perform a compatibility
	// RoomInfo bootstrap — none of that may hold the runtime mutex.
	r.restartMediaController(joined.ParticipantHandle)
	r.replayResidentMediaState()
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
				// #228: wait-origin transient error — a later successful
				// long-poll clears exactly this class (never turn/send
				// failures, which must remain visible until resolved).
				r.mu.Lock()
				r.state = StateReconnecting
				r.lastError = err.Error()
				r.lastErrorSource = "wait"
				r.mu.Unlock()
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
		if len(r.pendingScopes()) > 0 && !r.isStopped() {
			r.drainTurns()
		}
	}
}

// residentWaitLoop is the official Runtime event loop. It uses one narrow
// hibernatable WebSocket for server-pushed Room envelopes and sends only
// sparse lease heartbeats. All Room mutations still use the ordinary
// authenticated client methods, and the participant handle never leaves this
// object.
func (r *ResidentRuntime) residentWaitLoop(client types.ResidentEventClient) {
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
		dialCtx, cancelDial := context.WithCancel(context.Background())
		// A WebSocket handshake can still be in flight when Stop is called.
		// Tie the handshake to the Runtime lifecycle as well as the established
		// stream, so shutdown cannot inherit the HTTP client's 45s timeout.
		go func() {
			select {
			case <-r.stopCh:
				cancelDial()
			case <-dialCtx.Done():
			}
		}()
		stream, err := client.OpenResidentEventStream(
			dialCtx, handle, r.currentCursor(),
		)
		cancelDial()
		if err == nil {
			if !r.setResidentStream(stream) {
				_ = stream.Close()
				return
			}
			err = r.consumeResidentEventStream(stream)
			r.clearResidentStream(stream)
			_ = stream.Close()
		}

		// Media authorization is fail-closed at the transport boundary. A
		// reconnect must receive a fresh current media projection before any
		// local bridge can run again.
		if !r.isStopped() {
			r.failClosedResidentMediaState()
			r.clearActivity()
		}
		if r.isStopped() {
			return
		}
		if err != nil {
			r.cancelPendingPermissions(err)
		}
		if err == nil {
			// A clean server close is still a reconnect boundary. The stream
			// itself does not carry an HTTP lease, so use the same bounded
			// backoff as every other transport failure.
			err = &free4chat.Error{
				Message: "resident event stream closed",
				Code:    free4chat.CodeTransient,
			}
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
		case free4chat.CodeToolError:
			// A malformed or over-cap application frame is deterministic. Do
			// not reconnect with the same cursor forever; leave the Room and
			// surface a terminal local error instead.
			if r.beginStop("resident event protocol error") {
				r.releaseResources()
			}
			return
		default:
			retryAttempt++
			delay := RetryDelay(retryAttempt - 1)
			r.mu.Lock()
			r.state = StateReconnecting
			r.lastError = err.Error()
			r.lastErrorSource = "wait"
			r.mu.Unlock()
			r.log("resident_event_retry", map[string]string{
				"delayMs": strconv.FormatInt(delay.Milliseconds(), 10),
			})
			if !r.sleep(delay) {
				return
			}
			r.restoreStateAfterRetry()
		}
	}
}

func (r *ResidentRuntime) consumeResidentEventStream(
	stream types.ResidentEventStream,
) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	heartbeatErrors := make(chan error, 1)
	retrySignals := make(chan struct{}, 1)
	type receiveResult struct {
		result types.WaitResult
		err    error
	}
	receiveResults := make(chan receiveResult, 1)
	receiveNext := func() {
		go func() {
			result, err := stream.Receive(ctx)
			select {
			case receiveResults <- receiveResult{result: result, err: err}:
			case <-ctx.Done():
			}
		}()
	}
	interval := r.residentHeartbeatInterval()
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := stream.Heartbeat(ctx, r.currentCursor()); err != nil {
					select {
					case heartbeatErrors <- err:
					default:
					}
					cancel()
					_ = stream.Close()
					return
				}
				// Heartbeats are also the narrow retry clock for a Human Task
				// whose canonical accepted response failed. Keep the signal
				// bounded; drainTurns remains the sole serial admission path.
				select {
				case retrySignals <- struct{}{}:
				default:
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	receiveNext()
	for {
		select {
		case heartbeatErr := <-heartbeatErrors:
			return heartbeatErr
		case <-retrySignals:
			if r.shouldRetryHumanTaskAcceptance() && !r.isStopped() {
				r.drainTurns()
			}
		case received := <-receiveResults:
			if received.err != nil {
				select {
				case heartbeatErr := <-heartbeatErrors:
					return heartbeatErr
				default:
				}
				if r.isStopped() {
					return nil
				}
				return received.err
			}
			if received.result.MediaState == nil {
				// A resident envelope without the mandatory media projection is
				// not an authorization observation. Keep event delivery alive,
				// but revoke local media until a complete envelope arrives.
				r.failClosedResidentMediaState()
			}
			r.advanceFromWait(received.result)
			// A media-only envelope is observation, not an activation event. Do
			// not use it as a Harness wakeup/retry boundary for pre-existing work.
			if len(received.result.Events) > 0 && len(r.pendingScopes()) > 0 && !r.isStopped() {
				r.drainTurns()
			}
			receiveNext()
		}
	}
}

func (r *ResidentRuntime) setResidentStream(
	stream types.ResidentEventStream,
) bool {
	r.mu.Lock()
	if r.stopped {
		r.mu.Unlock()
		return false
	}
	r.residentMu.Lock()
	r.resident = stream
	r.residentMu.Unlock()
	r.mu.Unlock()
	r.resetActivityLocal()
	return true
}

func (r *ResidentRuntime) clearResidentStream(
	stream types.ResidentEventStream,
) {
	r.residentMu.Lock()
	if r.resident == stream {
		r.resident = nil
	}
	r.residentMu.Unlock()
}

func (r *ResidentRuntime) closeResidentStream() {
	r.residentMu.Lock()
	stream := r.resident
	r.resident = nil
	r.residentMu.Unlock()
	if stream != nil {
		_ = stream.Close()
	}
}

func (r *ResidentRuntime) residentHeartbeatInterval() time.Duration {
	r.mu.Lock()
	leaseMs := r.agentLeaseMs
	r.mu.Unlock()
	if leaseMs <= 0 || leaseMs > int64((24*time.Hour)/time.Millisecond) {
		leaseMs = int64(free4chat.DefaultAgentLeaseDuration() / time.Millisecond)
	}
	interval := time.Duration(leaseMs) * time.Millisecond / 3
	if interval <= 0 {
		interval = free4chat.DefaultAgentLeaseDuration() / 3
	}
	return interval
}

func (r *ResidentRuntime) advanceFromWait(result types.WaitResult) {
	r.mu.Lock()
	// The Room transport is at-least-once across reconnect, heartbeat, and
	// catch-up boundaries. Keep its receipt cursor separate from
	// deliveredThrough, which tracks only successful Harness consumption.
	//
	// Capture the boundary before processing this envelope. A server cursor may
	// advance over self-originated or otherwise filtered events, so it (rather
	// than the highest event accepted below) remains the receipt boundary for
	// the next envelope.
	receivedThrough := r.cursor
	// #228: a successful long-poll proves the Room connection recovered.
	// Only a WAIT-origin transient error is cleared — the exact class a
	// successful wait proves resolved. Harness/turn/send failures recorded
	// by drainTurns must remain visible in status until their own recovery.
	if r.lastErrorSource == "wait" {
		r.lastError = ""
		r.lastErrorSource = ""
	}
	r.expiresAt = result.ExpiresAt
	if result.Participants != nil {
		r.roster = append([]types.ParticipantRosterEntry(nil), result.Participants...)
	}
	r.mu.Unlock()

	// Media state is observation-only runtime input. It is deliberately
	// processed outside the Runtime event queue so a grant transition never
	// wakes or creates a Harness turn.
	r.observeResidentMediaState(result.MediaState)

	// Deduplicate within the envelope as well as against the prior transport
	// receipt boundary. This map is intentionally envelope-local: the monotonic
	// Room cursor is the sole in-memory receipt boundary, not a second delivery
	// ledger.
	accepted := make(map[int64]struct{}, len(result.Events))
	for _, event := range result.Events {
		if event.Sequence <= receivedThrough {
			continue
		}
		if _, duplicate := accepted[event.Sequence]; duplicate {
			continue
		}
		accepted[event.Sequence] = struct{}{}
		if r.handleRoomPermissionEvent(event) {
			continue
		}
		r.acceptEvent(event)
	}

	// Advance only after this envelope's events have been ingested. A
	// heartbeat may observe the prior cursor while ingestion is in progress;
	// that is safe because replayed events are idempotently ignored above.
	r.mu.Lock()
	if result.Cursor > r.cursor {
		r.cursor = result.Cursor
	}
	r.mu.Unlock()
}

func (r *ResidentRuntime) acceptEvent(event types.RoomEvent) {
	r.mu.Lock()
	scope := scopeForRoomEvent(event)
	if scope == "" {
		r.mu.Unlock()
		r.log("logical_scope_rejected", map[string]string{"reason": "invalid"})
		return
	}
	newScope := scope != roomScope && !r.scopeStateExistsLocked(scope)
	ref, admitted := r.ensureSessionRefLocked(scope)
	if !admitted {
		r.mu.Unlock()
		r.log("logical_scope_rejected", map[string]string{"reason": "capacity"})
		r.reportTaskScopeCapacityFailure(event)
		return
	}
	r.eventBuffer.Add(event)
	if newScope {
		// A task scope starts at its first task-correlated trigger. Earlier
		// private Room conversation remains pull-only and is not copied into a
		// new Harness conversation implicitly.
		*ref.deliveredThrough = event.Sequence - 1
		*ref.roomDeliveryFloor = event.Sequence - 1
	}
	if event.Addressed && !containsSequence(*ref.pendingAddressed, event.Sequence) {
		// Do not use BoundedPush here. An addressed trigger remains unacknowledged
		// until RunTurn succeeds, so front eviction would silently lose a failed
		// turn. When the bounded queue is full, keep every already-accepted
		// context intact rather than silently acknowledging or replacing it.
		if len(*ref.pendingAddressed) < MaxPendingTurns {
			after := max(*ref.deliveredThrough, *ref.roomDeliveryFloor)
			if pending := len(*ref.pendingAddressed); pending > 0 {
				after = (*ref.pendingAddressed)[pending-1]
			}
			if *ref.pendingContexts == nil {
				*ref.pendingContexts = make(map[int64]pendingTurnContext)
			}
			*ref.pendingAddressed = append(*ref.pendingAddressed, event.Sequence)
			(*ref.pendingContexts)[event.Sequence] = pendingTurnContext{
				after:  after,
				target: event.Sequence,
				events: r.eventsForScopeLocked(scope, after, event.Sequence),
			}
		}
	}
	r.mu.Unlock()
}

// reportTaskScopeCapacityFailure publishes the existing canonical collaboration
// result for a task request that was accepted by Room but rejected locally by
// this Runtime's bounded scope admission. It is intentionally called only
// after acceptEvent has released r.mu: SendCollabResult is external I/O.
func (r *ResidentRuntime) reportTaskScopeCapacityFailure(event types.RoomEvent) {
	if !event.Addressed || event.Collab == nil || event.Collab.Kind != types.CollabRequest || event.Collab.RequestID == "" {
		return
	}
	if _, err := r.CollabResult(types.CollabResultArgs{
		RequestID: event.Collab.RequestID,
		Status:    "failed",
		Summary:   "Agent cannot start another task right now.",
	}); err != nil {
		r.log("collab_result_failed", map[string]string{"reason": "task_scope_capacity"})
	}
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

// drainTurns serially processes queued addressed events. Room transport
// receipt, successful Harness context delivery, and reply persistence are
// distinct boundaries: only RunTurn success acknowledges an addressed target
// and advances deliveredThrough. A failed/ambiguous Harness turn is therefore
// intentionally eligible for at-least-once retry; a later SendText failure is
// not.
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
			if r.harnessFailed || r.lastErrorSource == "send" {
				r.state = StateReconnecting
			} else {
				r.state = StateWaiting
			}
		}
		r.mu.Unlock()
	}()

	for !r.isStopped() {
		scopes := r.pendingScopes()
		if len(scopes) == 0 {
			return
		}
		scope := scopes[0]
		target, ok := r.peekPendingFor(scope)
		if !ok {
			continue
		}
		// Ensure before rendering so the prompt accurately knows whether this
		// is the same retained ACP conversation or a real session/new.
		if err := r.ensureHarnessSession(scope); err != nil {
			r.mu.Lock()
			r.lastError = err.Error()
			r.lastErrorSource = "harness"
			r.state = StateReconnecting
			r.mu.Unlock()
			r.log("turn_failed", nil)
			return
		}
		generation, err := r.harnessSessionGeneration(scope)
		if err != nil {
			r.mu.Lock()
			r.lastError = err.Error()
			r.lastErrorSource = "harness"
			r.state = StateReconnecting
			r.mu.Unlock()
			r.log("turn_failed", nil)
			return
		}
		newSession := r.observeHarnessSessionFor(scope, generation, target)
		events, contextErr := r.pendingContextFor(scope, target)
		if contextErr != nil {
			r.mu.Lock()
			r.lastError = contextErr.Error()
			r.lastErrorSource = "harness"
			r.state = StateReconnecting
			r.mu.Unlock()
			r.log("turn_context_unavailable", nil)
			return
		}
		if len(events) == 0 {
			// A duplicate pending target can only be safely discarded when the
			// successful-delivery cursor already covers it. Otherwise bounded
			// local context was lost, so retain the trigger for a later retry
			// rather than silently claiming Harness delivery.
			if target <= r.effectiveDeliveryStartFor(scope) {
				r.ackPendingFor(scope, target)
				continue
			}
			r.log("turn_context_unavailable", nil)
			return
		}
		maxSeq := events[0].Sequence
		for _, event := range events[1:] {
			if event.Sequence > maxSeq {
				maxSeq = event.Sequence
			}
		}

		input := BuildHarnessTurn(events, &TurnContextOptions{
			Self:         r.selfContext(),
			Participants: r.rosterSnapshot(),
		})
		input.Session = &types.HarnessSessionContext{
			New: newSession,
			// The rendered Room-event sequence is a stable, sanitized context
			// fact. Do not expose the private resident transport cursor, which
			// may have advanced beyond this turn while the Harness was running.
			CurrentRoomSequence: maxSeq,
		}
		r.enrichAttachments(input)
		meetingThrough := r.attachTranscriptFor(scope, input)
		liveThrough := r.attachLiveTranscriptFor(scope, input)

		// A Human-originated Task becomes Working only after its scoped session
		// is available and immediately before the first real cognition turn.
		// Agent-originated collaboration keeps its explicit response semantics.
		if request := humanTaskRequestFor(events, r.currentParticipantID()); request != nil {
			if _, err := r.CollabResponse(types.CollabResponseArgs{
				RequestID: request.RequestID,
				Decision:  "accepted",
				Summary:   "Agent started working.",
			}); err != nil {
				r.mu.Lock()
				r.lastError = err.Error()
				r.lastErrorSource = "send"
				r.state = StateReconnecting
				r.mu.Unlock()
				r.log("collab_accept_failed", nil)
				return
			}
			r.mu.Lock()
			// A successful canonical acceptance resolves the send-origin
			// admission failure before cognition starts. Do not let the stale
			// reconnect state survive into the healthy Harness turn.
			if r.lastErrorSource == "send" {
				r.lastError = ""
				r.lastErrorSource = ""
			}
			r.mu.Unlock()
		}

		// A newly addressed turn wins the speaker: stale audio from the
		// previous response must never keep playing over the new one.
		if voiceOutput := r.voiceOutput(); voiceOutput != nil {
			voiceOutput.Cancel()
		}

		r.beginActivity(scope)
		result, err := r.runHarnessTurn(scope, *input, generation)
		r.finishActivity(scope)
		if err != nil {
			r.mu.Lock()
			r.lastError = err.Error()
			r.lastErrorSource = "harness"
			r.state = StateReconnecting
			r.mu.Unlock()
			r.log("turn_failed", nil)
			return
		}
		if r.isStopped() {
			return
		}

		// RunTurn succeeded: commit every delivery marker before lifecycle
		// handling or text persistence. If either of those later operations
		// fails, replaying this already-consumed Harness prompt would be wrong.
		r.acknowledgeHarnessDeliveryFor(scope, target, maxSeq, generation)
		r.acknowledgeTranscriptDeliveryFor(scope, meetingThrough, liveThrough)
		r.mu.Lock()
		r.harnessFailed = false
		// #228: a successful turn proves the Harness recovered — clear ONLY
		// the harness-origin error (a concurrent wait/send failure stays).
		if r.lastErrorSource == "harness" {
			r.lastError = ""
			r.lastErrorSource = ""
		}
		r.mu.Unlock()
		// A lifecycle result is never ordinary reply text. Its body may contain
		// an untruthful success claim, so consume the closed local intent before
		// any SendText attempt. Confirmed leave hands cleanup to the daemon after
		// this turn unwinds; rejected/failed intents use fixed truthful text.
		if r.handleLifecycleIntent(input, result) {
			return
		}

		text := strings.TrimSpace(result.Text)
		if text == "" {
			continue
		}
		handle, err := r.requireHandle()
		if err != nil {
			r.mu.Lock()
			r.lastError = err.Error()
			r.lastErrorSource = "harness"
			r.state = StateReconnecting
			r.mu.Unlock()
			r.log("turn_failed", nil)
			return
		}
		sent, err := r.sendHarnessText(scope, handle, text, result.TargetParticipantIDs)
		if err != nil {
			r.mu.Lock()
			r.lastError = err.Error()
			r.lastErrorSource = "send"
			r.state = StateReconnecting
			r.mu.Unlock()
			r.log("turn_failed", nil)
			return
		}
		r.mu.Lock()
		// #228: a successful send proves delivery recovered — clear ONLY the
		// send-origin error (a concurrent wait/harness failure stays).
		if r.lastErrorSource == "send" {
			r.lastError = ""
			r.lastErrorSource = ""
		}
		r.mu.Unlock()
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

// shouldRetryHumanTaskAcceptance is deliberately narrower than a generic
// retry scheduler. A heartbeat may retry only the admission boundary that can
// otherwise remain pinned after transport receipt: a Human-originated Task
// whose canonical accepted response failed. Generic Agent collaboration keeps
// its existing explicit response semantics and is still driven by its normal
// event path.
func (r *ResidentRuntime) shouldRetryHumanTaskAcceptance() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.lastErrorSource != "send" || r.participantID == "" {
		return false
	}
	hasPendingRequest := func(ref *logicalSessionRef) bool {
		if ref == nil || ref.pendingAddressed == nil || ref.pendingContexts == nil {
			return false
		}
		for _, target := range *ref.pendingAddressed {
			pending, ok := (*ref.pendingContexts)[target]
			if ok && humanTaskRequestFor(pending.events, r.participantID) != nil {
				return true
			}
		}
		return false
	}
	if hasPendingRequest(r.sessionRefLocked(roomScope)) {
		return true
	}
	for _, scope := range r.scopeOrder {
		if hasPendingRequest(r.sessionRefLocked(scope)) {
			return true
		}
	}
	return false
}

func taskRequestIDForScope(scope string) string {
	scope = normalizeScope(scope)
	if strings.HasPrefix(scope, "task:") {
		return strings.TrimPrefix(scope, "task:")
	}
	return ""
}

func (r *ResidentRuntime) sendHarnessText(scope, handle, text string, targets []string) (types.SendTextResult, error) {
	if requestID := taskRequestIDForScope(scope); requestID != "" {
		client, ok := r.options.Client.(types.TaskTextClient)
		if !ok {
			return types.SendTextResult{}, errTaskTextUnsupported
		}
		return client.SendTextForTask(handle, text, targets, requestID)
	}
	return r.options.Client.SendText(handle, text, targets)
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
	r.cancelPendingPermissions(errors.New("room participant connection was replaced"))
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

// ReadRoomContext mediates bounded historical observation for a local
// Harness/CLI. The participant handle remains inside the Runtime; this API
// has no send/join/wait/leave path and cannot alter Room transport state.
func (r *ResidentRuntime) ReadRoomContext(options types.RoomContextReadOptions) (types.RoomContextReadResult, error) {
	handle, err := r.requireHandle()
	if err != nil {
		return types.RoomContextReadResult{}, err
	}
	client, ok := r.options.Client.(types.RoomContextClient)
	if !ok {
		return types.RoomContextReadResult{}, errors.New("room context read is unavailable")
	}
	return client.ReadRoomContext(handle, options)
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
	if !r.beginStop("room_expired") {
		return
	}
	r.releaseResources()
	if r.options.OnRoomExpired != nil {
		if err := r.options.OnRoomExpired(); err != nil {
			r.log("room_expiry_cleanup_failed", nil)
		}
	}
}

// Stop tears everything down: signal the loop, close the resident event
// stream, best-effort cancel any running Harness turn, release the room lease,
// close the ACP process, and close the client.
func (r *ResidentRuntime) Stop() {
	r.beginStop("")
	r.releaseResources()
	r.loopWG.Wait()
}

// beginStop transitions this Runtime to terminal local state exactly once and
// wakes its wait/retry loop. Resource cleanup stays with the caller so the
// daemon can schedule it outside an active Harness turn.
func (r *ResidentRuntime) beginStop(lastError string) bool {
	transitioned := false
	r.cleanupOnce.Do(func() {
		r.mu.Lock()
		r.stopped = true
		r.state = StateStopped
		if lastError != "" {
			r.lastError = lastError
		}
		r.pendingAddressed = nil
		r.pendingContexts = nil
		r.eventBuffer.Clear()
		r.mu.Unlock()
		r.cancelPendingPermissions(errors.New("runtime stopped"))
		r.clearActivity()
		close(r.stopCh)
		r.closeResidentStream()
		transitioned = true
	})
	return transitioned
}

// releaseResources mirrors the Node cleanupResources ordering: media first
// (bounded teardown), then the lease, then Harness/client.
func (r *ResidentRuntime) releaseResources() {
	r.residentMediaStateApplyMu.Lock()
	defer r.residentMediaStateApplyMu.Unlock()
	r.mediaMu.Lock()
	defer r.mediaMu.Unlock()
	r.residentMediaStateMu.Lock()
	r.residentMediaStateValid = false
	r.residentMediaState = types.ResidentMediaState{}
	r.residentMediaStateMu.Unlock()
	// Invalidate every callback before Controller.Stop tears the bridge down.
	// Its active-subscription TrackEnded notifications are intentionally
	// asynchronous to keep this lifecycle mutex non-reentrant.
	r.mediaGeneration++
	if r.mediaController != nil {
		r.mediaController.Stop()
		r.mediaController = nil
	}
	r.voiceSrc = nil
	r.mu.Lock()
	r.liveTranscript = types.LiveTranscriptInfo{}
	r.liveTranscriptProducing = false
	r.mu.Unlock()
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
