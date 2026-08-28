package harness

import "strings"

// #165 outbound addressing contract (Harness -> Runtime).
//
// A Harness may hand the conversation to other Agents by ending its reply
// with ONE strict machine envelope line:
//
//	[[free4chat:targets <participantId>[,<participantId>...]]]
//
// The envelope is parsed and stripped by the local adapter before the reply
// is published; the extracted participant IDs ride the turn result as
// explicit structured targets and wake exactly those resident Runtimes.
//
// This is a machine envelope, not language: the parser accepts only an
// exact final line with the exact marker, and participant IDs from a tiny
// ASCII charset. Nothing else is ever interpreted — visible @Name prose in
// a reply has no routing meaning. A Harness that never emits the envelope
// keeps plain unaddressed behavior (backward compatible).

const (
	targetsEnvelopeMarker = "[[free4chat:targets"
	targetsEnvelopeSuffix = "]]"
	// Mirrors the DO MAX_TARGETS bound for addressed text.
	maxOutboundTargets = 8
	maxTargetIDLength  = 64
)

// isTargetIDChar reports whether r may appear inside an explicit target
// participant ID. Room participant IDs are server-generated UUIDs, so the
// accepted charset is deliberately tiny: anything else (names, prose,
// quotes, whitespace) fails closed and is dropped.
func isTargetIDChar(r rune) bool {
	switch {
	case r >= 'a' && r <= 'z',
		r >= 'A' && r <= 'Z',
		r >= '0' && r <= '9',
		r == '-', r == '_', r == '.', r == ':':
		return true
	}
	return false
}

func validTargetID(id string) bool {
	if id == "" || len(id) > maxTargetIDLength {
		return false
	}
	for _, r := range id {
		if !isTargetIDChar(r) {
			return false
		}
	}
	return true
}

// ParseOutboundTargets splits one turn result into its publishable body and
// its explicit outbound targets. The envelope is recognized only as the
// LAST line of the reply; malformed or unknown content stays verbatim prose.
// An envelope with no valid IDs strips to an ordinary unaddressed reply; a
// reply consisting of only an envelope produces an empty body, which the
// runtime treats as "nothing to publish". Returned IDs are deduplicated and
// capped at maxOutboundTargets.
func ParseOutboundTargets(text string) (string, []string) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "", nil
	}
	lines := strings.Split(trimmed, "\n")
	last := strings.TrimSpace(lines[len(lines)-1])
	if !strings.HasPrefix(last, targetsEnvelopeMarker) ||
		!strings.HasSuffix(last, targetsEnvelopeSuffix) {
		return trimmed, nil
	}
	body := strings.TrimSpace(
		strings.Join(lines[:len(lines)-1], "\n"),
	)
	ids := strings.Split(
		last[len(targetsEnvelopeMarker):len(last)-len(targetsEnvelopeSuffix)],
		",",
	)
	targets := make([]string, 0, len(ids))
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if !validTargetID(id) {
			continue
		}
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		targets = append(targets, id)
		if len(targets) == maxOutboundTargets {
			break
		}
	}
	if len(targets) == 0 {
		return body, nil
	}
	return body, targets
}
