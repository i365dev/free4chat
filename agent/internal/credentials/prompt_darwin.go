//go:build darwin

package credentials

import (
	"errors"
	"os/exec"
	"strings"
)

func promptForSecret(provider, purpose string) (string, error) {
	if provider != "doubao" {
		return "", errors.New("unsupported credential provider")
	}
	message := "Free4Chat needs Doubao Speech access. This credential stays on this Mac and is never sent to a Free4Chat Room or your AI Agent."
	if purpose != "" {
		message += " " + purposeDescription(purpose) + " Doubao uses one shared local Speech credential that may be used by both STT and TTS capabilities."
	}
	script := "text returned of (display dialog " + appleScriptQuote(message) + " default answer \"\" with hidden answer buttons {\"Cancel\", \"Save\"} default button \"Save\" cancel button \"Cancel\" with title \"Free4Chat\")"
	output, err := exec.Command("/usr/bin/osascript", "-e", script).Output()
	if err != nil {
		return "", ErrCancelled
	}
	value := strings.TrimSpace(string(output))
	if value == "" {
		return "", ErrCancelled
	}
	return value, nil
}

func purposeDescription(purpose string) string {
	if purpose == "speech.tts" {
		return "Voice Reply requires Doubao Speech."
	}
	return "Meeting Notes requires Doubao Speech."
}

func appleScriptQuote(value string) string {
	return "\"" + strings.NewReplacer("\\", "\\\\", "\"", "\\\"").Replace(value) + "\""
}
