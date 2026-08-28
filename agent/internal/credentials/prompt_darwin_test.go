//go:build darwin

package credentials

import (
	"strings"
	"testing"
)

func TestPurposeDescriptionExplainsSharedDoubaoCredential(t *testing.T) {
	for purpose, want := range map[string]string{
		"speech.stt": "Meeting Notes requires Doubao Speech.",
		"speech.tts": "Voice Reply requires Doubao Speech.",
	} {
		message := purposeDescription(purpose)
		if message != want || strings.Contains(strings.ToLower(message), "only") {
			t.Fatalf("purpose %q has misleading consent wording: %q", purpose, message)
		}
	}
}
