package speech

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTranscriptStoreBoundedAndPersisted(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".meeting-notes", "transcript.jsonl")
	store := NewTranscriptStore(path)
	defer store.Dispose()
	if err := store.Ready(); err != nil {
		t.Fatalf("ready: %v", err)
	}
	alice := AudioSource{ParticipantID: "h1", ParticipantName: "Alice", TrackName: "mic"}
	store.Record(alice, "  first utterance  ")
	store.Record(alice, "second")
	store.Flush()

	snapshot := store.Snapshot()
	if snapshot.Path != HarnessTranscriptPath || len(snapshot.Segments) != 2 ||
		snapshot.Segments[0].Text != "first utterance" ||
		snapshot.Segments[0].Speaker != "Alice" ||
		snapshot.Segments[0].Sequence != 1 || snapshot.Segments[1].Sequence != 2 {
		t.Fatalf("snapshot mismatch: %+v", snapshot)
	}
	data, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(data), "first utterance") {
		t.Fatalf("persisted file mismatch: %q %v", data, err)
	}
	if strings.Contains(string(data), "participantToken") || strings.Contains(string(data), "secret") {
		t.Fatal("transcript file must never carry capability material")
	}

	// Segment bound: > maxTranscriptSegments records keep only the tail.
	for i := 0; i < maxTranscriptSegments+50; i++ {
		store.Record(alice, strings.Repeat("x", 10))
	}
	store.Flush()
	if len(store.Snapshot().Segments) > maxTranscriptSegments {
		t.Fatalf("segment bound violated: %d", len(store.Snapshot().Segments))
	}

	store.Dispose()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("dispose must remove the local transcript file")
	}
}

func TestTranscriptStoreReadyFailureNeverGateTextTurns(t *testing.T) {
	// Path is a directory: Ready() fails; Record/Snapshot stay safe no-ops.
	path := t.TempDir()
	store := NewTranscriptStore(path)
	if err := store.Ready(); err == nil {
		t.Fatal("ready against a directory path must fail")
	}
	store.Record(AudioSource{ParticipantID: "h"}, "still fine")
	if len(store.Snapshot().Segments) != 1 {
		t.Fatal("in-memory memory must survive persistence failure")
	}
	store.Dispose()
}
