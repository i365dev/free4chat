// Command fakeagent is a scripted ACP v1 Harness used only by the Go Agent
// Runtime tests (built on demand by TestMain; never shipped or imported).
//
// Modes are selected through FAKE_MODE:
//
//	normal         reply incrementally to every prompt
//	env            reply with the Harness-visible FREE4CHAT_AGENT_DIR
//	context_read   invoke the local CLI's bounded Room context read
//	permission     answer a targeted turn after an auto-cancelled permission ask
//	permission_wait  park a permission ask until the client chooses an offered option
//	cancel         hold the requested turn until session/cancel arrives
//	session_echo   reply with the exact session id the prompt was addressed to
//	exit           die shortly after the first prompt completes
//	restart        die after the first prompt; fresh process answers differently
//	timeout_stuck  ignore the first prompt forever (survives SIGTERM); next process recovers
//	envelope       reply with the exact FAKE_REPLY_TEXT payload (#165 addressing tests)
//	hold_all       park EVERY prompt per session and run them CONCURRENTLY: a
//	               prompt is released by session/cancel for its own session, or
//	               by the test creating FAKE_RELEASE_DIR/<sessionId>. This is
//	               the model of a provider that genuinely serves independent
//	               conversations at the same time (#421).
//	detached_tool  park the prompt forever while running a long tool child in
//	               its OWN session/process group (FAKE_TOOL_PID_FILE), i.e. a
//	               tool descendant that a provider process-group signal cannot
//	               reach (lane teardown ownership tests).
//	attached_tool  the same, but the tool child stays in the provider's process
//	               group (the ordinary cleanup shape).
//
// Session discovery/load (#409) is scripted through initialize plus
// session/list and session/load handlers; see FAKE_LIST_CAP, FAKE_LOAD_CAP,
// FAKE_LIST_RAW and FAKE_LIST_NO_CURSOR below.
//
// Markers/env: FAKE_EXIT_MARKER, FAKE_STATE_MARKER, FAKE_CANCEL_MARKER,
// FAKE_IMAGE_CAP ("1" advertises image support), FAKE_REPLY_TEXT,
// FAKE_POLICY_CAP ("1" advertises native modes/config options),
// FAKE_RESUME_CAP ("1" advertises sessionCapabilities.resume),
// FAKE_LIST_CAP ("1" advertises sessionCapabilities.list and answers
// session/list), FAKE_LOAD_CAP ("1" advertises loadSession and answers
// session/load), FAKE_LIST_RAW (exact raw session/list result payload),
// FAKE_LIST_NO_CURSOR ("1" omits nextCursor),
// FAKE_UNIQUE_SESSION_IDS ("1" makes session ids process-unique for tests).
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type frame struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type agent struct {
	mode             string
	promptCount      int
	pending          []byte // id of a held prompt waiting for cancellation
	pendingSessionID string
	nextSessionID    int
	configValues     map[string]map[string]string
	// held maps a native session id to the prompt id parked for it in
	// hold_all mode. Unlike `pending`, it holds MANY conversations at once,
	// which is what lets tests exercise real cross-session concurrency.
	held map[string][]byte
	// heldMu guards held: the stdin loop and the release pollers are
	// different goroutines.
	heldMu sync.Mutex
}

var tracePath string

func trace(dir string, line []byte) {
	if tracePath == "" {
		return
	}
	f, err := os.OpenFile(tracePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", dir, line)
}

func send(frame *frame) {
	data, _ := json.Marshal(frame)
	trace("OUT", data)
	fmt.Println(string(data))
}

func reply(id json.RawMessage, result any) {
	send(&frame{JSONRPC: "2.0", ID: id, Result: mustJSON(result)})
}

func notify(method string, params any) {
	send(&frame{JSONRPC: "2.0", Method: method, Params: mustJSON(params)})
}

func updateChunk(sessionID, text string) {
	notify("session/update", map[string]any{
		"sessionId": sessionID,
		"update": map[string]any{
			"sessionUpdate": "agent_message_chunk",
			"content":       map[string]any{"type": "text", "text": text},
		},
	})
}

func mustJSON(value any) json.RawMessage {
	data, _ := json.Marshal(value)
	return data
}

func (a *agent) killAfter(delay time.Duration, markerEnv string) {
	if markerEnv != "" && os.Getenv(markerEnv) != "" {
		_ = os.WriteFile(os.Getenv(markerEnv), []byte("done"), 0o600)
	}
	time.AfterFunc(delay, func() { os.Exit(0) })
}

func promptText(raw json.RawMessage) string {
	var doc struct {
		Prompt []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"prompt"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil || len(doc.Prompt) == 0 {
		return ""
	}
	text := ""
	for _, block := range doc.Prompt {
		if block.Text != "" {
			if text != "" {
				text += "\n"
			}
			text += block.Text
		}
	}
	return text
}

func main() {
	if os.Getenv("FAKE_MODE") == "exit_startup_kill" {
		// Dies before the handshake completes: EnsureSession must fail fast.
		time.Sleep(20 * time.Millisecond)
		os.Exit(1)
	}
	if os.Getenv("FAKE_MODE") == "tool_child" {
		// The long-running tool process started by detached_tool/attached_tool.
		// Only the lane's own teardown may end it.
		time.Sleep(10 * time.Minute)
		return
	}
	tracePath = os.Getenv("FAKE_TRACE")
	mode := os.Getenv("FAKE_MODE")
	for index := 0; index+1 < len(os.Args); index++ {
		if os.Args[index] == "--mode" {
			mode = os.Args[index+1]
			break
		}
	}
	a := &agent{mode: mode, held: make(map[string][]byte), configValues: make(map[string]map[string]string)}
	// A FIRST-life stuck process must also survive stdin EOF (the adapter
	// closes the pipe before escalating): only SIGKILL may end it, which is
	// exactly what the adapter's bounded escalation tests verify.
	stuckFirstLife := a.mode == "timeout_stuck" &&
		!fileExists(os.Getenv("FAKE_STATE_MARKER"))
	if a.mode == "timeout_stuck" {
		// Survive SIGTERM deliberately; the adapter's final boundary is
		// SIGKILL. Signals are consumed without terminating the process.
		sigCh := make(chan os.Signal, 8)
		signal.Notify(sigCh, syscall.SIGTERM)
		go func() {
			for range sigCh {
			}
		}()
		// Publish this life's pid once (first life only) so tests can prove
		// the SIGKILL escalation actually terminated it.
		if pidFile := os.Getenv("FAKE_PID_FILE"); pidFile != "" && !fileExists(pidFile) {
			_ = os.WriteFile(pidFile, []byte(strconv.Itoa(os.Getpid())), 0o600)
		}
	}

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 1024*1024), 32*1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		trace("IN ", line)
		var message frame
		if err := json.Unmarshal(line, &message); err != nil {
			continue
		}

		// Deterministic "accepted but never answered" request: the frame is
		// consumed and deliberately left without a reply so tests can prove
		// the adapter's bounded control-request timeout.
		if silent := os.Getenv("FAKE_SILENT_METHOD"); silent != "" && message.Method == silent {
			trace("SILENT ", line)
			continue
		}

		switch {
		case message.Method == "initialize":
			sessionCaps := map[string]any{"close": map[string]any{}}
			if os.Getenv("FAKE_RESUME_CAP") == "1" {
				sessionCaps["resume"] = map[string]any{}
			}
			if os.Getenv("FAKE_LIST_CAP") == "1" {
				sessionCaps["list"] = map[string]any{}
			}
			reply(message.ID, map[string]any{
				"protocolVersion": 1,
				"agentCapabilities": map[string]any{
					"loadSession": os.Getenv("FAKE_LOAD_CAP") == "1",
					"promptCapabilities": map[string]any{
						"image": os.Getenv("FAKE_IMAGE_CAP") == "1",
					},
					"sessionCapabilities": sessionCaps,
				},
			})

		case message.Method == "session/list":
			// FAKE_LIST_RAW scripts an exact wire payload so tests can prove
			// the adapter's defensive bounds (malformed/oversized/absent
			// fields) without a bespoke child per case.
			if raw := os.Getenv("FAKE_LIST_RAW"); raw != "" {
				reply(message.ID, json.RawMessage(raw))
				continue
			}
			var listParams struct {
				// Presence-aware on purpose: a bridge distinguishes "cwd was
				// not sent" from "cwd was sent empty", and pi-acp@0.0.33 gives
				// those two requests DIFFERENT answers.
				Cwd    *string `json:"cwd"`
				Cursor string  `json:"cursor"`
			}
			_ = json.Unmarshal(message.Params, &listParams)
			// FAKE_LIST_STORE models a REAL multi-project bridge store instead
			// of the two fixed descriptors: `sessionId|cwd|title` lines, with
			// pi-acp's exact resolution rule.
			if storePath := os.Getenv("FAKE_LIST_STORE"); storePath != "" {
				all := readFakeSessionStore(storePath)
				effective := os.Getenv("FAKE_LIST_CWD_FALLBACK")
				if effective == "" {
					effective = "/workspace"
				}
				if listParams.Cwd != nil {
					// An explicitly empty cwd is the ONLY spelling of "no
					// filter"; `??` does not fall through for "".
					effective = *listParams.Cwd
				}
				filtered := make([]any, 0, len(all))
				for _, entry := range all {
					if effective == "" || entry.Cwd == effective {
						filtered = append(filtered, map[string]any{
							"sessionId": entry.SessionID,
							"cwd":       entry.Cwd,
							"title":     entry.Title,
							"updatedAt": "2026-09-18T12:00:00Z",
						})
					}
				}
				result := map[string]any{"sessions": filtered}
				if os.Getenv("FAKE_LIST_NO_CURSOR") != "1" {
					result["nextCursor"] = "cursor-page-2"
				}
				reply(message.ID, result)
				continue
			}
			cwd := "/workspace"
			if listParams.Cwd != nil {
				cwd = *listParams.Cwd
			}
			// The first entry deliberately carries agent-private _meta: the
			// adapter must never retain or project it.
			sessions := []any{
				map[string]any{
					"sessionId": "native-session-1",
					"cwd":       cwd,
					"title":     "First native session",
					"updatedAt": "2026-09-18T10:00:00Z",
					"_meta":     map[string]any{"messageCount": 12, "hasErrors": false},
				},
				map[string]any{
					"sessionId": "native-session-2",
					"cwd":       cwd,
					"title":     "Second native session",
					"updatedAt": "2026-09-18T11:30:00Z",
				},
			}
			// FAKE_LIST_EXTRA_FILE lets a test mutate the PROVIDER's session
			// store WHILE this same process keeps running: every session/list
			// re-reads the file, so a second discovery must observe the change.
			// Each non-empty line is `sessionId|cwd|title`; an empty cwd uses
			// the request's own cwd. This is how "no restart, no cache" is
			// proven end-to-end against a live ACP child.
			if extraPath := os.Getenv("FAKE_LIST_EXTRA_FILE"); extraPath != "" {
				if raw, readErr := os.ReadFile(extraPath); readErr == nil {
					for _, line := range strings.Split(string(raw), "\n") {
						line = strings.TrimSpace(line)
						if line == "" {
							continue
						}
						parts := strings.SplitN(line, "|", 3)
						entryCwd := cwd
						if len(parts) > 1 && parts[1] != "" {
							entryCwd = parts[1]
						}
						title := ""
						if len(parts) > 2 {
							title = parts[2]
						}
						sessions = append(sessions, map[string]any{
							"sessionId": parts[0],
							"cwd":       entryCwd,
							"title":     title,
							"updatedAt": "2026-09-18T12:00:00Z",
						})
					}
				}
			}
			result := map[string]any{"sessions": sessions}
			if os.Getenv("FAKE_LIST_NO_CURSOR") != "1" {
				result["nextCursor"] = "cursor-page-2"
			}
			reply(message.ID, result)

		case message.Method == "session/load":
			if os.Getenv("FAKE_LOAD_CAP") != "1" {
				reply(message.ID, map[string]any{"error": "session/load was not advertised"})
				continue
			}
			reply(message.ID, map[string]any{})

		case message.Method == "session/new":
			a.nextSessionID++
			sessionID := "session-" + strconv.Itoa(a.nextSessionID)
			if os.Getenv("FAKE_UNIQUE_SESSION_IDS") == "1" {
				sessionID = fmt.Sprintf("session-%d-%d", os.Getpid(), a.nextSessionID)
			}
			a.configValues[sessionID] = map[string]string{"mode": "observe", "model": "gpt-a", "reasoning_effort": "medium"}
			response := map[string]any{"sessionId": sessionID}
			if os.Getenv("FAKE_POLICY_CAP") == "1" {
				response["modes"] = map[string]any{
					"currentModeId": "observe",
					"availableModes": []any{
						map[string]any{"id": "observe", "name": "Observe", "description": "read-only"},
						map[string]any{"id": "workspace", "name": "Workspace", "description": "workspace writes"},
					},
				}
				response["configOptions"] = fakeConfigOptions(a.configValues[sessionID])
			}
			reply(message.ID, response)

		case message.Method == "session/set_mode":
			if os.Getenv("FAKE_POLICY_CAP") != "1" {
				reply(message.ID, map[string]any{"error": "policy controls were not advertised"})
				continue
			}
			var params struct {
				SessionID string `json:"sessionId"`
				ModeID    string `json:"modeId"`
			}
			_ = json.Unmarshal(message.Params, &params)
			notify("session/update", map[string]any{
				"sessionId": params.SessionID,
				"update":    map[string]any{"sessionUpdate": "current_mode_update", "currentModeId": params.ModeID},
			})
			reply(message.ID, map[string]any{})

		case message.Method == "session/set_config_option":
			if os.Getenv("FAKE_POLICY_CAP") != "1" {
				reply(message.ID, map[string]any{"error": "policy controls were not advertised"})
				continue
			}
			var params struct {
				SessionID string `json:"sessionId"`
				ConfigID  string `json:"configId"`
				Value     string `json:"value"`
			}
			_ = json.Unmarshal(message.Params, &params)
			if a.configValues[params.SessionID] == nil {
				a.configValues[params.SessionID] = map[string]string{"mode": "observe", "model": "gpt-a", "reasoning_effort": "medium"}
			}
			a.configValues[params.SessionID][params.ConfigID] = params.Value
			configOptions := fakeConfigOptions(a.configValues[params.SessionID])
			notify("session/update", map[string]any{
				"sessionId": params.SessionID,
				"update":    map[string]any{"sessionUpdate": "config_option_update", "configOptions": configOptions},
			})
			reply(message.ID, map[string]any{"configOptions": configOptions})

		case message.Method == "session/close":
			reply(message.ID, map[string]any{})

		case message.Method == "session/cancel":
			var cancelParams struct {
				SessionID string `json:"sessionId"`
			}
			_ = json.Unmarshal(message.Params, &cancelParams)
			switch a.mode {
			case "hold_all":
				// Cancel reaches EXACTLY the conversation it names. A cancel
				// for a session with nothing parked is a no-op, which is how
				// tests prove one Task's interrupt cannot stop another's.
				a.heldMu.Lock()
				parked := a.held[cancelParams.SessionID]
				delete(a.held, cancelParams.SessionID)
				a.heldMu.Unlock()
				if parked != nil {
					updateChunk(cancelParams.SessionID, "cancelled:"+cancelParams.SessionID)
					reply(parked, map[string]any{"stopReason": "cancelled"})
				}
			case "cancel":
				if a.pending != nil {
					updateChunk(cancelParams.SessionID, "cancelled")
					reply(a.pending, map[string]any{"stopReason": "cancelled"})
					a.pending = nil
					a.pendingSessionID = ""
				}
			case "thought":
				// Emits internal reasoning that must NEVER surface in the
				// runtime's published reply, then the real message.
				notify("session/update", map[string]any{
					"sessionId": cancelParams.SessionID,
					"update": map[string]any{
						"sessionUpdate": "agent_thought_chunk",
						"content":       map[string]any{"type": "text", "text": "SECRET-THINKING-0123456789"},
					},
				})
				updateChunk(cancelParams.SessionID, "public-reply")
				reply(message.ID, map[string]any{"stopReason": "end_turn"})
			case "timeout_stuck":
				if marker := os.Getenv("FAKE_CANCEL_MARKER"); marker != "" && !fileExists(marker) {
					_ = os.WriteFile(marker, []byte("sent"), 0o600)
				}
			}

		case message.Method == "session/prompt":
			var promptParams struct {
				SessionID string `json:"sessionId"`
			}
			_ = json.Unmarshal(message.Params, &promptParams)
			promptSessionID := promptParams.SessionID
			prompt := promptText(message.Params)
			switch a.mode {
			case "hold_all":
				// Announce arrival on THIS conversation, then park. The
				// announcement is what proves two prompts were accepted
				// before either settled.
				updateChunk(promptSessionID, "started:"+promptSessionID)
				a.heldMu.Lock()
				a.held[promptSessionID] = append([]byte(nil), message.ID...)
				a.heldMu.Unlock()
				if os.Getenv("FAKE_PERMISSION_ALL") == "1" && contains(prompt, "permission-test") {
					// One approval request PER CONVERSATION, carrying its own
					// session id. A client that cannot isolate permissions
					// would answer the wrong conversation here.
					send(&frame{
						JSONRPC: "2.0",
						ID:      mustJSON("perm:" + promptSessionID),
						Method:  "session/request_permission",
						Params: mustJSON(map[string]any{
							"sessionId": promptSessionID,
							"toolCall": map[string]any{
								"toolCallId": "tool-" + promptSessionID,
								"title":      "unsafe operation",
								"kind":       "execute",
								"status":     "pending",
							},
							"options": []any{
								map[string]any{"optionId": "allow-once", "name": "Allow Once", "kind": "allow_once"},
								map[string]any{"optionId": "reject-once", "name": "Reject", "kind": "reject_once"},
							},
						}),
					})
					continue
				}
				go a.awaitRelease(promptSessionID)
				if chatter := os.Getenv("FAKE_CHATTER_MS"); chatter != "" {
					if ms, err := strconv.Atoi(chatter); err == nil && ms > 0 {
						go a.chatter(promptSessionID, time.Duration(ms)*time.Millisecond)
					}
				}
			case "env":
				// FAKE_ENV_NAME selects which environment variable the Harness
				// observes (defaults to the Runtime root contract). The value is
				// echoed as the reply, never leaked into logs.
				name := os.Getenv("FAKE_ENV_NAME")
				if name == "" {
					name = "FREE4CHAT_AGENT_DIR"
				}
				updateChunk(promptSessionID, os.Getenv(name))
				reply(message.ID, map[string]any{"stopReason": "end_turn"})
			case "context_read":
				runtimeBinary := os.Getenv("FREE4CHAT_AGENT_BIN")
				if runtimeBinary == "" {
					updateChunk(promptSessionID, "context-read-error: exact Runtime executable is unavailable")
					reply(message.ID, map[string]any{"stopReason": "end_turn"})
					continue
				}
				output, err := exec.Command(runtimeBinary, "context", "read", "--before-sequence", "2", "--limit", "10").CombinedOutput()
				if err != nil {
					updateChunk(promptSessionID, "context-read-error: "+string(output))
				} else {
					updateChunk(promptSessionID, string(output))
				}
				reply(message.ID, map[string]any{"stopReason": "end_turn"})
			case "permission":
				if len(prompt) > 0 && contains(prompt, "permission-test") {
					// Agent -> client requests carry an explicit id so the
					// runtime can answer them fail-closed.
					send(&frame{
						JSONRPC: "2.0",
						ID:      json.RawMessage("77"),
						Method:  "session/request_permission",
						Params: mustJSON(map[string]any{
							"sessionId": promptSessionID,
							"toolCall": map[string]any{
								"toolCallId": "tool-1",
								"title":      "unsafe operation",
								"kind":       "execute",
								"status":     "pending",
							},
							"options": []any{},
						}),
					})
					// Wait for the runtime's auto-cancelled response; the
					// response handler below drives completion. Stash the id.
					a.pending = append([]byte(nil), message.ID...)
					a.pendingSessionID = promptSessionID
					continue
				}
				a.finishNormal(&message, promptSessionID)
			case "permission_wait":
				if len(prompt) > 0 && contains(prompt, "permission-test") {
					send(&frame{
						JSONRPC: "2.0",
						ID:      json.RawMessage("78"),
						Method:  "session/request_permission",
						Params: mustJSON(map[string]any{
							"sessionId": promptSessionID,
							"toolCall": map[string]any{
								"toolCallId": "tool-delayed",
								"title":      "delayed harmless operation",
								"kind":       "execute",
								"status":     "pending",
								"rawInput": map[string]any{
									"command": "touch temporary-marker",
									"cwd":     "/workspace",
									"env":     map[string]any{"PRIVATE_TOKEN": "secret-token"},
									"headers": map[string]any{"Authorization": "Bearer secret-token"},
								},
							},
							"_meta": map[string]any{
								"permission": map[string]any{
									"description": "Create a temporary marker file",
								},
							},
							"options": []any{
								map[string]any{"optionId": "allow-once", "name": "Allow Once", "kind": "allow_once"},
								map[string]any{"optionId": "reject-once", "name": "Reject", "kind": "reject_once"},
							},
						}),
					})
					a.pending = append([]byte(nil), message.ID...)
					a.pendingSessionID = promptSessionID
					continue
				}
				a.finishNormal(&message, promptSessionID)
			case "cancel":
				if len(prompt) > 0 && contains(prompt, "cancel-test") {
					a.pending = append([]byte(nil), message.ID...)
					a.pendingSessionID = promptSessionID
					continue
				}
				a.finishNormal(&message, promptSessionID)
			case "detached_tool", "attached_tool":
				// Models a provider running a long tool call. The tool child is
				// a real child of THIS provider; in detached_tool mode it
				// deliberately moves into its own session/process group, which
				// is the shape a process-group-only teardown cannot reach.
				// The prompt is never answered, so the turn stays active until
				// the adapter tears the lane down. The park must be a timer (or
				// any blocking primitive the runtime can observe): a bare
				// select{} with no other runnable goroutine makes a Go program
				// abort itself, which would end this provider before the test's
				// control ever runs.
				startToolChild(a.mode == "detached_tool")
				time.Sleep(10 * time.Minute)
			case "exit":
				a.finishNormal(&message, promptSessionID)
				a.killAfter(10*time.Millisecond, "FAKE_EXIT_MARKER")
			case "restart":
				marker := os.Getenv("FAKE_RESTART_MARKER")
				restarted := false
				if marker != "" {
					restarted = fileExists(marker)
				}
				text := "reply-2"
				if !restarted {
					text = "reply-1"
				}
				updateChunk(promptSessionID, text)
				reply(message.ID, map[string]any{"stopReason": "end_turn"})
				if !restarted {
					a.killAfter(10*time.Millisecond, "FAKE_RESTART_MARKER")
				}
			case "envelope":
				a.promptCount++
				text := os.Getenv("FAKE_REPLY_TEXT")
				if text == "" {
					text = fmt.Sprintf("reply-%d", a.promptCount)
				}
				updateChunk(promptSessionID, text)
				reply(message.ID, map[string]any{"stopReason": "end_turn"})
			case "session_echo":
				// Echoes the exact session id the prompt was addressed to, so
				// a test can prove which conversation a turn really used.
				a.promptCount++
				updateChunk(promptSessionID, fmt.Sprintf("reply-%d session=%s", a.promptCount, promptSessionID))
				reply(message.ID, map[string]any{"stopReason": "end_turn"})
			case "thought":
				// Emits internal reasoning that must NEVER surface in the
				// runtime's published reply, then the real message.
				notify("session/update", map[string]any{
					"sessionId": promptSessionID,
					"update": map[string]any{
						"sessionUpdate": "agent_thought_chunk",
						"content":       map[string]any{"type": "text", "text": "SECRET-THINKING-0123456789"},
					},
				})
				updateChunk(promptSessionID, "public-reply")
				reply(message.ID, map[string]any{"stopReason": "end_turn"})
			case "timeout_stuck":
				stateMarker := os.Getenv("FAKE_STATE_MARKER")
				wasStuck := false
				if stateMarker != "" {
					wasStuck = fileExists(stateMarker)
				}
				if wasStuck {
					updateChunk(promptSessionID, "recovered")
					reply(message.ID, map[string]any{"stopReason": "end_turn"})
					continue
				}
				// First life: record the stuck state and park the prompt.
				// The read loop continues so session/cancel still lands
				// (writing the cancel marker); the reply is never sent.
				if stateMarker != "" {
					_ = os.WriteFile(stateMarker, []byte("started"), 0o600)
				}
				continue
			default:
				a.finishNormal(&message, promptSessionID)
			}

		case len(message.ID) > 0 && message.Result != nil:
			// Runtime answered our outbound request (e.g. the auto-cancelled
			// permission call). Continue the parked turn accordingly.
			if a.mode == "hold_all" && strings.HasPrefix(string(message.ID), "\"perm:") {
				// The approval reply is routed back to the EXACT conversation
				// its id names, and settles only that conversation.
				sessionID := strings.Trim(strings.TrimPrefix(string(message.ID), "\"perm:"), "\"")
				var permissionResult struct {
					Outcome struct {
						Outcome  string `json:"outcome"`
						OptionID string `json:"optionId"`
					} `json:"outcome"`
				}
				_ = json.Unmarshal(message.Result, &permissionResult)
				approved := permissionResult.Outcome.Outcome == "selected" && permissionResult.Outcome.OptionID == "allow-once"
				a.heldMu.Lock()
				parked := a.held[sessionID]
				delete(a.held, sessionID)
				a.heldMu.Unlock()
				if parked != nil {
					if approved {
						updateChunk(sessionID, "approved:"+sessionID)
					} else {
						updateChunk(sessionID, "denied:"+sessionID)
					}
					reply(parked, map[string]any{"stopReason": "end_turn"})
				}
			}
			if (a.mode == "permission" || a.mode == "permission_wait") && a.pending != nil {
				var permissionResult struct {
					Outcome struct {
						Outcome  string `json:"outcome"`
						OptionID string `json:"optionId"`
					} `json:"outcome"`
				}
				_ = json.Unmarshal(message.Result, &permissionResult)
				if a.mode == "permission_wait" && permissionResult.Outcome.Outcome == "selected" && permissionResult.Outcome.OptionID == "allow-once" {
					updateChunk(a.pendingSessionID, "permission-approved")
					reply(a.pending, map[string]any{"stopReason": "end_turn"})
				} else {
					updateChunk(a.pendingSessionID, "permission-cancelled")
					reply(a.pending, map[string]any{"stopReason": "cancelled"})
				}
				a.pending = nil
				a.pendingSessionID = ""
			}

		default:
			// Unknown/unsupported frames are ignored by the stub.
		}
	}
	if stuckFirstLife {
		// Survive EOF (pipe closed by the adapter) and every signal except
		// SIGKILL: this models a Harness that ignores TERM during teardown.
		select {}
	}
}

func fakeConfigOptions(current map[string]string) []any {
	return []any{
		map[string]any{
			"id": "mode", "name": "Mode", "category": "mode", "type": "select",
			"currentValue": current["mode"],
			"options":      []any{map[string]any{"value": "observe", "name": "Observe"}, map[string]any{"value": "workspace", "name": "Workspace"}},
		},
		map[string]any{
			"id": "model", "name": "Model", "category": "model", "type": "select",
			"currentValue": current["model"],
			"options":      []any{map[string]any{"value": "gpt-a", "name": "A"}, map[string]any{"value": "gpt-b", "name": "B"}},
		},
		map[string]any{
			"id": "reasoning_effort", "name": "Reasoning effort", "category": "thought_level", "type": "select",
			"currentValue": current["reasoning_effort"],
			"options":      []any{map[string]any{"value": "low"}, map[string]any{"value": "medium"}, map[string]any{"value": "high"}},
		},
	}
}

func (a *agent) finishNormal(message *frame, sessionID string) {
	a.promptCount++
	updateChunk(sessionID, fmt.Sprintf("reply-%d", a.promptCount))
	reply(message.ID, map[string]any{"stopReason": "end_turn"})
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0
}

// startToolChild starts one long-running tool process as a child of this
// provider. detached=true gives it its own session (and therefore its own
// process group), so signalling the provider's group cannot reach it. The pid
// is published to FAKE_TOOL_PID_FILE so a test can observe the exact process
// it owns, never inferring cleanup from the provider's own exit.
func startToolChild(detached bool) {
	child := exec.Command(os.Args[0])
	child.Env = append(os.Environ(), "FAKE_MODE=tool_child")
	if detached {
		child.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	}
	if err := child.Start(); err != nil {
		return
	}
	if pidFile := os.Getenv("FAKE_TOOL_PID_FILE"); pidFile != "" {
		_ = os.WriteFile(pidFile, []byte(strconv.Itoa(child.Process.Pid)), 0o600)
	}
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// fakeSessionEntry is one line of a FAKE_LIST_STORE file.
type fakeSessionEntry struct {
	SessionID string
	Cwd       string
	Title     string
}

// readFakeSessionStore loads the whole modeled bridge session store.
func readFakeSessionStore(path string) []fakeSessionEntry {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	out := make([]fakeSessionEntry, 0, 16)
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 3)
		entry := fakeSessionEntry{SessionID: parts[0]}
		if len(parts) > 1 {
			entry.Cwd = parts[1]
		}
		if len(parts) > 2 {
			entry.Title = parts[2]
		}
		out = append(out, entry)
	}
	return out
}

// awaitRelease replies to one parked prompt once the test releases it, either
// by creating FAKE_RELEASE_DIR/<sessionId> or by cancelling that session. It
// polls a file rather than reading a clock so the test stays fully
// deterministic and never sleeps for a modeled duration.
func (a *agent) awaitRelease(sessionID string) {
	dir := os.Getenv("FAKE_RELEASE_DIR")
	if dir == "" {
		return
	}
	path := dir + string(os.PathSeparator) + sessionID
	for attempt := 0; attempt < 3000; attempt++ {
		time.Sleep(10 * time.Millisecond)
		a.heldMu.Lock()
		parked := a.held[sessionID]
		a.heldMu.Unlock()
		if parked == nil {
			// Cancelled, or already released.
			return
		}
		if !fileExists(path) {
			continue
		}
		a.heldMu.Lock()
		parked = a.held[sessionID]
		delete(a.held, sessionID)
		a.heldMu.Unlock()
		if parked == nil {
			return
		}
		updateChunk(sessionID, "released:"+sessionID)
		reply(parked, map[string]any{"stopReason": "end_turn"})
		return
	}
}

// chatter emits periodic provider notifications for one parked conversation
// until it settles. It is how a test proves the OPT-IN idle watchdog is
// re-armed by real provider activity instead of expiring a live turn.
func (a *agent) chatter(sessionID string, every time.Duration) {
	for {
		time.Sleep(every)
		a.heldMu.Lock()
		parked := a.held[sessionID]
		a.heldMu.Unlock()
		if parked == nil {
			return
		}
		notify("session/update", map[string]any{
			"sessionId": sessionID,
			"update": map[string]any{
				"sessionUpdate": "agent_thought_chunk",
				"content":       map[string]any{"type": "text", "text": "."},
			},
		})
	}
}
