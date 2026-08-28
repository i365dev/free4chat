package harness

import (
	"strings"
	"testing"
)

// #165: the outbound addressing envelope is a strict machine contract. These
// tests pin every boundary the runtime relies on: prose is never routing,
// malformed targets cannot survive, and ordinary replies parse unchanged.
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
			name:        "spaces around ids are tolerated",
			text:        "handoff\n[[free4chat:targets agent-b , agent-c]]",
			wantBody:    "handoff",
			wantTargets: []string{"agent-b", "agent-c"},
		},
		{
			name:        "duplicate targets collapse",
			text:        "handoff\n[[free4chat:targets agent-b,agent-b,agent-b]]",
			wantBody:    "handoff",
			wantTargets: []string{"agent-b"},
		},
		{
			name:        "names are dropped, ids survive",
			text:        "handoff\n[[free4chat:targets Hermes Agent,agent-b]]",
			wantBody:    "handoff",
			wantTargets: []string{"agent-b"},
		},
		{
			name:        "all-malformed envelope degrades to unaddressed",
			text:        "handoff\n[[free4chat:targets Hermes Agent]]",
			wantBody:    "handoff",
			wantTargets: nil,
		},
		{
			name:        "empty envelope degrades to unaddressed",
			text:        "handoff\n[[free4chat:targets ]]",
			wantBody:    "handoff",
			wantTargets: nil,
		},
		{
			name:        "envelope-only reply publishes nothing",
			text:        "[[free4chat:targets agent-b]]",
			wantBody:    "",
			wantTargets: []string{"agent-b"},
		},
		{
			name:        "over-long id is dropped",
			text:        "handoff\n[[free4chat:targets " + strings.Repeat("a", 65) + ",agent-b]]",
			wantBody:    "handoff",
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
