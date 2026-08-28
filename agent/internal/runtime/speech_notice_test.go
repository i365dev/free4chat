package runtime

import (
	"strings"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/media"
	"github.com/i365dev/free4chat/agent/internal/speech"
)

// speechConfig builds a speech config with explicit slot readiness.
func speechConfig(stt, tts bool) speech.Config {
	return speech.Config{APIKey: "local-key", STTEnabled: stt, TTSEnabled: tts}
}

// #171: the notice evaluates ONLY the prerequisite of the grant that
// activated — Meeting Notes requires STT, Voice Reply requires TTS — over
// one shared media bridge. The opposite slot's state is irrelevant, and a
// Voice-only grant must never claim Meeting Notes was requested.
func TestBuildSpeechNoticeEvaluatesOnlyTheActivatedGrant(t *testing.T) {
	cases := []struct {
		name          string
		config        speech.Config
		kind          media.GrantKind
		wantSubstring string
	}{
		{
			name:          "voice-only with TTS missing reports the voice prerequisite",
			config:        speechConfig(false, false),
			kind:          media.GrantVoiceReply,
			wantSubstring: "Voice Reply was requested",
		},
		{
			name:          "voice-only with TTS ready stays silent even if STT is missing",
			config:        speechConfig(false, true),
			kind:          media.GrantVoiceReply,
			wantSubstring: "",
		},
		{
			name:          "notes-only with STT missing reports the notes prerequisite",
			config:        speechConfig(false, false),
			kind:          media.GrantMeetingNotes,
			wantSubstring: "Meeting Notes was requested",
		},
		{
			name:          "notes-only with STT ready stays silent even if TTS is missing",
			config:        speechConfig(true, false),
			kind:          media.GrantMeetingNotes,
			wantSubstring: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			notice := buildSpeechNotice(tc.config, tc.kind)
			if tc.wantSubstring == "" {
				if notice != "" {
					t.Fatalf("satisfied prerequisite must not notify, got %q", notice)
				}
				return
			}
			if !strings.Contains(notice, tc.wantSubstring) {
				t.Fatalf("notice mismatch: want %q in %q", tc.wantSubstring, notice)
			}
			// The other grant's wording must never leak into this notice.
			other := "Meeting Notes was requested"
			if tc.kind == media.GrantMeetingNotes {
				other = "Voice Reply was requested"
			}
			if strings.Contains(notice, other) {
				t.Fatalf("notice for %v must not mention the other grant: %q", tc.kind, notice)
			}
			// Keys are never requested in the room.
			if strings.Contains(notice, "API keys into this room.") == false {
				t.Fatalf("notice must keep the no-keys-in-room guidance: %q", notice)
			}
		})
	}
}

// #171: the runtime sends the grant-specific notice through the ordinary
// unaddressed send path (#165: nil targets — room context for everyone).
func TestNotifySpeechPrerequisiteSendsGrantSpecificUnaddressedNotice(t *testing.T) {
	client := &fakeClient{}
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-notice",
		RoomID:     "test-notice",
		Name:       "Pi",
		Client:     client,
		Adapter:    &fakeAdapter{name: "pi"},
	})
	func() {
		rt.mu.Lock()
		defer rt.mu.Unlock()
		rt.participantHandle = "secret-handle"
		rt.speechConfig = speechConfig(false, false)
	}()

	rt.notifySpeechPrerequisite(media.GrantVoiceReply)
	sent := client.snapshotSent()
	targets := client.snapshotSentTargets()
	if len(sent) != 1 || !strings.Contains(sent[0], "Voice Reply was requested") {
		t.Fatalf("voice grant must send the voice notice, got %v", sent)
	}
	if len(targets) != 1 || targets[0] != nil {
		t.Fatalf("notice must stay an ordinary unaddressed message, got %v", targets)
	}

	// Meeting Notes edge over the same state reports the notes prerequisite.
	rt.notifySpeechPrerequisite(media.GrantMeetingNotes)
	sent = client.snapshotSent()
	if len(sent) != 2 || !strings.Contains(sent[1], "Meeting Notes was requested") {
		t.Fatalf("notes grant must send the notes notice, got %v", sent)
	}

	// A satisfied prerequisite sends nothing at all.
	func() {
		rt.mu.Lock()
		defer rt.mu.Unlock()
		rt.speechConfig = speechConfig(true, true)
	}()
	rt.notifySpeechPrerequisite(media.GrantMeetingNotes)
	rt.notifySpeechPrerequisite(media.GrantVoiceReply)
	if got := len(client.snapshotSent()); got != 2 {
		t.Fatalf("satisfied prerequisites must not notify, saw %d sends", got)
	}
}
