package harness

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Bounded ACP session discovery / load primitives (#409).
 *
 * These are ACP adapter capabilities, nothing more. They let this adapter say
 * truthfully "this Harness can list sessions" and "this Harness can load
 * session X" — they do NOT make an existing native CLI session usable by
 * Free4Chat, and nothing above the adapter (Runtime, daemon, CLI, Room) calls
 * them yet. The #409 invariant stands unchanged:
 *
 *	advertised ACP capability != native CLI session usable
 *
 * Every descriptor below is bounded adapter-local data: no prompt text, no
 * history/transcript, no credentials, no raw `_meta`, no provider secrets. A
 * result is returned to the caller only — never persisted, never projected
 * into status/Room/analytics, and never logged with session ids.
 *
 * Opaque values (session id, pagination cursor) and path values (cwd) are
 * identity, so they are preserved byte-for-byte in both directions and are
 * never normalized. A value the local policy cannot accept is rejected
 * outright; it is never silently repaired and then used.
 */

// Bounds for one session/list exchange. A Harness is untrusted input at this
// boundary: it can be buggy, hostile, or simply pointed at a native store with
// tens of thousands of sessions, so a result is bounded before it can reach a
// caller. The caps are deliberately small — this feeds a human picker, not a
// session archive.
const (
	// maxACPSessionPageSize caps one page. An oversized page fails closed
	// instead of being silently truncated, so a caller can never mistake an
	// incomplete page for the whole store.
	maxACPSessionPageSize = 50
	// maxACPSessionIDLength bounds the opaque ACP session identity.
	maxACPSessionIDLength = 256
	// maxACPSessionCwdLength bounds the reported working directory.
	maxACPSessionCwdLength = 4096
	// maxACPSessionTitleLength bounds the display-only title.
	maxACPSessionTitleLength = 512
	// maxACPSessionCursorLength bounds the opaque pagination cursor.
	maxACPSessionCursorLength = 1024
	// maxACPSessionUpdatedAtLength bounds the ISO-8601 timestamp field.
	maxACPSessionUpdatedAtLength = 64
)

// ACPSessionInfo is the bounded, adapter-local descriptor of one Harness
// session discovered through session/list. SessionID remains a local ACP
// opaque identity: it is not a Free4Chat participant handle, capability, or
// Room identity, and it must not be persisted or surfaced by this package.
//
// The shape is intentionally fixed: there is no transcript, history,
// credential, or raw `_meta` field, so a Harness cannot push extra content
// through this seam.
type ACPSessionInfo struct {
	SessionID string
	Cwd       string
	Title     string
	UpdatedAt string
}

// ACPSessionPage is one bounded page of session/list results. NextCursor is
// the Harness's opaque pagination token, passed back verbatim by the caller;
// an empty cursor means the Harness reported no further results.
type ACPSessionPage struct {
	Sessions   []ACPSessionInfo
	NextCursor string
}

// ACPSessionListOptions carries one session/list request. It exists so that
// "no cwd filter" and "this exact cwd" are two DIFFERENT values rather than
// two meanings of "".
//
//	Cwd == nil  -> omit `cwd` from the ACP frame entirely: global discovery
//	               across every project the Harness knows about.
//	Cwd != nil  -> send *Cwd byte-for-byte, including an explicitly empty
//	               string. The value is never trimmed or normalized, because
//	               cwd is identity: a repaired path could select the wrong
//	               project's sessions.
//
// The earlier signature encoded both meanings as "", which silently turned
// global discovery into "the adapter's own workspace" and made an invoking
// shell's cd an invisible filter. Callers that genuinely want the adapter's
// workspace must now say so explicitly.
type ACPSessionListOptions struct {
	Cwd    *string
	Cursor string
}

// acpSessionInfoWire is the raw ACP v1 SessionInfo shape. `_meta` and
// `additionalDirectories` are deliberately not decoded: this adapter retains
// no Harness-private metadata through session discovery.
type acpSessionInfoWire struct {
	SessionID string `json:"sessionId"`
	Cwd       string `json:"cwd"`
	Title     string `json:"title"`
	UpdatedAt string `json:"updatedAt"`
}

// ListSessions issues one bounded ACP `session/list` control request for the
// given options. See ACPSessionListOptions for the exact nil-vs-set cwd
// semantics: a nil cwd asks for GLOBAL discovery and a non-nil cwd is sent
// byte-for-byte. How "global" is spelled on the wire is the launcher's
// declared bridge behavior (`LauncherSessionListGlobalCwd`); by default the
// field is omitted, which is what ACP means by an unfiltered request. An
// exactly empty cursor means "first page" and is likewise omitted.
//
// cwd and cursor are identity-bearing values, so they are never trimmed: a
// caller-supplied value that is not exactly empty reaches the wire unchanged.
//
// The call is gated on the Harness having advertised
// `sessionCapabilities.list`: an unsupported method must never reach the wire.
// It reuses the adapter's ControlTimeoutMs lifecycle like every other
// non-turn control request, so a Harness that stays alive but never answers
// cannot block the caller and is torn down rather than left ambiguous.
//
// The returned page is bounded and validated; see parseACPSessionPage.
func (a *ACPAdapter) ListSessions(options ACPSessionListOptions) (ACPSessionPage, error) {
	cursor := options.Cursor
	if options.Cwd != nil && !validACPSessionPath(*options.Cwd, maxACPSessionCwdLength) {
		return ACPSessionPage{}, errors.New("ACP session/list working directory is invalid")
	}
	if len([]rune(cursor)) > maxACPSessionCursorLength || hasACPControlRunes(cursor) {
		return ACPSessionPage{}, errors.New("ACP session/list cursor is invalid")
	}

	// Session discovery is also the next user interaction after an idle reap.
	// Hold the idle reaper while we re-materialize and query the provider, then
	// let EnsureSession load the retained Room conversation rather than replace
	// it with a new one.
	a.mu.Lock()
	a.idleReapHolds++
	a.cancelIdleReapLocked()
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.idleReapHolds--
		a.scheduleIdleReapLocked()
		a.mu.Unlock()
	}()
	if err := a.EnsureSession(); err != nil {
		return ACPSessionPage{}, err
	}

	a.mu.Lock()
	connected := a.stdin != nil && a.caps != nil
	advertised := connected && a.caps.ListPresent
	a.mu.Unlock()
	if !connected {
		return ACPSessionPage{}, errors.New("ACP connection is unavailable")
	}
	if !advertised {
		// Checked before any frame is written: the adapter reports the
		// missing capability locally instead of probing the Harness.
		return ACPSessionPage{}, errors.New("ACP agent does not advertise sessionCapabilities.list")
	}

	params := map[string]any{}
	switch {
	case options.Cwd != nil:
		params["cwd"] = *options.Cwd
	case a.launcher.SessionListGlobalCwd == types.GlobalSessionListCwdEmpty:
		// This bridge reads an ABSENT cwd as "my own last session cwd", so
		// the only spelling of "no filter" it understands is an explicitly
		// empty value. See LauncherSessionListGlobalCwd.
		params["cwd"] = ""
	default:
		// ACP-correct: an unfiltered request omits the field entirely.
	}
	if cursor != "" {
		params["cursor"] = cursor
	}
	response, err := a.request("session/list", mustJSON(params))
	if err != nil {
		return ACPSessionPage{}, err
	}
	return parseACPSessionPage(response.Result)
}

// parseACPSessionPage projects one session/list result. Anything
// identity-bearing must be well-formed or the whole page fails closed: a
// caller that silently received a repaired session id could load the wrong
// conversation, and a repaired cursor could silently skip or repeat results.
// Only the display-only title is normalized and bounded rather than rejected,
// because it is not identity.
func parseACPSessionPage(raw json.RawMessage) (ACPSessionPage, error) {
	if len(raw) == 0 {
		return ACPSessionPage{}, errors.New("ACP session/list returned no result")
	}
	var wire struct {
		Sessions   []acpSessionInfoWire `json:"sessions"`
		NextCursor string               `json:"nextCursor"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return ACPSessionPage{}, errors.New("ACP session/list returned a malformed result")
	}
	if wire.Sessions == nil {
		return ACPSessionPage{}, errors.New("ACP session/list result is missing the sessions array")
	}
	if len(wire.Sessions) > maxACPSessionPageSize {
		return ACPSessionPage{}, fmt.Errorf(
			"ACP session/list returned %d sessions, exceeding the %d-session bound",
			len(wire.Sessions), maxACPSessionPageSize,
		)
	}

	page := ACPSessionPage{Sessions: make([]ACPSessionInfo, 0, len(wire.Sessions))}
	for _, entry := range wire.Sessions {
		info, err := projectACPSessionInfo(entry)
		if err != nil {
			return ACPSessionPage{}, err
		}
		page.Sessions = append(page.Sessions, info)
	}
	// The cursor is an opaque token: it is stored and handed back to the
	// caller exactly as the Harness sent it.
	if len([]rune(wire.NextCursor)) > maxACPSessionCursorLength || hasACPControlRunes(wire.NextCursor) {
		return ACPSessionPage{}, errors.New("ACP session/list returned an invalid pagination cursor")
	}
	page.NextCursor = wire.NextCursor
	return page, nil
}

func projectACPSessionInfo(wire acpSessionInfoWire) (ACPSessionInfo, error) {
	// sessionId and cwd are identity-bearing and are never trimmed: a value
	// that survives validation is projected byte-for-byte, and a value that
	// does not is rejected here rather than quietly repaired.
	if wire.SessionID == "" {
		return ACPSessionInfo{}, errors.New("ACP session/list returned a session without an id")
	}
	if len([]rune(wire.SessionID)) > maxACPSessionIDLength || hasACPControlRunes(wire.SessionID) {
		return ACPSessionInfo{}, errors.New("ACP session/list returned an invalid session id")
	}
	if !validACPSessionPath(wire.Cwd, maxACPSessionCwdLength) {
		return ACPSessionInfo{}, errors.New("ACP session/list returned an invalid session working directory")
	}
	updatedAt := wire.UpdatedAt
	if updatedAt != "" {
		if len([]rune(updatedAt)) > maxACPSessionUpdatedAtLength {
			return ACPSessionInfo{}, errors.New("ACP session/list returned an invalid updatedAt timestamp")
		}
		if _, err := time.Parse(time.RFC3339, updatedAt); err != nil {
			return ACPSessionInfo{}, errors.New("ACP session/list returned an invalid updatedAt timestamp")
		}
	}
	return ACPSessionInfo{
		SessionID: wire.SessionID,
		Cwd:       wire.Cwd,
		Title:     sanitizeACPDisplayText(wire.Title, maxACPSessionTitleLength),
		UpdatedAt: updatedAt,
	}, nil
}

// LoadSession replaces the ACP conversation retained for one logical scope
// with an existing Harness session id (`session/load`). It is the only seam
// in this package that changes session identity after session/new: on success
// the scope points at the loaded session, its session generation advances, and
// subsequent RunTurn/RunTurnFor calls for that scope use the loaded session.
//
// An exactly empty cwd means the adapter's own workspace directory. An empty
// session id, an empty or over-long scope, or an id already retained by a
// different logical scope is rejected locally — one native session backs at
// most one scope, because scopeForSessionIDLocked maps an ACP session id back
// to exactly one scope for activity/permission projection. sessionID and cwd
// are identity-bearing and are never trimmed: an accepted value is sent to the
// Harness exactly as given.
//
// The capability gate is `loadSession:true` from initialize. Like every other
// non-turn control request this is bounded by ControlTimeoutMs. A failed or
// timed-out load never changes the retained identity: the previous session is
// kept only if the child is still known-good, and a timeout tears the child
// down exactly like any other ambiguous control request.
//
// This does not adopt a session into Free4Chat: no Runtime/daemon/CLI/Room
// path calls it, and an advertised capability is not proof that a native CLI
// session is discoverable, loadable, or continuable.
func (a *ACPAdapter) LoadSession(scope string, sessionID string, cwd string) error {
	scope = strings.TrimSpace(scope)
	if scope == "" {
		return errors.New("ACP logical scope is empty")
	}
	if scope != "room" && len(scope) > types.MaxLogicalScopeLength {
		return errors.New("ACP logical scope is too long")
	}
	// sessionID and cwd are identity-bearing: never trimmed, only validated.
	if sessionID == "" {
		return errors.New("ACP session id is empty")
	}
	if len([]rune(sessionID)) > maxACPSessionIDLength || hasACPControlRunes(sessionID) {
		return errors.New("ACP session id is invalid")
	}
	if cwd == "" {
		cwd = a.workingDir
	}
	if !validACPSessionPath(cwd, maxACPSessionCwdLength) {
		return errors.New("ACP session/load working directory is invalid")
	}
	if scope != "room" {
		// Serialize with EnsureSessionFor, the other scoped-session creator,
		// so the bounded scope capacity and the per-scope mapping cannot be
		// raced by a concurrent scoped session/new.
		a.scopedSessionMu.Lock()
		defer a.scopedSessionMu.Unlock()
	}
	return a.loadSession(scope, sessionID, cwd)
}

// loadSession is the shared implementation for the public load primitive and
// EnsureSessionFor's retained-session path. Callers that load a task scope
// must already hold scopedSessionMu; keeping this helper separate avoids a
// non-reentrant mutex deadlock while preserving serialization of scoped
// session creation and replacement.
func (a *ACPAdapter) loadSession(scope string, sessionID string, cwd string) error {
	a.mu.Lock()
	if a.stdin == nil || a.caps == nil {
		a.mu.Unlock()
		return errors.New("ACP connection is unavailable")
	}
	if !a.caps.LoadSessionPresent {
		a.mu.Unlock()
		return errors.New("ACP agent does not advertise loadSession")
	}
	if a.activeTurns[sessionID] != nil {
		// Replacing a conversation that is executing a turn would rebind that
		// running prompt to a different session. Fence on THIS session only,
		// so adopting another Task's session can proceed while a different
		// conversation keeps running (#421).
		a.mu.Unlock()
		return errors.New("ACP prompt is already running for this session")
	}
	if scope != "room" {
		if _, ok := a.sessions[scope]; !ok && len(a.sessions) >= types.MaxLogicalTaskScopes {
			a.mu.Unlock()
			return errors.New("ACP logical scope capacity reached")
		}
	}
	for otherScope, session := range a.sessions {
		if session != nil && otherScope != scope && session.sessionID == sessionID {
			a.mu.Unlock()
			return errors.New("ACP session is already retained by another logical scope")
		}
	}
	if scope != "room" && a.sessionID == sessionID {
		a.mu.Unlock()
		return errors.New("ACP session is already retained by another logical scope")
	}
	a.mu.Unlock()

	params, _ := json.Marshal(map[string]any{
		"sessionId": sessionID,
		"cwd":       cwd,
		// Same shape as session/new: Free4Chat installs no MCP servers into
		// the Harness, so a loaded session never inherits or gains tool
		// access through this seam.
		"mcpServers": []any{},
	})
	response, err := a.request("session/load", params)
	if err != nil {
		return err
	}
	// A load result may carry the loaded session's own mode/config metadata.
	// Controls belong to the conversation, never to the process: whatever the
	// Harness re-advertises here replaces the previous session's controls, and
	// an absent document clears them rather than leaving another
	// conversation's modes or config options in place.
	controls := parseSessionControls(response.Result)

	a.mu.Lock()
	defer a.mu.Unlock()
	if a.stdin == nil || a.proc == nil || a.caps == nil {
		return errors.New("ACP process exited while loading session")
	}
	if a.activeTurns[sessionID] != nil {
		// A turn started on THIS session while the load was in flight. Its
		// prompt is bound to the previous session identity, so the
		// replacement fails closed rather than silently rebinding a running
		// turn to another session.
		return errors.New("ACP prompt started while loading session")
	}
	if scope == "room" {
		a.sessionID = sessionID
		a.sessionGeneration++
		a.caps.SessionControls = controls
		return nil
	}
	replacement := cloneACPCapabilities(a.caps)
	replacement.SessionControls = controls
	a.nextScopeGeneration++
	a.sessions[scope] = &acpSession{
		sessionID:  sessionID,
		cwd:        cwd,
		caps:       replacement,
		generation: a.nextScopeGeneration,
		scope:      scope,
	}
	return nil
}

// validACPSessionPath bounds a path-shaped adapter input without altering it.
// An exactly empty value is valid: callers use it to omit an optional wire
// field. The value is never trimmed — whitespace inside a path is data.
// Absolute-path enforcement is deliberately left to the Harness; the adapter
// must not reject a workspace the Runtime already launched it with.
func validACPSessionPath(value string, limit int) bool {
	return len([]rune(value)) <= limit && !hasACPControlRunes(value)
}

func hasACPControlRunes(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// sanitizeACPDisplayText bounds display-only Harness text and folds control
// characters (including newlines) so a descriptor can never carry multi-line
// or terminal-shaped content into a caller's rendering. This is the ONE place
// normalization is allowed: a title is presentation, not identity.
func sanitizeACPDisplayText(value string, limit int) string {
	cleaned := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, value)
	return boundedRunes(strings.TrimSpace(cleaned), limit)
}

func boundedRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}
