package harness

import (
	"strings"
	"testing"
)

// #165: the outbound addressing envelope is a strict machine contract with
// all-or-nothing semantics. These tests pin every boundary the runtime
// relies on: prose is never routing, a malformed envelope is never repaired
// and never partially routed (the complete text stays visible prose), and
// exact envelopes route with dedupe and the room's target bound.
func TestParseOutboundTargets(t *testing.T) {
	tests := []struct {
		name        string
		text        string
		wantBody    string
		wantTargets []string
	}{
		{
			name:        "plain reply is unchanged",
			text:        "hello room",
			wantBody:    "hello room",
			wantTargets: nil,
		},
		{
			name:        "empty reply",
			text:        "   ",
			wantBody:    "",
			wantTargets: nil,
		},
		{
			name:        "mention prose is not routing",
			text:        "I agree with what @Hermes said earlier.",
			wantBody:    "I agree with what @Hermes said earlier.",
			wantTargets: nil,
		},
		{
			name:        "envelope mid-text is prose",
			text:        "[[free4chat:targets agent-b]]\nactual reply",
			wantBody:    "[[free4chat:targets agent-b]]\nactual reply",
			wantTargets: nil,
		},
		{
			name:        "marker without suffix is prose",
			text:        "reply\n[[free4chat:targets agent-b",
			wantBody:    "reply\n[[free4chat:targets agent-b",
			wantTargets: nil,
		},
		{
			name:        "unknown machine line is prose",
			text:        "reply\n[[free4chat:to agent-b]]",
			wantBody:    "reply\n[[free4chat:to agent-b]]",
			wantTargets: nil,
		},
		// Regression (#165 review): the marker without its separator must not
		// glue onto the first ID and route.
		{
			name:        "missing space after marker is prose",
			text:        "reply\n[[free4chat:targetsagent-b]]",
			wantBody:    "reply\n[[free4chat:targetsagent-b]]",
			wantTargets: nil,
		},
		{
			name:        "double space after marker is prose",
			text:        "reply\n[[free4chat:targets  agent-b]]",
			wantBody:    "reply\n[[free4chat:targets  agent-b]]",
			wantTargets: nil,
		},
		{
			name:        "bare marker is prose",
			text:        "reply\n[[free4chat:targets]]",
			wantBody:    "reply\n[[free4chat:targets]]",
			wantTargets: nil,
		},
		// Regression (#165 review): names with spaces void the whole
		// envelope — never partially routed alongside valid IDs.
		{
			name:        "name-only list is prose",
			text:        "reply\n[[free4chat:targets Hermes Agent]]",
			wantBody:    "reply\n[[free4chat:targets Hermes Agent]]",
			wantTargets: nil,
		},
		{
			name:        "one name in the list voids the whole envelope",
			text:        "reply\n[[free4chat:targets Hermes Agent,agent-b]]",
			wantBody:    "reply\n[[free4chat:targets Hermes Agent,agent-b]]",
			wantTargets: nil,
		},
		{
			name:        "one over-long id voids the whole envelope",
			text:        "reply\n[[free4chat:targets " + strings.Repeat("a", 65) + ",agent-b]]",
			wantBody:    "reply\n[[free4chat:targets " + strings.Repeat("a", 65) + ",agent-b]]",
			wantTargets: nil,
		},
		{
			name:        "empty list is prose",
			text:        "reply\n[[free4chat:targets ]]",
			wantBody:    "reply\n[[free4chat:targets ]]",
			wantTargets: nil,
		},
		{
			name:        "trailing space inside the list is prose",
			text:        "reply\n[[free4chat:targets agent-b ]]",
			wantBody:    "reply\n[[free4chat:targets agent-b ]]",
			wantTargets: nil,
		},
		// Exact envelopes continue to route.
		{
			name:        "single target",
			text:        "继续这个故事。\n[[free4chat:targets agent-hermes]]",
			wantBody:    "继续这个故事。",
			wantTargets: []string{"agent-hermes"},
		},
		{
			name:        "multiple targets",
			text:        "handing off\n[[free4chat:targets agent-b,agent-c]]",
			wantBody:    "handing off",
			wantTargets: []string{"agent-b", "agent-c"},
		},
		{
			name:        "duplicate targets collapse",
			text:        "handoff\n[[free4chat:targets agent-b,agent-b,agent-b]]",
			wantBody:    "handoff",
			wantTargets: []string{"agent-b"},
		},
		{
			name:        "unknown but syntactically valid ids pass the boundary",
			text:        "handoff\n[[free4chat:targets not-a-real-participant]]",
			wantBody:    "handoff",
			wantTargets: []string{"not-a-real-participant"},
		},
		{
			name:        "envelope-only reply publishes nothing",
			text:        "[[free4chat:targets agent-b]]",
			wantBody:    "",
			wantTargets: []string{"agent-b"},
		},
		{
			name:        "target list is capped at the room bound",
			text:        "handoff\n[[free4chat:targets a1,a2,a3,a4,a5,a6,a7,a8,a9,a10]]",
			wantBody:    "handoff",
			wantTargets: []string{"a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			body, targets := ParseOutboundTargets(tc.text)
			if body != tc.wantBody {
				t.Fatalf("body mismatch:\nwant %q\ngot  %q", tc.wantBody, body)
			}
			if len(targets) != len(tc.wantTargets) {
				t.Fatalf("targets mismatch: want %v got %v", tc.wantTargets, targets)
			}
			for i := range targets {
				if targets[i] != tc.wantTargets[i] {
					t.Fatalf("targets mismatch: want %v got %v", tc.wantTargets, targets)
				}
			}
		})
	}
}

// #165: the adapter must surface envelope-derived targets on the turn result
// and strip the envelope from the published reply.
func TestACPTurnParsesOutboundAddressingEnvelope(t *testing.T) {
	adapter, _ := newTestAdapter(t, scriptLauncher("envelope", map[string]string{
		"FAKE_REPLY_TEXT": "继续这个故事，下一句你来。\n[[free4chat:targets agent-hermes-uuid]]",
	}), AdapterOptions{TurnTimeoutMs: 5000})
	defer func() { _ = adapter.Close() }()

	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("EnsureSession failed: %v", err)
	}
	result, err := adapter.RunTurn(turnInput("hand off please"))
	if err != nil {
		t.Fatalf("RunTurn failed: %v", err)
	}
	if result.Text != "继续这个故事，下一句你来。" {
		t.Fatalf("envelope must be stripped from the reply, got %q", result.Text)
	}
	if len(result.TargetParticipantIDs) != 1 || result.TargetParticipantIDs[0] != "agent-hermes-uuid" {
		t.Fatalf("targets mismatch: %v", result.TargetParticipantIDs)
	}
}

// Regression (#165 review): a malformed envelope is published verbatim as
// prose and routes nothing — never silently repaired, never partially routed.
func TestACPTurnMalformedEnvelopeStaysProse(t *testing.T) {
	adapter, _ := newTestAdapter(t, scriptLauncher("envelope", map[string]string{
		"FAKE_REPLY_TEXT": "接上。\n[[free4chat:targetsagent-b]]",
	}), AdapterOptions{TurnTimeoutMs: 5000})
	defer func() { _ = adapter.Close() }()

	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("EnsureSession failed: %v", err)
	}
	result, err := adapter.RunTurn(turnInput("hand off please"))
	if err != nil {
		t.Fatalf("RunTurn failed: %v", err)
	}
	if result.Text != "接上。\n[[free4chat:targetsagent-b]]" {
		t.Fatalf("malformed envelope must remain complete visible prose, got %q", result.Text)
	}
	if result.TargetParticipantIDs != nil {
		t.Fatalf("malformed envelope must route nothing, got %v", result.TargetParticipantIDs)
	}
}

// Plain-text Harnesses must keep working with no envelope in play.
func TestACPTurnPlainReplyStaysUnaddressed(t *testing.T) {
	adapter, _ := newTestAdapter(t, scriptLauncher("envelope", nil), AdapterOptions{TurnTimeoutMs: 5000})
	defer func() { _ = adapter.Close() }()

	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("EnsureSession failed: %v", err)
	}
	result, err := adapter.RunTurn(turnInput("say hi"))
	if err != nil {
		t.Fatalf("RunTurn failed: %v", err)
	}
	if result.Text != "reply-1" {
		t.Fatalf("plain reply mismatch: %q", result.Text)
	}
	if result.TargetParticipantIDs != nil {
		t.Fatalf("plain reply must carry no targets, got %v", result.TargetParticipantIDs)
	}
}
