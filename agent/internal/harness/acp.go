package harness

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

const (
	shutdownTimeoutMs      = 2_000
	defaultTurnTimeoutMs   = 120_000
	defaultCancelGraceMs   = 2_000
	maxPromptImagesPerTurn = 2

	protocolVersion = 1
	clientName      = "free4chat-agent-runtime"
	clientVersion   = "0.1.0"
)

// TurnTimeoutError mirrors AcpTurnTimeoutError.
type TurnTimeoutError struct{ TimeoutMs int64 }

func (e *TurnTimeoutError) Error() string {
	return fmt.Sprintf("ACP turn timed out after %dms", e.TimeoutMs)
}

// AdapterOptions tunes turn timeout / cancel grace (tests).
type AdapterOptions struct {
	TurnTimeoutMs int64
	CancelGraceMs int64
	// AgentEnv is a map of explicitly authorized Harness environment variable
	// NAMES -> VALUES resolved from the CLI process at join/create time.
	// It is ephemeral launch material: never returned in daemon responses,
	// never persisted to workspace/status/logs, never enters Room/MCP/ACP.
	AgentEnv map[string]string
	// RuntimeExecutable is the exact currently-running free4chat-agent binary
	// that owns the resident daemon. It is passed to the Harness as
	// launcher-owned FREE4CHAT_AGENT_BIN policy, never through Room state.
	RuntimeExecutable string
	// PermissionResponder is an optional, resident-local decision seam for
	// ACP session/request_permission calls. A nil responder preserves the
	// production fail-closed behavior and cancels the request immediately.
	PermissionResponder ACPPermissionResponder
	// ActivityHandler is an optional transient projection callback. Repeated
	// ACP chunks are coalesced by the Runtime before any Room request.
	ActivityHandler ACPActivityHandler
}

// ACPMode is the Harness-native session mode advertised by session/new.
// Free4Chat preserves these fields without assigning them universal policy
// semantics.
type ACPMode struct {
	ID          string `json:"id"`
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
}

// ACPModeState is the resident-local projection of the Harness-native mode
// control advertised by an ACP session.
type ACPModeState struct {
	CurrentModeID  string    `json:"currentModeId"`
	AvailableModes []ACPMode `json:"availableModes"`
}

// ACPConfigOptionValue is one Harness-native value offered by a session
// config option.
type ACPConfigOptionValue struct {
	Value       string `json:"value"`
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
}

// ACPConfigOption is a sanitized native ACP session config option. Only
// options that are mode/policy-shaped are retained by parseSessionControls.
type ACPConfigOption struct {
	ID           string                 `json:"id"`
	Name         string                 `json:"name,omitempty"`
	Description  string                 `json:"description,omitempty"`
	Category     string                 `json:"category,omitempty"`
	Type         string                 `json:"type,omitempty"`
	CurrentValue string                 `json:"currentValue,omitempty"`
	Options      []ACPConfigOptionValue `json:"options,omitempty"`
}

// ACPSessionControls contains only native ACP controls retained for a
// resident. It is not a Free4Chat permission policy or security guarantee.
type ACPSessionControls struct {
	Modes         *ACPModeState     `json:"modes,omitempty"`
	ConfigOptions []ACPConfigOption `json:"configOptions,omitempty"`
}

// ACPPermissionPresentation is the optional native display metadata attached
// to an ACP permission request. It is display-only: Free4Chat never derives
// authorization semantics from either field.
type ACPPermissionPresentation struct {
	Title       string
	Description string
}

// ACPToolCall is the useful, local-only tool context attached to one native
// permission request. RawInput and Content remain opaque to Free4Chat; only
// the bounded display metadata is retained for the Room projection.
type ACPToolCall struct {
	ToolCallID string
	Title      string
	Kind       string
	Status     string
	RawInput   json.RawMessage
	Content    json.RawMessage
	Permission *ACPPermissionPresentation
}

// ACPPermissionOption preserves the exact native option offered by the
// Harness. In particular, Free4Chat never interprets Kind or Meta.
type ACPPermissionOption struct {
	OptionID string
	Name     string
	Kind     string
	Meta     json.RawMessage
}

// ACPPermissionRequest is the sanitized local callback payload for one
// session/request_permission call. RequestID is retained as compact JSON so
// numeric and string JSON-RPC ids remain distinguishable.
type ACPPermissionRequest struct {
	RequestID string
	SessionID string
	// Scope is the adapter-owned logical scope of the ACP session that emitted
	// this request. It is local correlation only; it is never sent to the
	// Harness or projected directly into Room state.
	Scope    string
	ToolCall ACPToolCall
	Options  []ACPPermissionOption
}

// ACPPermissionResponse selects one exact option previously offered in the
// corresponding ACPPermissionRequest. An empty OptionID means cancellation.
type ACPPermissionResponse struct {
	OptionID string
}

// ACPPermissionResponder is deliberately a transport seam, not a policy
// engine. The responder owns whether/when an authorized external actor
// chooses one of the Harness-provided options.
type ACPPermissionResponder func(context.Context, ACPPermissionRequest) (ACPPermissionResponse, error)

// ACPActivityHandler receives only a logical scope and coarse normalized
// state. The ACP payload remains private to the adapter.
type ACPActivityHandler func(scope string, state types.AgentActivityState)

// ACPCapabilities is the parsed initialize response projection.
type ACPCapabilities struct {
	Images bool
	// ResumePresent mirrors the Node `resume != null` check: the mere
	// presence of the sessionCapabilities.resume key counts as support.
	ResumePresent bool
	// ClosePresent gates the graceful session/close attempt on shutdown.
	ClosePresent bool
	// SessionControls is the native control metadata returned by session/new.
	// It remains resident-local and is cleared on session replacement/death.
	SessionControls *ACPSessionControls
}

// acpMessage is one JSON-RPC 2.0 envelope over nd-json stdio.
type acpMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *acpRPCError    `json:"error,omitempty"`
}

type acpRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (m *acpMessage) idKey() string { return compactJSON(m.ID) }

func compactJSON(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return string(raw)
	}
	return buf.String()
}

type pendingCall struct {
	result chan *acpMessage
}

type pendingPermission struct {
	id      json.RawMessage
	request ACPPermissionRequest
}

type acpSession struct {
	sessionID  string
	caps       *ACPCapabilities
	generation int64
	scope      string
}

// harnessProcess owns the ONE cmd.Wait() call for a child lifecycle. Both
// the death watcher and closeInternal observe the same exit signal, so the
// shutdown path can reliably distinguish "terminated" from "ignored TERM"
// and escalate to SIGKILL. Calling Wait twice on an exec.Cmd returns
// immediately with an error, which previously let a TERM-ignoring Harness
// skip the escalation entirely.
type harnessProcess struct {
	cmd    *exec.Cmd
	exited chan struct{}
	once   sync.Once
}

func newHarnessProcess(cmd *exec.Cmd) *harnessProcess {
	return &harnessProcess{cmd: cmd, exited: make(chan struct{})}
}

// reap performs the single Wait call; idempotent. The channel closes only
// after the process has actually exited and been reaped.
func (p *harnessProcess) reap() {
	p.once.Do(func() {
		_ = p.cmd.Wait()
		close(p.exited)
	})
}

// ACPAdapter drives one local Harness process over ACP v1 (nd-json JSON-RPC
// on stdio). It implements types.HarnessAdapter. Permission requests are
// fail-closed when no responder is configured; custom commands remain
// trusted-local code, not a sandbox.
type ACPAdapter struct {
	launcher   types.AgentLauncher
	workingDir string
	options    AdapterOptions
	name       string

	mu                 sync.Mutex
	writeMu            sync.Mutex // serializes every stdin frame
	scopedSessionMu    sync.Mutex // serializes bounded scoped session creation
	proc               *harnessProcess
	stdin              io.WriteCloser
	pending            map[string]*pendingCall
	pendingPermissions map[string]*pendingPermission
	nextID             int64
	gen                int64 // lifecycle generation of the current child
	// sessionGeneration advances only after a session/new response succeeds.
	// Unlike gen it is meaningful to the Runtime: a replacement session has
	// no retained conversation memory, while a transport reconnect alone does
	// not change it.
	sessionGeneration   int64
	sessionID           string
	caps                *ACPCapabilities
	sessions            map[string]*acpSession
	nextScopeGeneration int64
	onFailure           types.AdapterFailureHandler
	closing             bool
	promptActive        bool
	turnChunks          []string
	turnContext         context.Context
	turnCancel          context.CancelFunc
	turnSessionID       string
}

// NewACPAdapter creates an adapter bound to one workspace directory. It does
// not spawn anything until EnsureSession.
func NewACPAdapter(launcher types.AgentLauncher, workingDir string, options AdapterOptions) *ACPAdapter {
	if options.TurnTimeoutMs <= 0 {
		options.TurnTimeoutMs = defaultTurnTimeoutMs
	}
	if options.CancelGraceMs <= 0 {
		options.CancelGraceMs = defaultCancelGraceMs
	}
	return &ACPAdapter{
		launcher:           launcher,
		workingDir:         workingDir,
		options:            options,
		name:               launcher.ID,
		pending:            make(map[string]*pendingCall),
		pendingPermissions: make(map[string]*pendingPermission),
		sessions:           make(map[string]*acpSession),
	}
}

// Name identifies the adapter in status output.
func (a *ACPAdapter) Name() string { return a.name }

// Capabilities exposes negotiated capabilities (nil pre-init).
func (a *ACPAdapter) Capabilities() *types.HarnessCapabilities {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.caps == nil {
		return nil
	}
	return &types.HarnessCapabilities{
		Text:   true,
		Images: a.caps.Images,
		Resume: a.caps.ResumePresent,
	}
}

// SessionControls returns a copy of the native mode/config metadata last
// advertised by session/new or session/update. It is resident-local and is
// cleared when the ACP session is replaced or the Harness exits.
func (a *ACPAdapter) SessionControls() *ACPSessionControls {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.caps == nil {
		return nil
	}
	return cloneSessionControls(a.caps.SessionControls)
}

// PendingPermissionCount reports the number of permission requests currently
// parked for the active turn. It is intentionally local diagnostic state and
// never enters Room/status output.
func (a *ACPAdapter) PendingPermissionCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.pendingPermissions)
}

// SetPermissionResponder installs the resident-local decision seam after the
// Runtime has been constructed. The callback never leaves the process and is
// replaced atomically with the adapter's other ACP state.
func (a *ACPAdapter) SetPermissionResponder(responder ACPPermissionResponder) {
	a.mu.Lock()
	a.options.PermissionResponder = responder
	a.mu.Unlock()
}

// SetActivityHandler installs the coarse Runtime projection seam. It never
// exposes native ACP payloads outside this process.
func (a *ACPAdapter) SetActivityHandler(handler ACPActivityHandler) {
	a.mu.Lock()
	a.options.ActivityHandler = handler
	a.mu.Unlock()
}

// PermissionRequestLifetime is the Room request lifetime compatible with the
// adapter's local turn timeout. The one-second margin lets the Room expire an
// interactive request before the ACP turn's own timeout boundary. A duration
// shorter than the Room's minimum is reported as zero so the Runtime fails
// closed before creating a request that could outlive its local responder.
func (a *ACPAdapter) PermissionRequestLifetime() time.Duration {
	a.mu.Lock()
	timeoutMs := a.options.TurnTimeoutMs
	a.mu.Unlock()
	if timeoutMs <= 0 {
		timeoutMs = defaultTurnTimeoutMs
	}
	lifetime := time.Duration(timeoutMs)*time.Millisecond - time.Second
	if lifetime < time.Second {
		return 0
	}
	return lifetime
}

// SetMode applies one Harness-native session mode that was advertised by the
// current session. The adapter does not infer or translate policy semantics.
func (a *ACPAdapter) SetMode(modeID string) error {
	a.mu.Lock()
	if a.sessionID == "" || a.stdin == nil || a.caps == nil || a.caps.SessionControls == nil || a.caps.SessionControls.Modes == nil {
		a.mu.Unlock()
		return errors.New("ACP session mode control is unavailable")
	}
	if !hasMode(a.caps.SessionControls.Modes, modeID) {
		a.mu.Unlock()
		return fmt.Errorf("ACP session mode %q was not advertised", modeID)
	}
	sessionID := a.sessionID
	generation := a.sessionGeneration
	a.mu.Unlock()

	params, _ := json.Marshal(map[string]any{"sessionId": sessionID, "modeId": modeID})
	if _, err := a.request("session/set_mode", params); err != nil {
		return err
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if a.sessionID == sessionID && a.sessionGeneration == generation && a.caps != nil && a.caps.SessionControls != nil && a.caps.SessionControls.Modes != nil {
		a.caps.SessionControls.Modes.CurrentModeID = modeID
	}
	return nil
}

// SetConfigOption applies one advertised native session config option. A
// value must be present in the option's advertised values; this prevents the
// generic adapter from inventing or silently broadening Harness policy.
func (a *ACPAdapter) SetConfigOption(configID, value string) error {
	a.mu.Lock()
	if a.sessionID == "" || a.stdin == nil || a.caps == nil || a.caps.SessionControls == nil {
		a.mu.Unlock()
		return errors.New("ACP session config control is unavailable")
	}
	option, ok := findConfigOption(a.caps.SessionControls.ConfigOptions, configID)
	if !ok {
		a.mu.Unlock()
		return fmt.Errorf("ACP session config option %q was not advertised", configID)
	}
	if !hasConfigValue(option, value) {
		a.mu.Unlock()
		return fmt.Errorf("ACP config value %q was not advertised for %q", value, configID)
	}
	sessionID := a.sessionID
	generation := a.sessionGeneration
	a.mu.Unlock()

	params, _ := json.Marshal(map[string]any{
		"sessionId": sessionID,
		"configId":  configID,
		"value":     value,
	})
	response, err := a.request("session/set_config_option", params)
	if err != nil {
		return err
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if a.sessionID != sessionID || a.sessionGeneration != generation || a.caps == nil || a.caps.SessionControls == nil {
		return nil
	}
	if controls := parseSessionControls(response.Result); controls != nil && len(controls.ConfigOptions) > 0 {
		a.caps.SessionControls.ConfigOptions = controls.ConfigOptions
	} else if current, ok := findConfigOption(a.caps.SessionControls.ConfigOptions, configID); ok {
		current.CurrentValue = value
		replaceConfigOption(a.caps.SessionControls.ConfigOptions, current)
	}
	return nil
}

// SessionGeneration identifies the current successfully-created ACP
// conversation generation. It deliberately does not expose the ACP session
// id, which is adapter-private transport state.
func (a *ACPAdapter) SessionGeneration() int64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessionGeneration
}

// SessionGenerationFor returns the generation of one opaque logical scope.
// A process restart invalidates every scoped ACP conversation; the next
// EnsureSessionFor creates a new generation for that scope.
func (a *ACPAdapter) SessionGenerationFor(scope string) int64 {
	if scope == "room" || strings.TrimSpace(scope) == "" {
		return a.SessionGeneration()
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if session := a.sessions[scope]; session != nil {
		return session.generation
	}
	return 0
}

// SessionDiagnostics returns the currently retained ACP conversation mapping
// for local daemon/CLI status only. The snapshot contains no prompt/context
// data and is sorted by logical scope so map iteration cannot affect output.
func (a *ACPAdapter) SessionDiagnostics() []types.HarnessSessionDiagnostic {
	a.mu.Lock()
	defer a.mu.Unlock()

	diagnostics := make([]types.HarnessSessionDiagnostic, 0, 1+len(a.sessions))
	if a.sessionID != "" && a.sessionGeneration > 0 {
		diagnostics = append(diagnostics, types.HarnessSessionDiagnostic{
			Scope:      "room",
			SessionID:  a.sessionID,
			Generation: a.sessionGeneration,
		})
	}

	scopes := make([]string, 0, len(a.sessions))
	for scope, session := range a.sessions {
		if session != nil && session.sessionID != "" && session.generation > 0 {
			scopes = append(scopes, scope)
		}
	}
	sort.Strings(scopes)
	for _, scope := range scopes {
		session := a.sessions[scope]
		diagnostics = append(diagnostics, types.HarnessSessionDiagnostic{
			Scope:      scope,
			SessionID:  session.sessionID,
			Generation: session.generation,
		})
	}
	return diagnostics
}

// OnFailure registers the handler invoked on unexpected process death.
func (a *ACPAdapter) OnFailure(handler types.AdapterFailureHandler) {
	a.mu.Lock()
	a.onFailure = handler
	a.mu.Unlock()
}

func (a *ACPAdapter) fail(err error) {
	a.mu.Lock()
	handler := a.onFailure
	closing := a.closing
	a.mu.Unlock()
	if handler != nil && !closing {
		handler(err)
	}
}

// markProcessDead clears all connection state and notifies the runtime, but
// ONLY for notifications belonging to the CURRENT process generation: delayed
// EOF from an earlier dead child must never wipe a fresh respawn.
func (a *ACPAdapter) markProcessDead(gen int64, err error) {
	var turnCancel context.CancelFunc
	a.mu.Lock()
	if a.closing {
		a.mu.Unlock()
		return
	}
	if gen != a.gen {
		a.mu.Unlock()
		return
	}
	live := a.proc != nil || a.stdin != nil || a.sessionID != "" || a.caps != nil || len(a.sessions) > 0 || len(a.pending) > 0 || len(a.pendingPermissions) > 0
	if !live {
		a.mu.Unlock()
		return
	}
	a.proc = nil
	a.stdin = nil
	a.sessionID = ""
	a.caps = nil
	a.sessions = make(map[string]*acpSession)
	for _, call := range a.pending {
		close(call.result)
	}
	a.pending = make(map[string]*pendingCall)
	a.pendingPermissions = make(map[string]*pendingPermission)
	turnCancel = a.turnCancel
	a.turnContext = nil
	a.turnCancel = nil
	a.turnSessionID = ""
	a.promptActive = false
	a.turnChunks = nil
	a.mu.Unlock()
	if turnCancel != nil {
		turnCancel()
	}
	a.fail(fmt.Errorf("ACP process exited (%v)", err))
}

// EnsureSession spawns the Harness once and negotiates initialize +
// session/new. Subsequent calls reuse the retained session; after unexpected
// process death the next call spawns a fresh process.
func (a *ACPAdapter) EnsureSession() error {
	a.mu.Lock()
	if a.sessionID != "" && a.stdin != nil && a.proc != nil {
		a.mu.Unlock()
		return nil
	}
	if a.proc != nil || a.stdin != nil {
		a.mu.Unlock()
		return errors.New("ACP session is unavailable after process failure")
	}

	command := exec.Command(a.launcher.Command, a.launcher.Args...)
	command.Dir = a.workingDir
	environment := BuildHarnessEnvironment(a.launcher, nil, a.options.AgentEnv)
	if a.options.RuntimeExecutable != "" {
		// Apply after both ambient and operator/launcher layers so a stale
		// PATH binary or custom launcher policy cannot replace the owner.
		environment[RuntimeExecutableEnv] = a.options.RuntimeExecutable
	}
	command.Env = environmentSlice(environment)
	stdinPipe, err := command.StdinPipe()
	if err != nil {
		a.mu.Unlock()
		return fmt.Errorf("ACP stdin pipe failed: %w", err)
	}
	stdoutPipe, err := command.StdoutPipe()
	if err != nil {
		a.mu.Unlock()
		return fmt.Errorf("ACP stdout pipe failed: %w", err)
	}
	// stderr drained: never parsed, never logged — it may contain Harness
	// diagnostics with ambient values.
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		a.mu.Unlock()
		return fmt.Errorf("spawn %s failed: %w", a.launcher.Command, err)
	}

	proc := newHarnessProcess(command)
	a.proc = proc
	a.stdin = stdinPipe
	a.nextID = 0
	a.gen++
	a.sessionID = ""
	a.caps = nil
	a.turnChunks = nil
	a.promptActive = false
	a.mu.Unlock()

	gen := a.gen
	go a.readLoop(stdoutPipe, gen)
	// The single Wait owner reaps the child and publishes its exit; the
	// watcher and closeInternal both observe the same signal.
	go proc.reap()
	go func() {
		<-proc.exited
		// A deliberate close sets closing first, so this stays silent on
		// graceful shutdowns and only fires for unexpected deaths.
		a.markProcessDead(gen, errors.New("exit"))
	}()

	initCaps, sessionID, err := a.handshake()
	if err != nil {
		_ = a.Close()
		return err
	}
	a.mu.Lock()
	a.sessionID = sessionID
	a.caps = initCaps
	a.sessionGeneration++
	a.mu.Unlock()
	return nil
}

// EnsureSessionFor creates one additional ACP conversation in the already
// resident Harness process. The default Room conversation remains the
// compatibility path above; task scopes share the process but never share its
// ACP session id or retained conversation.
func (a *ACPAdapter) EnsureSessionFor(scope string) error {
	scope = strings.TrimSpace(scope)
	if scope == "" {
		return errors.New("ACP logical scope is empty")
	}
	if scope == "room" {
		return a.EnsureSession()
	}
	if len(scope) > types.MaxLogicalScopeLength {
		return errors.New("ACP logical scope is too long")
	}
	a.scopedSessionMu.Lock()
	defer a.scopedSessionMu.Unlock()
	a.mu.Lock()
	if session := a.sessions[scope]; session != nil && session.sessionID != "" && a.proc != nil && a.stdin != nil {
		a.mu.Unlock()
		return nil
	}
	if len(a.sessions) >= types.MaxLogicalTaskScopes {
		a.mu.Unlock()
		return errors.New("ACP logical scope capacity reached")
	}
	a.mu.Unlock()
	if err := a.EnsureSession(); err != nil {
		return err
	}
	a.mu.Lock()
	if session := a.sessions[scope]; session != nil && session.sessionID != "" && a.proc != nil && a.stdin != nil {
		a.mu.Unlock()
		return nil
	}
	base := cloneACPCapabilities(a.caps)
	a.mu.Unlock()
	if base == nil {
		return errors.New("ACP default session is unavailable")
	}
	newParams, _ := json.Marshal(map[string]any{"cwd": a.workingDir, "mcpServers": []any{}})
	raw, err := a.request("session/new", newParams)
	if err != nil {
		return err
	}
	var sessionResponse struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(raw.Result, &sessionResponse); err != nil || sessionResponse.SessionID == "" {
		return errors.New("ACP agent did not return a sessionId")
	}
	base.SessionControls = parseSessionControls(raw.Result)
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.proc == nil || a.stdin == nil {
		return errors.New("ACP process exited while creating scoped session")
	}
	a.nextScopeGeneration++
	a.sessions[scope] = &acpSession{
		sessionID:  sessionResponse.SessionID,
		caps:       base,
		generation: a.nextScopeGeneration,
		scope:      scope,
	}
	return nil
}

func cloneACPCapabilities(caps *ACPCapabilities) *ACPCapabilities {
	if caps == nil {
		return nil
	}
	clone := *caps
	clone.SessionControls = cloneSessionControls(caps.SessionControls)
	return &clone
}

// handshake performs initialize + session/new synchronously.
func (a *ACPAdapter) handshake() (*ACPCapabilities, string, error) {
	initializeParams, _ := json.Marshal(map[string]any{
		"protocolVersion": protocolVersion,
		"clientInfo": map[string]any{
			"name":    clientName,
			"version": clientVersion,
		},
		// Deliberately advertise no filesystem, terminal, MCP, or other host
		// capabilities. Without an explicitly installed local responder,
		// permission requests remain fail-closed and are cancelled.
		"clientCapabilities": map[string]any{},
	})
	raw, err := a.request("initialize", initializeParams)
	if err != nil {
		return nil, "", err
	}
	var initResponse struct {
		ProtocolVersion   int             `json:"protocolVersion"`
		AgentCapabilities json.RawMessage `json:"agentCapabilities"`
	}
	if err := json.Unmarshal(raw.Result, &initResponse); err != nil {
		return nil, "", errors.New("ACP agent returned an invalid initialize response")
	}
	if initResponse.ProtocolVersion != protocolVersion {
		return nil, "", fmt.Errorf("Unsupported ACP protocol version: %d", initResponse.ProtocolVersion)
	}
	caps, err := parseAgentCapabilities(initResponse.AgentCapabilities)
	if err != nil {
		return nil, "", err
	}

	newParams, _ := json.Marshal(map[string]any{"cwd": a.workingDir, "mcpServers": []any{}})
	raw, err = a.request("session/new", newParams)
	if err != nil {
		return nil, "", err
	}
	var sessionResponse struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(raw.Result, &sessionResponse); err != nil || sessionResponse.SessionID == "" {
		return nil, "", errors.New("ACP agent did not return a sessionId")
	}
	caps.SessionControls = parseSessionControls(raw.Result)
	return caps, sessionResponse.SessionID, nil
}

// parseAgentCapabilities projects the raw capability document.
func parseAgentCapabilities(raw []byte) (*ACPCapabilities, error) {
	if len(raw) == 0 {
		return nil, errors.New("ACP agent did not advertise capabilities")
	}
	var doc struct {
		PromptCapabilities struct {
			Image bool `json:"image"`
		} `json:"promptCapabilities"`
		SessionCapabilities map[string]json.RawMessage `json:"sessionCapabilities"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, errors.New("ACP agent did not advertise capabilities")
	}
	caps := &ACPCapabilities{Images: doc.PromptCapabilities.Image}
	if _, ok := doc.SessionCapabilities["resume"]; ok {
		caps.ResumePresent = true
	}
	if _, ok := doc.SessionCapabilities["close"]; ok {
		caps.ClosePresent = true
	}
	return caps, nil
}

func parseSessionControls(raw []byte) *ACPSessionControls {
	var wire struct {
		Modes *struct {
			CurrentModeID string `json:"currentModeId"`
			Available     []struct {
				ID          string `json:"id"`
				Name        string `json:"name"`
				Description string `json:"description"`
			} `json:"availableModes"`
		} `json:"modes"`
		ConfigOptions []struct {
			ID           string `json:"id"`
			Name         string `json:"name"`
			Description  string `json:"description"`
			Category     string `json:"category"`
			Type         string `json:"type"`
			CurrentValue string `json:"currentValue"`
			Options      []struct {
				Value       string `json:"value"`
				Name        string `json:"name"`
				Description string `json:"description"`
			} `json:"options"`
		} `json:"configOptions"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return nil
	}

	controls := &ACPSessionControls{}
	if wire.Modes != nil {
		modes := &ACPModeState{CurrentModeID: wire.Modes.CurrentModeID}
		for _, mode := range wire.Modes.Available {
			if mode.ID == "" {
				continue
			}
			modes.AvailableModes = append(modes.AvailableModes, ACPMode{
				ID:          mode.ID,
				Name:        boundedACPText(mode.Name),
				Description: boundedACPText(mode.Description),
			})
		}
		if len(modes.AvailableModes) > 0 || modes.CurrentModeID != "" {
			controls.Modes = modes
		}
	}
	for _, option := range wire.ConfigOptions {
		if !isPolicyConfigOption(option.ID, option.Category) || option.ID == "" {
			continue
		}
		projected := ACPConfigOption{
			ID:           option.ID,
			Name:         boundedACPText(option.Name),
			Description:  boundedACPText(option.Description),
			Category:     option.Category,
			Type:         option.Type,
			CurrentValue: option.CurrentValue,
		}
		for _, value := range option.Options {
			if value.Value == "" {
				continue
			}
			projected.Options = append(projected.Options, ACPConfigOptionValue{
				Value:       value.Value,
				Name:        boundedACPText(value.Name),
				Description: boundedACPText(value.Description),
			})
		}
		controls.ConfigOptions = append(controls.ConfigOptions, projected)
	}
	if controls.Modes == nil && len(controls.ConfigOptions) == 0 {
		return nil
	}
	return controls
}

func isPolicyConfigOption(id, category string) bool {
	id = strings.ToLower(strings.TrimSpace(id))
	category = strings.ToLower(strings.TrimSpace(category))
	return id == "mode" || id == "permission" || id == "policy" ||
		strings.Contains(category, "mode") || strings.Contains(category, "permission") || strings.Contains(category, "policy")
}

func boundedACPText(value string) string {
	const maxACPText = 16 * 1024
	runes := []rune(value)
	if len(runes) <= maxACPText {
		return value
	}
	return string(runes[:maxACPText])
}

func cloneSessionControls(controls *ACPSessionControls) *ACPSessionControls {
	if controls == nil {
		return nil
	}
	clone := &ACPSessionControls{}
	if controls.Modes != nil {
		clone.Modes = &ACPModeState{CurrentModeID: controls.Modes.CurrentModeID}
		clone.Modes.AvailableModes = append([]ACPMode(nil), controls.Modes.AvailableModes...)
	}
	for _, option := range controls.ConfigOptions {
		option.Options = append([]ACPConfigOptionValue(nil), option.Options...)
		clone.ConfigOptions = append(clone.ConfigOptions, option)
	}
	return clone
}

func hasMode(modes *ACPModeState, modeID string) bool {
	for _, mode := range modes.AvailableModes {
		if mode.ID == modeID {
			return true
		}
	}
	return false
}

func findConfigOption(options []ACPConfigOption, configID string) (ACPConfigOption, bool) {
	for _, option := range options {
		if option.ID == configID {
			return option, true
		}
	}
	return ACPConfigOption{}, false
}

func hasConfigValue(option ACPConfigOption, value string) bool {
	for _, candidate := range option.Options {
		if candidate.Value == value {
			return true
		}
	}
	return false
}

func replaceConfigOption(options []ACPConfigOption, replacement ACPConfigOption) {
	for index := range options {
		if options[index].ID == replacement.ID {
			options[index] = replacement
			return
		}
	}
}

// readLoop pumps stdout frames into the dispatcher until the pipe dies.
func (a *ACPAdapter) readLoop(reader io.Reader, gen int64) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 1024*1024), 32*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var message acpMessage
		if err := json.Unmarshal(line, &message); err != nil {
			continue
		}
		a.dispatch(&message)
	}
	a.markProcessDead(gen, errors.New("stdout closed"))
}

// dispatch routes responses, agent->client requests, and notifications.
func (a *ACPAdapter) dispatch(message *acpMessage) {
	// Response to one of our requests.
	if len(message.ID) > 0 && message.Method == "" {
		key := message.idKey()
		a.mu.Lock()
		call, ok := a.pending[key]
		if ok {
			delete(a.pending, key)
		}
		a.mu.Unlock()
		if ok {
			call.result <- message
		}
		return
	}
	// Agent -> client request. Permission requests are handed off in a
	// goroutine so a delayed responder never blocks the ACP read loop.
	if len(message.ID) > 0 && message.Method != "" {
		switch message.Method {
		case "session/request_permission":
			a.dispatchPermission(message)
		default:
			rpcErr := acpRPCError{Code: -32601, Message: "method not found"}
			_ = a.writeFrame(errorFrame(message.ID, rpcErr))
		}
		return
	}
	// Notification.
	if message.Method == "session/update" {
		a.applySessionUpdate(message.Params)
		a.dispatchActivity(message.Params)
		if chunk, ok := extractTextChunk(message.Params); ok && chunk != "" {
			a.mu.Lock()
			if a.promptActive {
				a.turnChunks = append(a.turnChunks, chunk)
			}
			a.mu.Unlock()
		}
	}
}

func (a *ACPAdapter) dispatchActivity(params json.RawMessage) {
	state, ok := mapACPActivity(params)
	if !ok {
		return
	}
	var envelope struct {
		SessionID string `json:"sessionId"`
	}
	if json.Unmarshal(params, &envelope) != nil || envelope.SessionID == "" {
		return
	}
	a.mu.Lock()
	// ACP notifications arriving after session/prompt settles must not
	// resurrect a cleared activity state or bleed into the next serialized
	// turn. The current prompt/session fence is the adapter-local ordering
	// boundary.
	if !a.promptActive || a.turnSessionID != envelope.SessionID {
		a.mu.Unlock()
		return
	}
	scope := a.scopeForSessionIDLocked(envelope.SessionID)
	handler := a.options.ActivityHandler
	a.mu.Unlock()
	if handler != nil && scope != "" {
		handler(scope, state)
	}
}

// scopeForSessionIDLocked is the one adapter-local session-to-cognition-scope
// mapping shared by activity and permission projections. Callers must hold
// a.mu. An unknown session fails closed instead of being treated as Room.
func (a *ACPAdapter) scopeForSessionIDLocked(sessionID string) string {
	if sessionID == "" {
		return ""
	}
	if sessionID == a.sessionID {
		return "room"
	}
	for logicalScope, session := range a.sessions {
		if session != nil && session.sessionID == sessionID {
			return logicalScope
		}
	}
	return ""
}

func (a *ACPAdapter) dispatchPermission(message *acpMessage) {
	request, err := parsePermissionRequest(message)
	if err != nil {
		_ = a.writeFrame(cancelPermissionFrame(message.ID))
		return
	}

	key := message.idKey()
	a.mu.Lock()
	if a.closing || !a.promptActive || a.turnContext == nil || a.turnSessionID == "" || request.SessionID != a.turnSessionID {
		a.mu.Unlock()
		_ = a.writeFrame(cancelPermissionFrame(message.ID))
		return
	}
	request.Scope = a.scopeForSessionIDLocked(request.SessionID)
	if request.Scope == "" {
		a.mu.Unlock()
		_ = a.writeFrame(cancelPermissionFrame(message.ID))
		return
	}
	if _, exists := a.pendingPermissions[key]; exists {
		a.mu.Unlock()
		_ = a.writeFrame(cancelPermissionFrame(message.ID))
		return
	}
	pending := &pendingPermission{
		id:      append(json.RawMessage(nil), message.ID...),
		request: request,
	}
	a.pendingPermissions[key] = pending
	responder := a.options.PermissionResponder
	turnContext := a.turnContext
	a.mu.Unlock()

	if responder == nil {
		a.finishPermission(key, pending, "")
		return
	}
	go func() {
		response, responseErr := responder(turnContext, request)
		if responseErr != nil || response.OptionID == "" || !permissionOptionOffered(request.Options, response.OptionID) {
			a.finishPermission(key, pending, "")
			return
		}
		a.finishPermission(key, pending, response.OptionID)
	}()
}

func parsePermissionRequest(message *acpMessage) (ACPPermissionRequest, error) {
	var wire struct {
		SessionID string `json:"sessionId"`
		Meta      struct {
			Permission json.RawMessage `json:"permission"`
		} `json:"_meta"`
		ToolCall struct {
			ToolCallID string          `json:"toolCallId"`
			Title      string          `json:"title"`
			Kind       string          `json:"kind"`
			Status     string          `json:"status"`
			RawInput   json.RawMessage `json:"rawInput"`
			Content    json.RawMessage `json:"content"`
			Meta       struct {
				Permission json.RawMessage `json:"permission"`
			} `json:"_meta"`
		} `json:"toolCall"`
		Options []struct {
			OptionID string          `json:"optionId"`
			Name     string          `json:"name"`
			Kind     string          `json:"kind"`
			Meta     json.RawMessage `json:"_meta"`
		} `json:"options"`
	}
	if err := json.Unmarshal(message.Params, &wire); err != nil || wire.SessionID == "" {
		return ACPPermissionRequest{}, errors.New("invalid ACP permission request")
	}
	request := ACPPermissionRequest{
		RequestID: message.idKey(),
		SessionID: wire.SessionID,
		ToolCall: ACPToolCall{
			ToolCallID: wire.ToolCall.ToolCallID,
			Title:      boundedACPText(wire.ToolCall.Title),
			Kind:       wire.ToolCall.Kind,
			Status:     wire.ToolCall.Status,
			RawInput:   cloneRawJSON(wire.ToolCall.RawInput),
			Content:    cloneRawJSON(wire.ToolCall.Content),
			Permission: parsePermissionPresentation(
				wire.Meta.Permission,
				wire.ToolCall.Meta.Permission,
			),
		},
	}
	for _, option := range wire.Options {
		if option.OptionID == "" {
			continue
		}
		request.Options = append(request.Options, ACPPermissionOption{
			OptionID: option.OptionID,
			Name:     boundedACPText(option.Name),
			Kind:     option.Kind,
			Meta:     cloneRawJSON(option.Meta),
		})
	}
	return request, nil
}

func parsePermissionPresentation(rawValues ...json.RawMessage) *ACPPermissionPresentation {
	presentation := &ACPPermissionPresentation{}
	for _, raw := range rawValues {
		if len(raw) == 0 {
			continue
		}
		var wire struct {
			Title       json.RawMessage `json:"title"`
			Description json.RawMessage `json:"description"`
		}
		if json.Unmarshal(raw, &wire) != nil {
			continue
		}
		if presentation.Title == "" {
			presentation.Title = boundedPermissionMetaString(wire.Title)
		}
		if presentation.Description == "" {
			presentation.Description = boundedPermissionMetaString(wire.Description)
		}
	}
	if presentation.Title == "" && presentation.Description == "" {
		return nil
	}
	return presentation
}

func boundedPermissionMetaString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	return boundedACPText(value)
}

func cloneRawJSON(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	return append(json.RawMessage(nil), raw...)
}

func permissionOptionOffered(options []ACPPermissionOption, optionID string) bool {
	for _, option := range options {
		if option.OptionID == optionID {
			return true
		}
	}
	return false
}

func (a *ACPAdapter) finishPermission(key string, pending *pendingPermission, optionID string) {
	a.mu.Lock()
	current, ok := a.pendingPermissions[key]
	if !ok || current != pending {
		a.mu.Unlock()
		return
	}
	delete(a.pendingPermissions, key)
	a.mu.Unlock()
	if optionID == "" {
		_ = a.writeFrame(cancelPermissionFrame(pending.id))
		return
	}
	_ = a.writeFrame(selectedPermissionFrame(pending.id, optionID))
}

func cancelPermissionFrame(id json.RawMessage) []byte {
	return responseFrame(id, map[string]any{
		"outcome": map[string]any{"outcome": "cancelled"},
	})
}

func selectedPermissionFrame(id json.RawMessage, optionID string) []byte {
	return responseFrame(id, map[string]any{
		"outcome": map[string]any{"outcome": "selected", "optionId": optionID},
	})
}

func (a *ACPAdapter) applySessionUpdate(params json.RawMessage) {
	var update struct {
		SessionID string `json:"sessionId"`
		Update    struct {
			SessionUpdate string            `json:"sessionUpdate"`
			CurrentModeID string            `json:"currentModeId"`
			ConfigOptions []json.RawMessage `json:"configOptions"`
		} `json:"update"`
	}
	if json.Unmarshal(params, &update) != nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	caps := a.caps
	if update.SessionID != "" && update.SessionID != a.sessionID {
		caps = nil
		for _, session := range a.sessions {
			if session.sessionID == update.SessionID {
				caps = session.caps
				break
			}
		}
	}
	if caps == nil || caps.SessionControls == nil {
		return
	}
	switch update.Update.SessionUpdate {
	case "current_mode_update":
		if caps.SessionControls.Modes != nil && update.Update.CurrentModeID != "" {
			caps.SessionControls.Modes.CurrentModeID = update.Update.CurrentModeID
		}
	case "config_option_update":
		if len(update.Update.ConfigOptions) == 0 {
			return
		}
		controls := parseSessionControls(mustJSON(map[string]any{"configOptions": update.Update.ConfigOptions}))
		if controls != nil && len(controls.ConfigOptions) > 0 {
			caps.SessionControls.ConfigOptions = controls.ConfigOptions
		}
	}
}

// extractTextChunk pulls appended ASSISTANT MESSAGE text out of
// session/update notifications. Only agent_message_chunk events accumulate;
// internal reasoning events (agent_thought_chunk, any other sessionUpdate)
// are deliberately dropped — they must never reach the public send_text
// reply (the Node reference's session.prompt + readText reads the assistant
// message, not thoughts). Handles single content blocks and block arrays.
func extractTextChunk(params json.RawMessage) (string, bool) {
	if len(params) == 0 {
		return "", false
	}
	var updateDoc struct {
		Update struct {
			SessionUpdate string          `json:"sessionUpdate"`
			Content       json.RawMessage `json:"content"`
		} `json:"update"`
	}
	if err := json.Unmarshal(params, &updateDoc); err != nil {
		return "", false
	}
	if updateDoc.Update.SessionUpdate != "agent_message_chunk" {
		return "", false
	}
	appendTextBlocks := func(content json.RawMessage) string {
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if err := json.Unmarshal(content, &blocks); err == nil && len(blocks) > 0 {
			var out strings.Builder
			for _, block := range blocks {
				if block.Type == "text" {
					out.WriteString(block.Text)
				}
			}
			if out.Len() > 0 {
				return out.String()
			}
		}
		var single struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if err := json.Unmarshal(content, &single); err == nil && single.Type == "text" {
			return single.Text
		}
		return ""
	}
	text := appendTextBlocks(updateDoc.Update.Content)
	if text == "" {
		return "", false
	}
	return text, true
}

// writeFrame serializes one frame onto the child's stdin; pipe writes from
// different goroutines never interleave thanks to writeMu.
func (a *ACPAdapter) writeFrame(frame []byte) error {
	a.mu.Lock()
	writer := a.stdin
	a.mu.Unlock()
	if writer == nil {
		return errors.New("ACP connection is unavailable")
	}
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	if _, err := writer.Write(append(frame, '\n')); err != nil {
		writeErr := err
		a.mu.Lock()
		gen := a.gen
		a.mu.Unlock()
		go a.markProcessDead(gen, writeErr)
		return err
	}
	return nil
}

// request sends a JSON-RPC request and awaits its response.
func (a *ACPAdapter) request(method string, params []byte) (*acpMessage, error) {
	a.mu.Lock()
	if a.stdin == nil {
		a.mu.Unlock()
		return nil, errors.New("ACP connection is unavailable")
	}
	a.nextID++
	id, _ := json.Marshal(a.nextID)
	envelope, _ := json.Marshal(acpMessage{
		JSONRPC: "2.0",
		ID:      id,
		Method:  method,
		Params:  params,
	})
	call := &pendingCall{result: make(chan *acpMessage, 1)}
	a.pending[compactJSON(id)] = call
	a.mu.Unlock()

	if err := a.writeFrame(envelope); err != nil {
		return nil, fmt.Errorf("ACP write failed: %w", err)
	}
	response := <-call.result
	if response == nil {
		return nil, errors.New("ACP process exited")
	}
	if response.Error != nil {
		return response, fmt.Errorf("ACP %s failed: %s", method, response.Error.Message)
	}
	return response, nil
}

func responseFrame(id json.RawMessage, result any) []byte {
	envelope, _ := json.Marshal(acpMessage{JSONRPC: "2.0", ID: id, Result: mustJSON(result)})
	return envelope
}

func errorFrame(id json.RawMessage, rpcErr acpRPCError) []byte {
	envelope, _ := json.Marshal(acpMessage{JSONRPC: "2.0", ID: id, Error: &rpcErr})
	return envelope
}

func mustJSON(value any) json.RawMessage {
	raw, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("null")
	}
	return raw
}

// promptBlocks builds the content blocks: the rendered untrusted-room text
// first, then image blocks only when the Harness negotiated image support.
func promptBlocks(input types.HarnessTurnInput, supportsImages bool) []map[string]any {
	blocks := []map[string]any{
		{"type": "text", "text": RenderUntrustedRoomTurn(&input)},
	}
	if !supportsImages {
		return blocks
	}
	imageCount := 0
	for _, event := range input.Events {
		if event.Image != nil && imageCount < maxPromptImagesPerTurn {
			blocks = append(blocks, map[string]any{
				"type":     "image",
				"data":     event.Image.Data,
				"mimeType": event.Image.MimeType,
			})
			imageCount++
		}
		for _, attachment := range event.ReferencedAttachments {
			if attachment.Image == nil || imageCount >= maxPromptImagesPerTurn {
				continue
			}
			blocks = append(blocks, map[string]any{
				"type":     "image",
				"data":     attachment.Image.Data,
				"mimeType": attachment.Image.MimeType,
			})
			imageCount++
		}
	}
	return blocks
}

// RunTurn keeps the original default Room adapter contract.
func (a *ACPAdapter) RunTurn(input types.HarnessTurnInput, expectedSessionGeneration int64) (types.HarnessTurnResult, error) {
	return a.RunTurnFor("room", input, expectedSessionGeneration)
}

// RunTurnFor executes one addressed turn against the exact retained session
// generation prepared by the Runtime. In particular, this method must not
// call EnsureSessionFor: doing so could create or switch conversations after
// the Runtime rendered a prompt for a specific generation.
func (a *ACPAdapter) RunTurnFor(scope string, input types.HarnessTurnInput, expectedSessionGeneration int64) (types.HarnessTurnResult, error) {
	a.mu.Lock()
	var sessionID string
	var caps *ACPCapabilities
	var generation int64
	if scope == "room" || strings.TrimSpace(scope) == "" {
		sessionID, caps, generation = a.sessionID, a.caps, a.sessionGeneration
	} else if session := a.sessions[scope]; session != nil {
		sessionID, caps, generation = session.sessionID, session.caps, session.generation
	}
	if expectedSessionGeneration <= 0 || generation != expectedSessionGeneration {
		a.mu.Unlock()
		return types.HarnessTurnResult{}, types.ErrHarnessSessionGenerationChanged
	}
	if sessionID == "" || a.stdin == nil {
		a.mu.Unlock()
		return types.HarnessTurnResult{}, errors.New("ACP session is unavailable")
	}
	if a.promptActive {
		a.mu.Unlock()
		return types.HarnessTurnResult{}, errors.New("ACP prompt is already running")
	}
	a.promptActive = true
	a.turnChunks = nil
	a.turnContext, a.turnCancel = context.WithCancel(context.Background())
	a.turnSessionID = sessionID
	blocks := promptBlocks(input, caps != nil && caps.Images)
	params, _ := json.Marshal(map[string]any{
		"sessionId": sessionID,
		"prompt":    blocks,
	})
	a.nextID++
	id, _ := json.Marshal(a.nextID)
	envelope, _ := json.Marshal(acpMessage{
		JSONRPC: "2.0",
		ID:      id,
		Method:  "session/prompt",
		Params:  params,
	})
	key := compactJSON(id)
	call := &pendingCall{result: make(chan *acpMessage, 1)}
	a.pending[key] = call
	timeoutMs := a.options.TurnTimeoutMs
	graceMs := a.options.CancelGraceMs
	a.mu.Unlock()

	if err := a.writeFrame(envelope); err != nil {
		a.resetPrompt(key)
		return types.HarnessTurnResult{}, fmt.Errorf("ACP write failed: %w", err)
	}

	timeout := time.After(time.Duration(timeoutMs) * time.Millisecond)
	timedOut := false
	settled := false
	var response *acpMessage
	for !settled {
		select {
		case response = <-call.result:
			if response == nil {
				a.resetPrompt(key)
				return types.HarnessTurnResult{}, errors.New("ACP process exited")
			}
			settled = true
		case <-timeout:
			timedOut = true
			settled = true
		}
	}

	if timedOut {
		// The call stays registered during recovery so a late settle remains
		// routable; a genuine termination clears it with the connection.
		err := a.recoverTimedOutTurn(call, key, graceMs)
		return types.HarnessTurnResult{}, err
	}

	// Snapshot the streamed reply BEFORE clearing per-turn state: late
	// chunk notifications must not be dropped by the reset.
	text := a.drainChunks()
	a.resetPrompt(key)
	if response.Error != nil {
		return types.HarnessTurnResult{}, fmt.Errorf("ACP session/prompt failed: %s", response.Error.Message)
	}
	// Strict outbound controls are extracted here, at the Harness boundary,
	// from the aggregated reply text — never from prose heuristics. A result
	// may carry either existing outbound targets or the closed local leave
	// intent, never both; plain replies parse back unchanged.
	body, targets, lifecycle := ParseOutboundResult(text)
	return types.HarnessTurnResult{
		Text:                 body,
		TargetParticipantIDs: targets,
		LifecycleIntent:      lifecycle,
	}, nil
}

// drainChunks snapshots and resets per-turn accumulation.
func (a *ACPAdapter) drainChunks() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	text := strings.TrimSpace(strings.Join(a.turnChunks, ""))
	a.turnChunks = nil
	return text
}

// resetPrompt clears per-turn bookkeeping once a prompt definitively settled.
func (a *ACPAdapter) resetPrompt(key string) {
	a.mu.Lock()
	delete(a.pending, key)
	turnCancel := a.turnCancel
	a.turnContext = nil
	a.turnCancel = nil
	a.turnSessionID = ""
	permissions := a.takePendingPermissionsLocked()
	a.promptActive = false
	a.turnChunks = nil
	a.mu.Unlock()
	if turnCancel != nil {
		turnCancel()
	}
	for _, permission := range permissions {
		_ = a.writeFrame(cancelPermissionFrame(permission.id))
	}
}

func (a *ACPAdapter) takePendingPermissionsLocked() []*pendingPermission {
	permissions := make([]*pendingPermission, 0, len(a.pendingPermissions))
	for _, permission := range a.pendingPermissions {
		permissions = append(permissions, permission)
	}
	a.pendingPermissions = make(map[string]*pendingPermission)
	return permissions
}

func (a *ACPAdapter) cancelPendingPermissions() {
	a.mu.Lock()
	turnCancel := a.turnCancel
	permissions := a.takePendingPermissionsLocked()
	a.mu.Unlock()
	if turnCancel != nil {
		turnCancel()
	}
	for _, permission := range permissions {
		_ = a.writeFrame(cancelPermissionFrame(permission.id))
	}
}

// recoverTimedOutTurn cancels the prompt and, if it does not settle within
// the cancel grace, terminates the Harness process (final boundary).
func (a *ACPAdapter) recoverTimedOutTurn(call *pendingCall, key string, graceMs int64) error {
	timeoutErr := &TurnTimeoutError{TimeoutMs: int64(defaultTurnTimeoutMs)}
	timeoutErr.TimeoutMs = a.options.TurnTimeoutMs
	cancelErr := a.CancelTurn()

	grace := time.After(time.Duration(graceMs) * time.Millisecond)
	select {
	case response := <-call.result:
		if response != nil {
			a.resetPrompt(key)
		}
		return timeoutErr
	case <-grace:
	}

	_ = cancelErr
	// No settlement inside the grace window: terminate the child; its exit
	// also unregisters everything left through markProcessDead/closing.
	_ = a.closeInternal(true)
	return timeoutErr
}

// CancelTurn notifies the Harness to cancel the active prompt.
func (a *ACPAdapter) CancelTurn() error {
	a.mu.Lock()
	if a.turnSessionID == "" || a.stdin == nil || !a.promptActive {
		a.mu.Unlock()
		return nil
	}
	params, _ := json.Marshal(map[string]any{"sessionId": a.turnSessionID})
	envelope, _ := json.Marshal(acpMessage{
		JSONRPC: "2.0",
		Method:  "session/cancel",
		Params:  params,
	})
	a.mu.Unlock()

	a.cancelPendingPermissions()
	return a.writeFrame(envelope)
}

// Close performs the bounded shutdown: optional graceful session/close,
// then SIGTERM, escalating to SIGKILL after the shutdown timeout. The
// closing flag suppresses spurious failure callbacks during teardown.
func (a *ACPAdapter) Close() error {
	return a.closeInternal(false)
}

/*
 * force deliberately skips session/close: a stuck Harness may ignore both
 * the prompt cancellation and any normal ACP request, so process
 * termination is the final recovery boundary.
 */
func (a *ACPAdapter) forceClose() {
	_ = a.closeInternal(true)
}

func (a *ACPAdapter) closeInternal(force bool) error {
	var turnCancel context.CancelFunc
	a.mu.Lock()
	if a.closing {
		a.mu.Unlock()
		return nil
	}
	a.closing = true
	proc := a.proc
	writer := a.stdin
	closeFrames := make([][]byte, 0, 1+len(a.sessions))
	if !force && a.caps != nil && a.caps.ClosePresent && a.sessionID != "" {
		closeFrames = append(closeFrames, a.sessionCloseFrameLocked(a.sessionID))
	}
	for _, session := range a.sessions {
		if !force && session.caps != nil && session.caps.ClosePresent && session.sessionID != "" {
			closeFrames = append(closeFrames, a.sessionCloseFrameLocked(session.sessionID))
		}
	}
	a.sessionID = ""
	a.caps = nil
	a.sessions = make(map[string]*acpSession)
	a.stdin = nil
	a.proc = nil
	a.promptActive = false
	a.turnChunks = nil
	turnCancel = a.turnCancel
	a.turnContext = nil
	a.turnCancel = nil
	a.turnSessionID = ""
	for _, call := range a.pending {
		close(call.result)
	}
	a.pending = make(map[string]*pendingCall)
	a.pendingPermissions = make(map[string]*pendingPermission)
	a.mu.Unlock()
	if turnCancel != nil {
		turnCancel()
	}

	// Teardown state is cleared; allow a later EnsureSession to spawn a
	// fresh process (timed-out turns rely on this recovery path). Late death
	// notifications against cleared state stay silent no-ops.
	defer func() {
		a.mu.Lock()
		a.closing = false
		a.mu.Unlock()
	}()

	/* Graceful session/close only when not force-tearing down a stuck
	 * Harness; process termination below remains the final boundary. */
	if writer != nil {
		if len(closeFrames) > 0 {
			done := make(chan struct{})
			go func() {
				for _, frame := range closeFrames {
					_, _ = writer.Write(append(frame, '\n'))
				}
				close(done)
			}()
			select {
			case <-done:
			case <-time.After(500 * time.Millisecond):
			}
		}
		_ = writer.Close()
	}
	if proc != nil && proc.cmd.Process != nil {
		pid := proc.cmd.Process.Pid
		// The watcher goroutine remains the single Wait owner; we observe
		// its exit signal instead of re-Wait-ing the same Cmd. A Harness
		// that ignores SIGTERM therefore reaches the SIGKILL fallback after
		// the shutdown budget instead of slipping past it.
		_ = syscall.Kill(pid, syscall.SIGTERM)
		select {
		case <-proc.exited:
		case <-time.After(time.Duration(shutdownTimeoutMs) * time.Millisecond):
			_ = syscall.Kill(pid, syscall.SIGKILL)
			select {
			case <-proc.exited:
			case <-time.After(2 * time.Second):
				// Absolute bound: even a pathological reaper stall cannot
				// make shutdown unbounded; the background reaper still
				// collects the zombie.
			}
		}
	}
	return nil
}

func (a *ACPAdapter) sessionCloseFrameLocked(sessionID string) []byte {
	a.nextID++
	id, _ := json.Marshal(a.nextID)
	params, _ := json.Marshal(map[string]any{"sessionId": sessionID})
	frame, _ := json.Marshal(acpMessage{
		JSONRPC: "2.0",
		ID:      id,
		Method:  "session/close",
		Params:  params,
	})
	return frame
}

// environmentSlice converts a filtered map into exec.Env form (sorted for
// determinism).
func environmentSlice(environment map[string]string) []string {
	keys := make([]string, 0, len(environment))
	for key := range environment {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		out = append(out, key+"="+environment[key])
	}
	return out
}
