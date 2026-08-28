package harness

import "strings"

// #165 outbound addressing contract (Harness -> Runtime).
//
// A Harness may hand the conversation to other Agents by ending its reply
// with ONE strict machine envelope line:
//
//	[[free4chat:targets <participantId>[,<participantId>...]]]
//
// The grammar is exact: the marker `[[free4chat:targets` followed by exactly
// one space, a comma-separated list of participant IDs (charset
// [A-Za-z0-9._:-], 1..64 chars each, no spaces, no trimming), and the exact
// closing `]]` — nothing else on the line.
//
// Parse outcome is all-or-nothing. An envelope that parses EXACTLY is
// stripped and yields structured targets (deduplicated, capped). Anything
// malformed or approximate — missing separator, names instead of IDs, any
// invalid token anywhere in the list — routes NOTHING: the complete text,
// envelope line included, stays ordinary visible prose, and no partial
// repair or partial routing ever happens. The Room remains authoritative
// and independently drops unknown/non-Agent/self targets.
//
// This is a machine envelope, not language: visible @Name prose in a reply
// has no routing meaning. A Harness that never emits the envelope keeps
// plain unaddressed behavior (backward compatible).

const (
	targetsEnvelopePrefix = "[[free4chat:targets "
	targetsEnvelopeSuffix = "]]"
	// Mirrors the DO MAX_TARGETS bound for addressed text.
	maxOutboundTargets = 8
	maxTargetIDLength  = 64
)

// isTargetIDChar reports whether r may appear inside an explicit target
// participant ID. Room participant IDs are server-generated UUIDs, so the
// accepted charset is deliberately tiny: anything else (names, prose,
// quotes, whitespace) fails closed.
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
// LAST line of the reply and only when it matches the exact grammar above;
// the whole line then routes (deduplicated, capped at maxOutboundTargets).
// A reply consisting of only an envelope produces an empty body, which the
// runtime treats as "nothing to publish".
func ParseOutboundTargets(text string) (string, []string) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "", nil
	}
	lines := strings.Split(trimmed, "\n")
	last := lines[len(lines)-1]
	if !strings.HasPrefix(last, targetsEnvelopePrefix) ||
		!strings.HasSuffix(last, targetsEnvelopeSuffix) {
		return trimmed, nil
	}
	ids := strings.Split(
		last[len(targetsEnvelopePrefix):len(last)-len(targetsEnvelopeSuffix)],
		",",
	)
	// Validate the WHOLE list before routing anything: one malformed token
	// voids the entire envelope, and the line is left as visible prose.
	for _, id := range ids {
		if !validTargetID(id) {
			return trimmed, nil
		}
	}
	targets := make([]string, 0, len(ids))
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		if len(targets) == maxOutboundTargets {
			break
		}
		targets = append(targets, id)
	}
	if len(targets) == 0 {
		return trimmed, nil
	}
	body := strings.TrimSpace(strings.Join(lines[:len(lines)-1], "\n"))
	return body, targets
}
