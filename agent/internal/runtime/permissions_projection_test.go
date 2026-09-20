package runtime

import (
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/i365dev/free4chat/agent/internal/harness"
	"github.com/i365dev/free4chat/agent/internal/types"
)

// #429 — native approval IDENTITY and Room approval PRESENTATION are separate.
//
// A real codex-acp 1.12.0 command approval offered
// `accept_execpolicy_amendment` with a ~175 UTF-16-unit display label. The
// Room presentation budget is 160, and the whole permission request was
// rejected before any Room request existed: the Human saw no card, could not
// approve or reject, and the requested command never ran.
//
// The option's identity is its opaque `OptionID`. A long DISPLAY label is a
// presentation problem, never a reason to drop a valid approval.

// codexExecpolicyAmendmentOptionName is the shape of the real native label:
// a sentence-length, human-readable explanation of the amendment.
const codexExecpolicyAmendmentOptionName = "Accept the execution policy amendment so that this command and any future command matching the proposed prefix rule may run without asking for approval again for the remainder of this Codex session"

// codexNativeOptionID is the exact opaque identity the Harness expects back.
const codexNativeOptionID = "accept_execpolicy_amendment"

func roomOptionByID(t *testing.T, options []types.RoomPermissionOption, id string) types.RoomPermissionOption {
	t.Helper()
	for _, option := range options {
		if option.OptionID == id {
			return option
		}
	}
	t.Fatalf("projected Room options lost native option %q: %+v", id, options)
	return types.RoomPermissionOption{}
}

func utf16Length(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func codexShapedPermissionRequest() harness.ACPPermissionRequest {
	return harness.ACPPermissionRequest{
		RequestID: "101",
		ToolCall: harness.ACPToolCall{
			Title:    "Run touch /tmp/probe",
			Kind:     "execute",
			RawInput: []byte(`{"command":"touch /tmp/probe","cwd":"/tmp"}`),
		},
		Options: []harness.ACPPermissionOption{
			{
				OptionID: codexNativeOptionID,
				Name:     codexExecpolicyAmendmentOptionName,
				Kind:     "allow_always",
			},
			{OptionID: "allow_once", Name: "Allow once", Kind: "allow_once"},
			{OptionID: "reject_once", Name: "Reject", Kind: "reject_once"},
		},
	}
}

// 1 + 2: an already-valid short label is untouched, and a long Codex-shaped
// label is projected as a bounded presentation without changing its identity.
func TestRoomPermissionProjectionBoundsLongNativeOptionLabel(t *testing.T) {
	if utf16Length(codexExecpolicyAmendmentOptionName) <= maxRoomPermissionName {
		t.Fatalf("fixture must exceed the %d-unit presentation budget", maxRoomPermissionName)
	}

	projected, offered, err := projectRoomPermission(codexShapedPermissionRequest())
	if err != nil {
		t.Fatalf("a long native option label must not fail the request: %v", err)
	}

	long := roomOptionByID(t, projected.Options, codexNativeOptionID)
	if long.OptionID != codexNativeOptionID {
		t.Fatalf("native option identity changed: %q", long.OptionID)
	}
	if got := utf16Length(long.Name); got > maxRoomPermissionName {
		t.Fatalf("Room display label is %d UTF-16 units, budget is %d: %q", got, maxRoomPermissionName, long.Name)
	}
	if !strings.HasSuffix(long.Name, "…") {
		t.Fatalf("bounded label must show a visible ellipsis: %q", long.Name)
	}
	if !strings.HasPrefix(long.Name, "Accept the execution policy amendment") {
		t.Fatalf("bounded label must stay human-readable: %q", long.Name)
	}
	if _, ok := offered[codexNativeOptionID]; !ok {
		t.Fatalf("native option id must stay offered exactly: %+v", offered)
	}

	// An already-valid label is returned byte-for-byte unchanged.
	short := roomOptionByID(t, projected.Options, "allow_once")
	if short.Name != "Allow once" {
		t.Fatalf("a bounded label must be preserved exactly, got %q", short.Name)
	}
	if short.Kind != "allow_once" {
		t.Fatalf("option kind changed: %q", short.Kind)
	}
}

// 3: the Room's decision round-trips the EXACT native identity. Resolution must
// never be matched through the (possibly truncated) display text.
func TestRoomPermissionDecisionRoundTripsExactNativeOptionID(t *testing.T) {
	projected, offered, err := projectRoomPermission(codexShapedPermissionRequest())
	if err != nil {
		t.Fatalf("project: %v", err)
	}
	display := roomOptionByID(t, projected.Options, codexNativeOptionID).Name
	if display == codexExecpolicyAmendmentOptionName {
		t.Fatal("fixture did not exercise a bounded label")
	}

	// The Human picks the projected option by its Room identity.
	requestID := "room-correlation-1"
	pending := &pendingRoomPermission{offered: offered, done: make(chan roomPermissionDecision, 1)}
	runtime := &ResidentRuntime{pendingPermissions: map[string]*pendingRoomPermission{requestID: pending}}
	handled := runtime.handleRoomPermissionEvent(types.RoomEvent{
		Addressed:  true,
		ActionType: "permission",
		Permission: &types.RoomPermissionEvent{
			RequestID:          requestID,
			Kind:               "resolved",
			AgentParticipantID: runtime.currentParticipantID(),
			SelectedOptionID:   codexNativeOptionID,
		},
	})
	if !handled {
		t.Fatal("a permission decision must be consumed by the permission path")
	}
	decision := <-pending.done
	if decision.err != nil {
		t.Fatalf("offered native option was not accepted: %v", decision.err)
	}
	if decision.optionID != codexNativeOptionID {
		t.Fatalf("decision must carry the exact native option id, got %q", decision.optionID)
	}
	// The truncated DISPLAY text is never an identity: selecting it must be
	// refused exactly like any other un-offered option.
	other := &pendingRoomPermission{offered: offered, done: make(chan roomPermissionDecision, 1)}
	runtime.pendingPermissions[requestID] = other
	runtime.handleRoomPermissionEvent(types.RoomEvent{
		Addressed:  true,
		ActionType: "permission",
		Permission: &types.RoomPermissionEvent{
			RequestID:          requestID,
			Kind:               "resolved",
			AgentParticipantID: runtime.currentParticipantID(),
			SelectedOptionID:   display,
		},
	})
	if got := <-other.done; got.err == nil {
		t.Fatal("a display label must never be accepted as a native option id")
	}
}

// 4: unicode boundaries are safe — no split rune, no lone surrogate, and the
// result is deterministic.
func TestBoundedRoomPermissionNameUnicodeBoundary(t *testing.T) {
	// Astral characters (2 UTF-16 units each) plus a combining sequence, sized
	// to land exactly on and just over the budget.
	emoji := strings.Repeat("🛡️", 80) // 80 * (1 + 1 + 1) = 240 units
	projected, _, err := projectRoomPermission(harness.ACPPermissionRequest{
		ToolCall: harness.ACPToolCall{
			Title:    "Make edits?",
			Kind:     "edit",
			RawInput: []byte(`{"path":"/tmp/file"}`),
		},
		Options: []harness.ACPPermissionOption{{OptionID: "allow", Name: emoji}},
	})
	if err != nil {
		t.Fatalf("unicode label must project: %v", err)
	}
	name := projected.Options[0].Name
	if got := utf16Length(name); got > maxRoomPermissionName {
		t.Fatalf("unicode label is %d UTF-16 units, budget is %d", got, maxRoomPermissionName)
	}
	if !strings.HasSuffix(name, "…") {
		t.Fatalf("unicode label must carry the ellipsis: %q", name)
	}
	// A truncated prefix of valid UTF-16 must remain valid text: no replacement
	// characters and no lone surrogates.
	if strings.ContainsRune(name, '\uFFFD') {
		t.Fatalf("truncation produced a replacement character: %q", name)
	}
	if strings.ContainsRune(string(utf16.Decode(utf16.Encode([]rune(name)))), '\uFFFD') {
		t.Fatalf("unicode label did not survive a UTF-16 round trip: %q", name)
	}
	for index, decode := range []func() string{
		func() string { return truncateRoomPermissionText(emoji, maxRoomPermissionName) },
		func() string { return truncateRoomPermissionText(emoji, maxRoomPermissionName) },
	} {
		if decode() != name {
			t.Fatalf("truncation must be deterministic for input %d", index)
		}
	}

	// A limit that lands in the middle of a surrogate pair must drop the whole
	// pair rather than emit half of it.
	pair := strings.Repeat("😀", 4) // 8 UTF-16 units
	cut := truncateRoomPermissionText(pair, 5)
	if got := utf16Length(cut); got != 5 {
		t.Fatalf("expected a 5-unit label, got %d: %q", got, cut)
	}
	// A lone surrogate would round-trip into U+FFFD; a clean pair does not.
	if strings.ContainsRune(string(utf16.Decode(utf16.Encode([]rune(cut)))), '\uFFFD') {
		t.Fatalf("truncation produced invalid UTF-16: %q", cut)
	}
	if strings.Contains(cut, "\uFFFD") {
		t.Fatalf("truncation split a surrogate pair: %q", cut)
	}
	if cut != "😀😀…" {
		t.Fatalf("unexpected surrogate-safe truncation: %q", cut)
	}

	// Degenerate budgets stay bounded instead of panicking.
	for _, limit := range []int{0, -1, 1, 2} {
		if got := utf16Length(truncateRoomPermissionText(emoji, limit)); got > maxInt(limit, 0) {
			t.Fatalf("limit %d produced %d units", limit, got)
		}
	}
}

// 5: fail-closed identity and label rules are NOT weakened by the presentation
// fix.
func TestRoomPermissionProjectionStillFailsClosed(t *testing.T) {
	base := func(option harness.ACPPermissionOption) harness.ACPPermissionRequest {
		return harness.ACPPermissionRequest{
			ToolCall: harness.ACPToolCall{
				Title:    "Make edits?",
				Kind:     "edit",
				RawInput: []byte(`{"path":"/tmp/file"}`),
			},
			Options: []harness.ACPPermissionOption{option},
		}
	}

	for name, option := range map[string]harness.ACPPermissionOption{
		// Identity is never trimmed, truncated, or repaired.
		"empty id":      {OptionID: "", Name: "Allow once"},
		"whitespace id": {OptionID: " allow-once ", Name: "Allow once"},
		"oversized id":  {OptionID: strings.Repeat("a", maxRoomPermissionOptionID+1), Name: "Allow once"},
		"newline id":    {OptionID: "allow-once\n", Name: "Allow once"},
		// A label with no human-readable text at all stays unpresentable.
		"empty name":      {OptionID: "allow-once", Name: ""},
		"whitespace name": {OptionID: "allow-once", Name: "   \n\t "},
	} {
		projected, offered, err := projectRoomPermission(base(option))
		if err == nil {
			t.Fatalf("%s must stay fail-closed, got %+v (offered %+v)", name, projected, offered)
		}
	}

	// Duplicate native identities still fail closed.
	if _, _, err := projectRoomPermission(harness.ACPPermissionRequest{
		ToolCall: harness.ACPToolCall{Title: "Make edits?", Kind: "edit", RawInput: []byte(`{"path":"/tmp/file"}`)},
		Options: []harness.ACPPermissionOption{
			{OptionID: "allow-once", Name: "Allow once"},
			{OptionID: "allow-once", Name: "Allow once again"},
		},
	}); err == nil {
		t.Fatal("duplicate native option ids must stay fail-closed")
	}

	// An oversized NATIVE identity is still rejected outright: bounding the
	// presentation must never become bounding the identity.
	if _, _, err := projectRoomPermission(base(harness.ACPPermissionOption{
		OptionID: strings.Repeat("i", maxRoomPermissionOptionID+1),
		Name:     "Allow once",
	})); err == nil {
		t.Fatal("oversized native option id must stay fail-closed")
	}
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
