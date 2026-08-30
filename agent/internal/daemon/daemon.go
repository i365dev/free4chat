package daemon

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/i365dev/free4chat/agent/internal/doctor"
	"github.com/i365dev/free4chat/agent/internal/free4chat"
	"github.com/i365dev/free4chat/agent/internal/harness"
	"github.com/i365dev/free4chat/agent/internal/media"
	"github.com/i365dev/free4chat/agent/internal/runtime"
	"github.com/i365dev/free4chat/agent/internal/speech"
	"github.com/i365dev/free4chat/agent/internal/types"
	"github.com/i365dev/free4chat/agent/internal/voice"
)

// residentInstance is one live room runtime owned by the daemon.
type residentInstance struct {
	instanceID string
	roomID     string
	runtime    *runtime.ResidentRuntime
	workspace  string
}

// Daemon hosts every resident Agent instance behind one Unix socket.
type Daemon struct {
	mu                  sync.Mutex
	instances           map[string]*residentInstance
	listener            net.Listener
	closed              chan struct{}
	stopping            bool
	finalized           bool
	finishOnce          sync.Once
	voiceGate           voice.Gate
	providerHandles     *runtime.ProviderHandleStore
	transcriptProducers *TranscriptProducerCoordinator
}

// New creates an idle daemon.
func New() *Daemon {
	return &Daemon{
		instances:           make(map[string]*residentInstance),
		closed:              make(chan struct{}),
		voiceGate:           voice.NewGate(),
		providerHandles:     runtime.NewProviderHandleStore(),
		transcriptProducers: NewTranscriptProducerCoordinator(),
	}
}

// Run prepares the runtime directory, cleans stale workspaces left by a dead
// daemon, and serves IPC until Stop closes the listener.
func (d *Daemon) Run() error {
	dir := RuntimeDirectory()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	workspaces := WorkspacesRoot()
	if err := os.MkdirAll(workspaces, 0o700); err != nil {
		return err
	}
	if err := RemoveStaleWorkspaces(workspaces); err != nil {
		return err
	}
	socket := SocketPath()
	_ = os.Remove(socket) // stale socket from a dead daemon

	listener, err := net.Listen("unix", socket)
	if err != nil {
		return fmt.Errorf("daemon listen failed: %w", err)
	}
	d.mu.Lock()
	d.listener = listener
	d.mu.Unlock()
	if err := os.Chmod(socket, 0o600); err != nil {
		_ = listener.Close()
		close(d.closed)
		return err
	}

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				select {
				case <-d.closed:
					return
				default:
					continue
				}
			}
			go d.serve(conn)
		}
	}()

	<-d.closed
	return nil
}

// serve handles exactly one newline-delimited request per connection,
// mirroring the Node IPC contract ({ok,result}|{ok,error} on one line).
func (d *Daemon) serve(conn net.Conn) {
	defer conn.Close()
	reader := bufio.NewReaderSize(conn, 4*1024*1024)
	line, readErr := reader.ReadString('\n')
	if readErr != nil && len(line) == 0 {
		return
	}
	request, decodeErr := DecodeRequest([]byte(strings.TrimRight(line, "\r\n")))
	if decodeErr != nil {
		writeErrorResponse(conn, decodeErr.Error())
		return
	}
	result, dispatchErr := d.Dispatch(request)
	if dispatchErr == nil {
		data, marshalErr := json.Marshal(IpcResponse{OK: true, Result: result})
		if marshalErr != nil {
			dispatchErr = errors.New("daemon response failed")
		} else {
			_, _ = conn.Write(append(data, '\n'))
			d.finalizeIfStopping()
			return
		}
	}
	writeErrorResponse(conn, truncateError(dispatchErr))
	d.finalizeIfStopping()
}

func writeErrorResponse(conn net.Conn, message string) {
	data, err := json.Marshal(IpcResponse{OK: false, Error: message})
	if err != nil {
		data = []byte(`{"ok":false,"error":"daemon response failed"}`)
	}
	_, _ = conn.Write(append(data, '\n'))
}

// truncateError keeps locally generated dispatch errors bounded.
func truncateError(err error) string {
	message := err.Error()
	if len(message) > 300 {
		return message[:297] + "..."
	}
	return message
}

// Dispatch executes one IPC operation. Handle-bearing values stay strictly
// inside runtime objects.
func (d *Daemon) Dispatch(request *IpcRequest) (any, error) {
	switch request.Op {
	case "join":
		if err := d.rejectIfStopping(); err != nil {
			return nil, err
		}
		return d.dispatchJoin(request)
	case "create":
		if err := d.rejectIfStopping(); err != nil {
			return nil, err
		}
		return d.dispatchCreate(request)
	case "status":
		return d.statusViews(), nil
	case "daemon-info":
		return DaemonInfo{DaemonVersion: doctor.Version}, nil
	case "reload-speech":
		config := speech.LoadConfig(RuntimeDirectory(), os.Getenv)
		d.mu.Lock()
		instances := make([]*residentInstance, 0, len(d.instances))
		for _, instance := range d.instances {
			instances = append(instances, instance)
		}
		d.mu.Unlock()
		for _, instance := range instances {
			instance.runtime.ReloadSpeech(config)
		}
		return map[string]any{"reloaded": len(instances)}, nil
	case "leave":
		if request.InstanceID == "" {
			return nil, errors.New("leave requires instanceId")
		}
		return d.leave(request.InstanceID), nil
	case "stop":
		d.beginStop()
		return map[string]any{"state": "stopped"}, nil
	case "update-capabilities":
		rt, err := d.resolveRuntime(request.InstanceID)
		if err != nil {
			return nil, err
		}
		if request.Capabilities == nil {
			return map[string]any{"capabilities": rt.CurrentCapabilities()}, nil
		}
		if err := rt.UpdateCapabilities(request.Capabilities); err != nil {
			return nil, err
		}
		return map[string]any{"capabilities": rt.CurrentCapabilities()}, nil
	case "collab-request":
		if request.TargetParticipantID == "" || request.Summary == "" {
			return nil, errors.New("collab request requires target and summary")
		}
		rt, err := d.resolveRuntime(request.InstanceID)
		if err != nil {
			return nil, err
		}
		outcome, err := rt.CollabRequest(types.CollabRequestArgs{
			TargetParticipantID: request.TargetParticipantID,
			Summary:             request.Summary,
			RequestID:           request.RequestID,
			Details:             request.Details,
			AttachmentIDs:       request.AttachmentIDs,
		})
		if err != nil {
			return nil, err
		}
		view := map[string]any{"requestId": outcome.RequestID, "sequence": outcome.Sequence}
		if outcome.Duplicate {
			view["duplicate"] = true
		}
		return view, nil
	case "collab-response":
		if request.RequestID == "" || (request.Decision != "accepted" && request.Decision != "declined") {
			return nil, errors.New("collab respond requires requestId and decision")
		}
		rt, err := d.resolveRuntime(request.InstanceID)
		if err != nil {
			return nil, err
		}
		sent, err := rt.CollabResponse(types.CollabResponseArgs{
			RequestID: request.RequestID,
			Decision:  request.Decision,
			Summary:   request.Summary,
		})
		if err != nil {
			return nil, err
		}
		return map[string]any{"sequence": sent.Sequence}, nil
	case "collab-result":
		if request.RequestID == "" ||
			(request.Status != "completed" && request.Status != "failed") ||
			request.Summary == "" {
			return nil, errors.New("collab result requires requestId, status, and summary")
		}
		rt, err := d.resolveRuntime(request.InstanceID)
		if err != nil {
			return nil, err
		}
		sent, err := rt.CollabResult(types.CollabResultArgs{
			RequestID:     request.RequestID,
			Status:        request.Status,
			Summary:       request.Summary,
			Details:       request.Details,
			AttachmentIDs: request.AttachmentIDs,
		})
		if err != nil {
			return nil, err
		}
		return map[string]any{"sequence": sent.Sequence}, nil
	case "attach":
		if request.FileName == "" || request.MimeType == "" || request.DataBase64 == "" {
			return nil, errors.New("attach requires file name, mime type, and data")
		}
		rt, err := d.resolveRuntime(request.InstanceID)
		if err != nil {
			return nil, err
		}
		uploaded, err := rt.UploadAttachment(types.AttachmentUpload{
			FileName:   request.FileName,
			MimeType:   request.MimeType,
			DataBase64: request.DataBase64,
		})
		if err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "attachment": uploaded}, nil
	case "surface-publish":
		if request.MimeType == "" || request.DataBase64 == "" {
			return nil, errors.New("surface publish requires mimeType and data")
		}
		rt, err := d.resolveRuntime(request.InstanceID)
		if err != nil {
			return nil, err
		}
		surface, err := rt.PublishSurface(types.SurfacePublishPayload{
			MimeType:   request.MimeType,
			DataBase64: request.DataBase64,
		})
		if err != nil {
			return nil, err
		}
		return map[string]any{"surface": surface}, nil
	case "surface-clear":
		rt, err := d.resolveRuntime(request.InstanceID)
		if err != nil {
			return nil, err
		}
		if err := rt.ClearSurface(); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "cleared": true}, nil
	case "surface-read":
		if request.SourceParticipantID == "" {
			return nil, errors.New("surface read requires --participant")
		}
		instanceID, rt, err := d.resolveForSurfaces(request.InstanceID)
		if err != nil {
			return nil, err
		}
		current := rt.PeerSurface(request.SourceParticipantID)
		if current == nil {
			return nil, errors.New(
				"No workspace snapshot is currently published by that participant")
		}
		read, err := rt.ReadSurface(request.SourceParticipantID, current.SnapshotID)
		if err != nil {
			return nil, err
		}
		if read.Surface.SnapshotID != current.SnapshotID {
			return nil, errors.New("snapshot changed during read; retry")
		}
		localPath, writeErr := writeSurfaceSnapshot(d.workspaceOf(instanceID), read)
		if writeErr != nil {
			return nil, writeErr
		}
		return map[string]any{"surface": read.Surface, "localPath": localPath}, nil
	default:
		return nil, errors.New("unknown daemon operation")
	}
}

// rejectIfStopping keeps a draining daemon from admitting new residents.
func (d *Daemon) rejectIfStopping() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.stopping || d.finalized {
		return errors.New("daemon is stopping")
	}
	return nil
}

// prepareRuntime validates shared join/create fields and builds the client /
// adapter / runtime trio without starting anything.
func (d *Daemon) prepareRuntime(
	isCreate bool,
	request *IpcRequest,
) (*runtime.ResidentRuntime, string, string, error) {
	var launcher types.AgentLauncher
	switch {
	case request.AgentCommand != "" && request.Agent != "":
		return nil, "", "", errors.New("choose --agent or --agent-command, not both")
	case request.AgentCommand != "":
		custom, err := harness.CustomLauncher(request.AgentCommand, request.AgentArgs)
		if err != nil {
			return nil, "", "", err
		}
		launcher = custom
	case request.Agent != "":
		builtIn, err := harness.GetLauncher(request.Agent)
		if err != nil {
			return nil, "", "", err
		}
		launcher = builtIn
	default:
		if isCreate {
			return nil, "", "", errors.New("create requires a launcher (--agent or --agent-command)")
		}
		return nil, "", "", errors.New("join requires agent or agent-command")
	}

	if !isCreate && request.Room == "" || request.Name == "" {
		return nil, "", "", errors.New(isCreateNameError(isCreate))
	}

	turnTimeoutMs, envErr := optionalMilliseconds("FREE4CHAT_ACP_TURN_TIMEOUT_MS")
	if envErr != nil {
		return nil, "", "", envErr
	}
	cancelGraceMs, envErr2 := optionalMilliseconds("FREE4CHAT_ACP_CANCEL_GRACE_MS")
	if envErr2 != nil {
		return nil, "", "", envErr2
	}

	instanceID := NewID()
	workspace := filepath.Join(WorkspacesRoot(), instanceID)
	if err := os.MkdirAll(workspace, 0o700); err != nil {
		return nil, "", "", err
	}
	mcpURL := os.Getenv("FREE4CHAT_MCP_URL")
	if mcpURL == "" {
		mcpURL = "https://www.free4.chat/mcp"
	}
	siteOrigin, originErr := media.SiteOriginFromMCPURL(mcpURL)
	if originErr != nil {
		// A malformed MCP URL disables the media plane; text behavior is
		// unaffected (media is strictly additive).
		siteOrigin = ""
	}
	// Every join gets a fresh workspace; the transcript lives in a hidden
	// child directory inside it and is never reused across rooms.
	transcriptPath := filepath.Join(workspace, ".meeting-notes", "transcript.jsonl")
	speechConfig := speech.LoadConfig(RuntimeDirectory(), os.Getenv)
	// #176 Phase A: load the PRIVATE Runtime root seed. Every resident of
	// this root derives the same Room-scoped public runtimeHostId from it;
	// the raw seed never becomes participant or Room state. A seed failure
	// is additive and must never block a text join — the resident simply
	// joins without a host projection.
	hostSeed := ""
	if seed, seedErr := RuntimeHostSeed(); seedErr != nil {
		fmt.Fprintf(os.Stderr, "free4chat-agent: runtime host seed unavailable (%v); joining without a host projection\n", seedErr)
	} else {
		hostSeed = seed
	}
	residentRuntime := runtime.NewResidentRuntime(runtime.Options{
		InstanceID: instanceID,
		RoomID:     request.Room, // empty for the create-first lifecycle
		Name:       request.Name,
		Client:     free4chat.New(mcpURL),
		Adapter: harness.NewACPAdapter(launcher, workspace, harness.AdapterOptions{
			TurnTimeoutMs: turnTimeoutMs,
			CancelGraceMs: cancelGraceMs,
		}),
		Capabilities:        request.Capabilities,
		SiteOrigin:          siteOrigin,
		TranscriptPath:      transcriptPath,
		Speech:              &speechConfig,
		HostSeed:            hostSeed,
		HostVoiceGate:       d.voiceGate,
		ProviderClaim:       request.ProviderClaim,
		ProviderHandles:     d.providerHandles,
		TranscriptProducers: d.transcriptProducers,
		// Natural room expiry must release the resident registry entry and
		// its private workspace, matching the Node reference's onRoomExpired
		// wiring — otherwise status keeps showing a ghost instance and the
		// workspace survives until the daemon restarts.
		OnRoomExpired: func() error {
			d.unregister(instanceID)
			return os.RemoveAll(workspace)
		},
	})
	return residentRuntime, workspace, instanceID, nil
}

func isCreateNameError(isCreate bool) string {
	if isCreate {
		return "create requires name"
	}
	return "join requires room and name"
}

func (d *Daemon) dispatchJoin(request *IpcRequest) (any, error) {
	residentRuntime, workspace, instanceID, err := d.prepareRuntime(false, request)
	if err != nil {
		return nil, err
	}
	d.register(&residentInstance{
		instanceID: instanceID,
		roomID:     request.Room,
		runtime:    residentRuntime,
		workspace:  workspace,
	})
	if startErr := residentRuntime.Start(); startErr != nil {
		d.unregister(instanceID)
		residentRuntime.Stop()
		_ = os.RemoveAll(workspace)
		return nil, startErr
	}
	return statusView(residentRuntime), nil
}

func (d *Daemon) dispatchCreate(request *IpcRequest) (any, error) {
	if request.Name == "" {
		return nil, errors.New("create requires name")
	}
	if request.Room != "" {
		return nil, errors.New("create does not take a room; the room is generated")
	}
	residentRuntime, workspace, instanceID, err := d.prepareRuntime(true, request)
	if err != nil {
		return nil, err
	}
	// Adopt WITHOUT starting the wait loop: a create whose very first
	// long-poll reports room_expired must not race its OnRoomExpired
	// unregister against the registry admission below (an unregister before
	// register is a no-op that would leave a ghost resident whose workspace
	// is already gone).
	created, createErr := residentRuntime.AdoptCreate()
	if createErr != nil {
		residentRuntime.Stop()
		_ = os.RemoveAll(workspace)
		return nil, createErr
	}
	// Register the instance only after the create+adopt succeeded: a failed
	// startup leaves no ghost instance and stop() performs best-effort
	// leave/close. The payload carries status plus the PUBLIC invite.
	d.register(&residentInstance{
		instanceID: instanceID,
		roomID:     created.Invite.RoomID,
		runtime:    residentRuntime,
		workspace:  workspace,
	})
	// Admission complete — only now may the wait loop start observing the
	// room (and, on immediate expiry, cleanly unregister + remove).
	residentRuntime.StartLoop()
	view := statusView(residentRuntime)
	view["invite"] = created.Invite
	return view, nil
}

// register adds an instance record.
func (d *Daemon) register(instance *residentInstance) {
	d.mu.Lock()
	d.instances[instance.instanceID] = instance
	d.mu.Unlock()
}

func (d *Daemon) unregister(instanceID string) {
	d.mu.Lock()
	delete(d.instances, instanceID)
	d.mu.Unlock()
	d.transcriptProducers.ReleaseInstance(instanceID)
}

// leave stops one instance and removes its workspace; unknown ids stay a
// quiet no-op exactly like the Node daemon.
func (d *Daemon) leave(instanceID string) map[string]any {
	d.mu.Lock()
	instance, ok := d.instances[instanceID]
	if ok {
		delete(d.instances, instanceID)
	}
	d.mu.Unlock()
	if ok {
		d.transcriptProducers.ReleaseInstance(instanceID)
		instance.runtime.Stop()
		_ = os.RemoveAll(instance.workspace)
	}
	return map[string]any{"instanceId": instanceID, "state": "stopped"}
}

// beginStop stops every resident now and prevents new admissions; the actual
// listener teardown is deferred to finishStopAfterReply so the stop IPC reply
// still reaches its caller before the process exits.
func (d *Daemon) beginStop() {
	d.mu.Lock()
	d.stopping = true
	instances := make([]*residentInstance, 0, len(d.instances))
	for _, instance := range d.instances {
		instances = append(instances, instance)
	}
	d.instances = make(map[string]*residentInstance)
	d.mu.Unlock()

	var wg sync.WaitGroup
	for _, instance := range instances {
		d.transcriptProducers.ReleaseInstance(instance.instanceID)
		wg.Add(1)
		go func(rt *runtime.ResidentRuntime, workspace string) {
			defer wg.Done()
			rt.Stop()
			_ = os.RemoveAll(workspace)
		}(instance.runtime, instance.workspace)
	}
	// Bounded wait so teardown cannot exceed the IPC timeout budget while
	// keeping this exchange responsive.
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
	}
}

func (d *Daemon) isStopping() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.stopping && !d.finalized
}

func (d *Daemon) finishStopAfterReply() {
	d.mu.Lock()
	d.finalized = true
	listener := d.listener
	d.mu.Unlock()
	d.finishOnce.Do(func() {
		select {
		case <-d.closed:
		default:
			close(d.closed)
		}
		if listener != nil {
			_ = listener.Close()
		}
	})
}

// finalizeIfStopping lets serve() complete teardown once its exchange ended.
func (d *Daemon) finalizeIfStopping() {
	if d.isStopping() {
		d.finishStopAfterReply()
	}
}

// InstanceCount reports how many residents are live (used by tests).
// stopAll forces full teardown without waiting for any IPC exchange; used
// by tests embedding daemons directly.
func (d *Daemon) stopAll() {
	d.beginStop()
	d.finishStopAfterReply()
}

func (d *Daemon) InstanceCount() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.instances)
}

// statusViews snapshots all residents, adding advertised capabilities when
// non-empty (matching the Node payload shape).
func (d *Daemon) statusViews() []map[string]any {
	d.mu.Lock()
	all := make([]*residentInstance, 0, len(d.instances))
	for _, instance := range d.instances {
		all = append(all, instance)
	}
	d.mu.Unlock()
	views := make([]map[string]any, 0, len(all))
	for _, instance := range all {
		view := statusView(instance.runtime)
		if caps := instance.runtime.CurrentCapabilities(); len(caps) > 0 {
			view["capabilities"] = caps
		}
		// #176 Phase A: local observability of the Room-scoped Runtime Host
		// identity and coarse speech readiness shared by every resident of
		// this root. The raw root seed never appears in any view.
		if host := instance.runtime.CurrentHostProjection(); host != nil {
			view["runtimeHostId"] = host.RuntimeHostID
			view["speech"] = map[string]bool{"stt": host.Speech.STT, "tts": host.Speech.TTS}
		}
		views = append(views, view)
	}
	return views
}

// resolveForSurfaces resolves the explicit --instance or the sole resident,
// returning its id (for workspace lookup) together with the runtime.
func (d *Daemon) resolveForSurfaces(instanceID string) (string, *runtime.ResidentRuntime, error) {
	if instanceID == "" {
		d.mu.Lock()
		defer d.mu.Unlock()
		if len(d.instances) == 1 {
			for id, instance := range d.instances {
				return id, instance.runtime, nil
			}
		}
		return "", nil, errors.New(
			"Multiple or no resident instances; pass --instance <id> (see `free4chat-agent status`)")
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	instance, ok := d.instances[instanceID]
	if !ok {
		return "", nil, fmt.Errorf(
			"No resident instance %s. Run `free4chat-agent status`.", instanceID)
	}
	return instanceID, instance.runtime, nil
}

// resolveRuntime resolves the explicit --instance or the sole resident.
func (d *Daemon) resolveRuntime(instanceID string) (*runtime.ResidentRuntime, error) {
	_, rt, err := d.resolveForSurfaces(instanceID)
	return rt, err
}

// workspaceOf finds an instance's private directory ("" when unresolved).
func (d *Daemon) workspaceOf(instanceID string) string {
	if instanceID == "" {
		return ""
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if instance, ok := d.instances[instanceID]; ok {
		return instance.workspace
	}
	return ""
}

// statusView builds one public status view; the participant capability
// handle never appears here.
func statusView(rt *runtime.ResidentRuntime) map[string]any {
	status := rt.Status()
	data, _ := json.Marshal(status)
	view := map[string]any{}
	_ = json.Unmarshal(data, &view)
	return view
}

func optionalMilliseconds(name string) (int64, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return 0, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 1 {
		return 0, fmt.Errorf("%s must be a positive number of milliseconds", name)
	}
	return value, nil
}

// RemoveStaleWorkspaces wipes every per-instance workspace left behind by a
// daemon that died without cleanup — transcripts cannot outlive it.
func RemoveStaleWorkspaces(workspaces string) error {
	entries, err := os.ReadDir(workspaces)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, entry := range entries {
		_ = os.RemoveAll(filepath.Join(workspaces, entry.Name()))
	}
	return nil
}
