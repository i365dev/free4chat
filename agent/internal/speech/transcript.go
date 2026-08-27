package speech

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	maxTranscriptSegments = 500
	maxTranscriptChars    = 64_000
	// HarnessTranscriptPath is the runtime-local relative path surfaced to
	// the Harness for meeting context.
	HarnessTranscriptPath = ".meeting-notes/transcript.jsonl"
)

// TranscriptSegment is one committed attributed utterance.
type TranscriptSegment struct {
	ParticipantID string `json:"participantId"`
	Speaker       string `json:"speaker"`
	Text          string `json:"text"`
}

// TranscriptSnapshot is the bounded in-memory view plus its local path.
type TranscriptSnapshot struct {
	Path     string
	Segments []TranscriptSegment
}

// TranscriptStore is the runtime-local bounded Meeting Notes memory. Only
// provider `committed` events enter here; raw audio, partials, errors, and
// credentials never do. The file lives in the per-instance 0700 workspace
// and is removed on dispose — never shared across rooms, never uploaded.
type TranscriptStore struct {
	path     string
	mu       sync.Mutex
	segments []TranscriptSegment
	disposed bool
	writeQ   chan func()
}

// NewTranscriptStore builds a store bound to one instance workspace file.
func NewTranscriptStore(path string) *TranscriptStore {
	store := &TranscriptStore{path: path, writeQ: make(chan func(), 256)}
	go store.writer()
	return store
}

// Ready creates the parent directory and an empty 0600 file. A filesystem
// failure here must never gate text turns (caller logs and continues).
func (t *TranscriptStore) Ready() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.disposed {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(t.path), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(t.path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Chmod(t.path, 0o600)
}

// Record commits one definite utterance, bounded by segments and chars.
func (t *TranscriptStore) Record(source AudioSource, text string) {
	normalized := strings.TrimSpace(text)
	if normalized == "" {
		return
	}
	t.mu.Lock()
	if t.disposed {
		t.mu.Unlock()
		return
	}
	t.segments = append(t.segments, TranscriptSegment{
		ParticipantID: source.ParticipantID,
		Speaker:       source.ParticipantName,
		Text:          normalized,
	})
	for len(t.segments) > maxTranscriptSegments || totalChars(t.segments) > maxTranscriptChars {
		t.segments = t.segments[1:]
	}
	contents := t.renderLocked()
	t.mu.Unlock()
	t.scheduleWrite(contents)
}

// Snapshot copies the bounded in-memory segments.
func (t *TranscriptStore) Snapshot() TranscriptSnapshot {
	t.mu.Lock()
	defer t.mu.Unlock()
	segments := make([]TranscriptSegment, len(t.segments))
	copy(segments, t.segments)
	return TranscriptSnapshot{Path: HarnessTranscriptPath, Segments: segments}
}

// Flush drains pending writes (best-effort; never gates a text turn).
func (t *TranscriptStore) Flush() {
	done := make(chan struct{})
	select {
	case t.writeQ <- func() { close(done) }:
		<-done
	default:
	}
}

// Dispose removes the local transcript file; idempotent.
func (t *TranscriptStore) Dispose() {
	t.mu.Lock()
	if t.disposed {
		t.mu.Unlock()
		return
	}
	t.disposed = true
	t.mu.Unlock()
	done := make(chan struct{})
	select {
	case t.writeQ <- func() {
		_ = os.Remove(t.path)
		close(done)
	}:
		<-done
	default:
		_ = os.Remove(t.path)
		close(done)
	}
}

func (t *TranscriptStore) renderLocked() string {
	lines := make([]string, 0, len(t.segments))
	for _, segment := range t.segments {
		data, err := json.Marshal(segment)
		if err != nil {
			continue
		}
		lines = append(lines, string(data))
	}
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, "\n") + "\n"
}

func (t *TranscriptStore) scheduleWrite(contents string) {
	select {
	case t.writeQ <- func() {
		_ = os.WriteFile(t.path, []byte(contents), 0o600)
	}:
	default:
		// Bounded writer queue; dropping a write only loses local memory
		// durability, never room behavior.
	}
}

func (t *TranscriptStore) writer() {
	for task := range t.writeQ {
		task()
	}
}

func totalChars(segments []TranscriptSegment) int {
	total := 0
	for _, segment := range segments {
		total += len(segment.Text)
	}
	return total
}
