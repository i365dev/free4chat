package harness

import (
	"bufio"
	"bytes"
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
	shutdownTimeoutMs    = 2_000
	defaultTurnTimeoutMs = 120_000
	defaultCancelGraceMs = 2_000

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
}

// ACPCapabilities is the parsed initialize response projection.
type ACPCapabilities struct {
	Images bool
	// ResumePresent mirrors the Node `resume != null` check: the mere
	// presence of the sessionCapabilities.resume key counts as support.
	ResumePresent bool
	// ClosePresent gates the graceful session/close attempt on shutdown.
	ClosePresent bool
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
// fail-closed (always cancelled); custom commands remain trusted-local code,
// not a sandbox.
type ACPAdapter struct {
	launcher   types.AgentLauncher
	workingDir string
	options    AdapterOptions
	name       string

	mu      sync.Mutex
	writeMu sync.Mutex // serializes every stdin frame
	proc    *harnessProcess
	stdin   io.WriteCloser
	pending map[string]*pendingCall
	nextID  int64
	gen     int64 // lifecycle generation of the current child
	// sessionGeneration advances only after a session/new response succeeds.
	// Unlike gen it is meaningful to the Runtime: a replacement session has
	// no retained conversation memory, while a transport reconnect alone does
	// not change it.
	sessionGeneration int64
	sessionID         string
	caps              *ACPCapabilities
	onFailure         types.AdapterFailureHandler
	closing           bool
	promptActive      bool
	turnChunks        []string
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
		launcher:   launcher,
		workingDir: workingDir,
		options:    options,
		name:       launcher.ID,
		pending:    make(map[string]*pendingCall),
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

// SessionGeneration identifies the current successfully-created ACP
// conversation generation. It deliberately does not expose the ACP session
// id, which is adapter-private transport state.
func (a *ACPAdapter) SessionGeneration() int64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessionGeneration
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
	a.mu.Lock()
	if a.closing {
		a.mu.Unlock()
		return
	}
	if gen != a.gen {
		a.mu.Unlock()
		return
	}
	live := a.proc != nil || a.stdin != nil || a.sessionID != "" || a.caps != nil || len(a.pending) > 0
	if !live {
		a.mu.Unlock()
		return
	}
	a.proc = nil
	a.stdin = nil
	a.sessionID = ""
	a.caps = nil
	for _, call := range a.pending {
		close(call.result)
	}
	a.pending = make(map[string]*pendingCall)
	a.promptActive = false
	a.turnChunks = nil
	a.mu.Unlock()
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
	command.Env = environmentSlice(BuildHarnessEnvironment(a.launcher, nil))
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

// handshake performs initialize + session/new synchronously.
func (a *ACPAdapter) handshake() (*ACPCapabilities, string, error) {
	initializeParams, _ := json.Marshal(map[string]any{
		"protocolVersion": protocolVersion,
		"clientInfo": map[string]any{
			"name":    clientName,
			"version": clientVersion,
		},
		// Deliberately advertise no filesystem, terminal, MCP, or other host
		// capabilities. Permission requests are cancelled as well.
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
	// Agent -> client request. Permission requests are fail-closed:
	// always answered cancelled; everything else is method-not-found.
	if len(message.ID) > 0 && message.Method != "" {
		switch message.Method {
		case "session/request_permission":
			result, _ := json.Marshal(map[string]any{
				"outcome": map[string]any{"outcome": "cancelled"},
			})
			_ = a.writeFrame(responseFrame(message.ID, result))
		default:
			rpcErr := acpRPCError{Code: -32601, Message: "method not found"}
			_ = a.writeFrame(errorFrame(message.ID, rpcErr))
		}
		return
	}
	// Notification.
	if message.Method == "session/update" {
		if chunk, ok := extractTextChunk(message.Params); ok && chunk != "" {
			a.mu.Lock()
			if a.promptActive {
				a.turnChunks = append(a.turnChunks, chunk)
			}
			a.mu.Unlock()
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
	for _, event := range input.Events {
		if event.Image != nil {
			blocks = append(blocks, map[string]any{
				"type":     "image",
				"data":     event.Image.Data,
				"mimeType": event.Image.MimeType,
			})
		}
	}
	return blocks
}

// RunTurn executes one addressed turn against the exact retained session
// generation prepared by the Runtime. In particular, this method must not
// call EnsureSession: doing so could respawn a Harness after the Runtime had
// already rendered a non-bootstrap prompt for the dead conversation.
func (a *ACPAdapter) RunTurn(input types.HarnessTurnInput, expectedSessionGeneration int64) (types.HarnessTurnResult, error) {
	a.mu.Lock()
	if expectedSessionGeneration <= 0 || a.sessionGeneration != expectedSessionGeneration {
		a.mu.Unlock()
		return types.HarnessTurnResult{}, types.ErrHarnessSessionGenerationChanged
	}
	if a.sessionID == "" || a.stdin == nil {
		a.mu.Unlock()
		return types.HarnessTurnResult{}, errors.New("ACP session is unavailable")
	}
	if a.promptActive {
		a.mu.Unlock()
		return types.HarnessTurnResult{}, errors.New("ACP prompt is already running")
	}
	a.promptActive = true
	a.turnChunks = nil
	blocks := promptBlocks(input, a.caps != nil && a.caps.Images)
	params, _ := json.Marshal(map[string]any{
		"sessionId": a.sessionID,
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
	a.promptActive = false
	a.turnChunks = nil
	a.mu.Unlock()
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
	if a.sessionID == "" || a.stdin == nil || !a.promptActive {
		a.mu.Unlock()
		return nil
	}
	params, _ := json.Marshal(map[string]any{"sessionId": a.sessionID})
	envelope, _ := json.Marshal(acpMessage{
		JSONRPC: "2.0",
		Method:  "session/cancel",
		Params:  params,
	})
	a.mu.Unlock()

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
	a.mu.Lock()
	if a.closing {
		a.mu.Unlock()
		return nil
	}
	a.closing = true
	proc := a.proc
	writer := a.stdin
	sessionID := a.sessionID
	closePresent := a.caps != nil && a.caps.ClosePresent
	nextID := a.nextID + 1
	a.nextID = nextID
	a.sessionID = ""
	a.caps = nil
	a.stdin = nil
	a.proc = nil
	a.promptActive = false
	a.turnChunks = nil
	for _, call := range a.pending {
		close(call.result)
	}
	a.pending = make(map[string]*pendingCall)
	a.mu.Unlock()

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
	var envelope []byte
	if !force && writer != nil && sessionID != "" && closePresent {
		id, _ := json.Marshal(nextID)
		params, _ := json.Marshal(map[string]any{"sessionId": sessionID})
		envelope, _ = json.Marshal(acpMessage{
			JSONRPC: "2.0",
			ID:      id,
			Method:  "session/close",
			Params:  params,
		})
	}
	if writer != nil {
		if envelope != nil {
			done := make(chan struct{})
			go func() {
				_, _ = writer.Write(append(envelope, '\n'))
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
