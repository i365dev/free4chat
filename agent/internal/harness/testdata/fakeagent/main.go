// Command fakeagent is a scripted ACP v1 Harness used only by the Go Agent
// Runtime tests (built on demand by TestMain; never shipped or imported).
//
// Modes are selected through FAKE_MODE:
//
//	normal         reply incrementally to every prompt
//	env            reply with the Harness-visible FREE4CHAT_AGENT_DIR
//	context_read   invoke the local CLI's bounded Room context read
//	permission     answer a targeted turn after an auto-cancelled permission ask
//	cancel         hold the requested turn until session/cancel arrives
//	exit           die shortly after the first prompt completes
//	restart        die after the first prompt; fresh process answers differently
//	timeout_stuck  ignore the first prompt forever (survives SIGTERM); next process recovers
//	envelope       reply with the exact FAKE_REPLY_TEXT payload (#165 addressing tests)
//
// Markers/env: FAKE_EXIT_MARKER, FAKE_STATE_MARKER, FAKE_CANCEL_MARKER,
// FAKE_IMAGE_CAP ("1" advertises image support), FAKE_REPLY_TEXT.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
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
	mode        string
	promptCount int
	pending     []byte // id of a held prompt waiting for cancellation
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
	tracePath = os.Getenv("FAKE_TRACE")
	mode := os.Getenv("FAKE_MODE")
	for index := 0; index+1 < len(os.Args); index++ {
		if os.Args[index] == "--mode" {
			mode = os.Args[index+1]
			break
		}
	}
	a := &agent{mode: mode}
	sessionID := ""
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

		switch {
		case message.Method == "initialize":
			sessionCaps := map[string]any{"close": map[string]any{}}
			if os.Getenv("FAKE_RESUME_CAP") == "1" {
				sessionCaps["resume"] = map[string]any{}
			}
			reply(message.ID, map[string]any{
				"protocolVersion": 1,
				"agentCapabilities": map[string]any{
					"promptCapabilities": map[string]any{
						"image": os.Getenv("FAKE_IMAGE_CAP") == "1",
					},
					"sessionCapabilities": sessionCaps,
				},
			})

		case message.Method == "session/new":
			sessionID = "session-" + strconv.Itoa(1)
			reply(message.ID, map[string]any{"sessionId": sessionID})

		case message.Method == "session/close":
			reply(message.ID, map[string]any{})

		case message.Method == "session/cancel":
			switch a.mode {
			case "cancel":
				if a.pending != nil {
					updateChunk(sessionID, "cancelled")
					reply(a.pending, map[string]any{"stopReason": "cancelled"})
					a.pending = nil
				}
			case "thought":
				// Emits internal reasoning that must NEVER surface in the
				// runtime's published reply, then the real message.
				notify("session/update", map[string]any{
					"sessionId": sessionID,
					"update": map[string]any{
						"sessionUpdate": "agent_thought_chunk",
						"content":       map[string]any{"type": "text", "text": "SECRET-THINKING-0123456789"},
					},
				})
				updateChunk(sessionID, "public-reply")
				reply(message.ID, map[string]any{"stopReason": "end_turn"})
			case "timeout_stuck":
				if marker := os.Getenv("FAKE_CANCEL_MARKER"); marker != "" && !fileExists(marker) {
					_ = os.WriteFile(marker, []byte("sent"), 0o600)
				}
			}

		case message.Method == "session/prompt":
			prompt := promptText(message.Params)
			switch a.mode {
			case "env":
				updateChunk(sessionID, os.Getenv("FREE4CHAT_AGENT_DIR"))
				reply(message.ID, map[string]any{"stopReason": "end_turn"})
			case "context_read":
				output, err := exec.Command("free4chat-agent", "context", "read", "--before-sequence", "2", "--limit", "10").CombinedOutput()
				if err != nil {
					updateChunk(sessionID, "context-read-error: "+string(output))
				} else {
					updateChunk(sessionID, string(output))
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
							"sessionId": sessionID,
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
					continue
				}
				a.finishNormal(&message, sessionID)
			case "cancel":
				if len(prompt) > 0 && contains(prompt, "cancel-test") {
					a.pending = append([]byte(nil), message.ID...)
					continue
				}
				a.finishNormal(&message, sessionID)
			case "exit":
				a.finishNormal(&message, sessionID)
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
				updateChunk(sessionID, text)
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
				updateChunk(sessionID, text)
				reply(message.ID, map[string]any{"stopReason": "end_turn"})
			case "thought":
				// Emits internal reasoning that must NEVER surface in the
				// runtime's published reply, then the real message.
				notify("session/update", map[string]any{
					"sessionId": sessionID,
					"update": map[string]any{
						"sessionUpdate": "agent_thought_chunk",
						"content":       map[string]any{"type": "text", "text": "SECRET-THINKING-0123456789"},
					},
				})
				updateChunk(sessionID, "public-reply")
				reply(message.ID, map[string]any{"stopReason": "end_turn"})
			case "timeout_stuck":
				stateMarker := os.Getenv("FAKE_STATE_MARKER")
				wasStuck := false
				if stateMarker != "" {
					wasStuck = fileExists(stateMarker)
				}
				if wasStuck {
					updateChunk(sessionID, "recovered")
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
				a.finishNormal(&message, sessionID)
			}

		case len(message.ID) > 0 && message.Result != nil:
			// Runtime answered our outbound request (e.g. the auto-cancelled
			// permission call). Continue the parked turn accordingly.
			if a.mode == "permission" && a.pending != nil {
				updateChunk(sessionID, "permission-cancelled")
				reply(a.pending, map[string]any{"stopReason": "cancelled"})
				a.pending = nil
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

func (a *agent) finishNormal(message *frame, sessionID string) {
	a.promptCount++
	updateChunk(sessionID, fmt.Sprintf("reply-%d", a.promptCount))
	reply(message.ID, map[string]any{"stopReason": "end_turn"})
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0
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
