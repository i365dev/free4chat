package media

import (
	"errors"
	"sync"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/speech"
)

// kindRecorder collects OnGrantActivated edges in order.
type kindRecorder struct {
	mu    sync.Mutex
	kinds []GrantKind
}

func (r *kindRecorder) record(kind GrantKind) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.kinds = append(r.kinds, kind)
}

func (r *kindRecorder) snapshot() []GrantKind {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]GrantKind(nil), r.kinds...)
}

func kindsEqual(got []GrantKind, want ...GrantKind) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

// controllerWithRecorder builds a synchronous (no background loop) controller
// whose grant edges land in the recorder.
func controllerWithRecorder(t *testing.T, client *fakeRoomClient) (*Controller, *kindRecorder) {
	t.Helper()
	voiceCfg := &VoiceConfig{
		TrackName: "agent-voice",
		CreateTtsProvider: func() (speech.StreamingTtsProvider, error) {
			return nil, nil
		},
	}
	controller, _ := newControllerHarness(t, client, voiceCfg)
	// Drive poll() directly: no background loop, fully deterministic.
	controller.stopped = false
	rec := &kindRecorder{}
	controller.options.OnGrantActivated = rec.record
	t.Cleanup(controller.Stop)
	return controller, rec
}

// #171: every grant instance (kind + epoch) announces exactly once; an
// unchanged grant never re-fires while polls continue; a later grant on the
// already-running shared bridge still gets its own edge.
func TestControllerGrantActivationEdgesFireOncePerGrantInstance(t *testing.T) {
	client := &fakeRoomClient{}
	controller, rec := controllerWithRecorder(t, client)

	// Meeting Notes only (epoch 111): exactly one MN edge.
	client.setRoom("on", "on", "agent", 111, "off", "on", "agent", 0, nil)
	controller.poll()
	if got := rec.snapshot(); !kindsEqual(got, GrantMeetingNotes) {
		t.Fatalf("first MN activation must fire exactly one MN edge, got %v", got)
	}

	// The same grant stays active across polls: no spam.
	controller.poll()
	controller.poll()
	if got := rec.snapshot(); !kindsEqual(got, GrantMeetingNotes) {
		t.Fatalf("unchanged grant must not re-fire, got %v", got)
	}

	// Voice Reply joins later on the shared bridge: its own VR edge.
	client.setRoom("on", "on", "agent", 111, "on", "on", "agent", 555, nil)
	controller.poll()
	if got := rec.snapshot(); !kindsEqual(got, GrantMeetingNotes, GrantVoiceReply) {
		t.Fatalf("later VR activation must fire its own edge, got %v", got)
	}

	// Both grants remain active: still no spam.
	controller.poll()
	if got := rec.snapshot(); !kindsEqual(got, GrantMeetingNotes, GrantVoiceReply) {
		t.Fatalf("steady state must stay quiet, got %v", got)
	}

	// MN stop/start produces a fresh MN edge (new epoch 222).
	client.setRoom("off", "on", "agent", 0, "off", "on", "agent", 0, nil)
	controller.poll()
	client.setRoom("on", "on", "agent", 222, "off", "on", "agent", 0, nil)
	controller.poll()
	if got := rec.snapshot(); !kindsEqual(got,
		GrantMeetingNotes, GrantVoiceReply, GrantMeetingNotes) {
		t.Fatalf("new MN grant epoch must produce a fresh edge, got %v", got)
	}

	// VR stop/start likewise (new epoch 556).
	client.setRoom("on", "on", "agent", 222, "on", "on", "agent", 556, nil)
	controller.poll()
	if got := rec.snapshot(); !kindsEqual(got,
		GrantMeetingNotes, GrantVoiceReply, GrantMeetingNotes, GrantVoiceReply) {
		t.Fatalf("new VR grant epoch must produce a fresh edge, got %v", got)
	}
}

// #171: both grants activating on the same poll evaluate independently —
// two edges, Meeting Notes first, Voice Reply second.
func TestControllerBothGrantsSamePollFireBothEdges(t *testing.T) {
	client := &fakeRoomClient{}
	controller, rec := controllerWithRecorder(t, client)

	client.setRoom("on", "on", "agent", 100, "on", "on", "agent", 200, nil)
	controller.poll()
	controller.poll()
	if got := rec.snapshot(); !kindsEqual(got, GrantMeetingNotes, GrantVoiceReply) {
		t.Fatalf("both grants must fire both edges exactly once, got %v", got)
	}
}

// #171: reassignment A -> B lets the new holder evaluate its own
// prerequisites; the previous holder stays quiet and re-arms.
func TestControllerGrantReassignmentLetsNewHolderAnnounce(t *testing.T) {
	client := &fakeRoomClient{}
	controllerA, recA := controllerWithRecorder(t, client)
	controllerB, recB := controllerWithRecorder(t, client)
	controllerB.options.ParticipantID = "agent-b"

	// Grant targets A: A announces, B is not targeted and stays quiet.
	client.setRoom("on", "on", "agent", 1, "off", "on", "agent", 0, nil)
	controllerA.poll()
	controllerB.poll()
	if got := recA.snapshot(); !kindsEqual(got, GrantMeetingNotes) {
		t.Fatalf("targeted holder must announce, got %v", got)
	}
	if got := recB.snapshot(); len(got) != 0 {
		t.Fatalf("non-targeted holder must stay quiet, got %v", got)
	}

	// Reassignment to B with a fresh epoch: A re-arms without a new notice;
	// B announces its own edge.
	client.setRoom("on", "on", "agent-b", 2, "off", "on", "agent", 0, nil)
	controllerA.poll()
	controllerB.poll()
	if got := recA.snapshot(); !kindsEqual(got, GrantMeetingNotes) {
		t.Fatalf("previous holder must not re-announce after reassignment, got %v", got)
	}
	if got := recB.snapshot(); !kindsEqual(got, GrantMeetingNotes) {
		t.Fatalf("new holder must announce its own activation, got %v", got)
	}
}

// #175 review blocker: a transient RoomInfo failure between two successful
// observations of the SAME grant epoch must NOT re-announce the prerequisite.
// The announcement survives transport failures; re-arming happens only when
// a successful observation positively reports the grant inactive.
func TestControllerTransientRoomInfoFailureDoesNotReannounceMeetingNotes(t *testing.T) {
	client := &fakeRoomClient{}
	controller, rec := controllerWithRecorder(t, client)

	// Active Meeting Notes epoch 111: exactly one edge.
	client.setRoom("on", "on", "agent", 111, "off", "on", "agent", 0, nil)
	controller.poll()
	if got := rec.snapshot(); !kindsEqual(got, GrantMeetingNotes) {
		t.Fatalf("first MN activation must fire once, got %v", got)
	}

	// Transient RoomInfo failure while the grant stays active server-side.
	client.setRoom("off", "on", "agent", 0, "off", "on", "agent", 0, errors.New("network"))
	controller.poll()

	// Recovery observes the SAME epoch: no second prerequisite notice.
	client.setRoom("on", "on", "agent", 111, "off", "on", "agent", 0, nil)
	controller.poll()
	if got := rec.snapshot(); !kindsEqual(got, GrantMeetingNotes) {
		t.Fatalf("recovery with the same epoch must not re-announce, got %v", got)
	}

	// A positively observed inactivity still re-arms: the next genuinely new
	// grant instance (fresh epoch) announces again.
	client.setRoom("off", "on", "agent", 0, "off", "on", "agent", 0, nil)
	controller.poll()
	client.setRoom("on", "on", "agent", 222, "off", "on", "agent", 0, nil)
	controller.poll()
	if got := rec.snapshot(); !kindsEqual(got, GrantMeetingNotes, GrantMeetingNotes) {
		t.Fatalf("fresh grant instance after positive inactivity must announce, got %v", got)
	}
}

// #175 review blocker, Voice Reply side: identical guarantee over the shared
// bridge's second grant.
func TestControllerTransientRoomInfoFailureDoesNotReannounceVoiceReply(t *testing.T) {
	client := &fakeRoomClient{}
	controller, rec := controllerWithRecorder(t, client)

	// Active Voice Reply epoch 555: exactly one VR edge.
	client.setRoom("off", "on", "agent", 0, "on", "on", "agent", 555, nil)
	controller.poll()
	if got := rec.snapshot(); !kindsEqual(got, GrantVoiceReply) {
		t.Fatalf("first VR activation must fire once, got %v", got)
	}

	// Transient RoomInfo failure while the grant stays active server-side.
	client.setRoom("off", "on", "agent", 0, "off", "on", "agent", 0, errors.New("network"))
	controller.poll()

	// Recovery observes the SAME epoch: no second prerequisite notice.
	client.setRoom("off", "on", "agent", 0, "on", "on", "agent", 555, nil)
	controller.poll()
	if got := rec.snapshot(); !kindsEqual(got, GrantVoiceReply) {
		t.Fatalf("recovery with the same epoch must not re-announce, got %v", got)
	}

	// Positive inactivity re-arms; a genuinely new instance announces again.
	client.setRoom("off", "on", "agent", 0, "off", "on", "agent", 0, nil)
	controller.poll()
	client.setRoom("off", "on", "agent", 0, "on", "on", "agent", 666, nil)
	controller.poll()
	if got := rec.snapshot(); !kindsEqual(got, GrantVoiceReply, GrantVoiceReply) {
		t.Fatalf("fresh VR instance after positive inactivity must announce, got %v", got)
	}
}

// Both grants active across a transient failure: neither announcement is
// lost or duplicated.
func TestControllerTransientRoomInfoFailurePreservesBothAnnouncements(t *testing.T) {
	client := &fakeRoomClient{}
	controller, rec := controllerWithRecorder(t, client)

	client.setRoom("on", "on", "agent", 111, "on", "on", "agent", 555, nil)
	controller.poll()
	if got := rec.snapshot(); !kindsEqual(got, GrantMeetingNotes, GrantVoiceReply) {
		t.Fatalf("both grants must announce once, got %v", got)
	}

	client.setRoom("off", "off", "agent", 0, "off", "off", "agent", 0, errors.New("network"))
	controller.poll()

	client.setRoom("on", "on", "agent", 111, "on", "on", "agent", 555, nil)
	controller.poll()
	if got := rec.snapshot(); !kindsEqual(got, GrantMeetingNotes, GrantVoiceReply) {
		t.Fatalf("recovery with unchanged epochs must not re-announce either grant, got %v", got)
	}
}
