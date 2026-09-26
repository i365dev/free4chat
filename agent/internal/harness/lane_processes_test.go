package harness

import (
	"bytes"
	"strings"
	"testing"
)

// parseProcStat is the only /proc parsing this boundary does, and a comm field
// may legally contain spaces and parentheses. It is exercised on every
// platform, not only where /proc exists.
func TestParseProcStatReadsParentAndStartTime(t *testing.T) {
	// pid (comm) state ppid pgrp session ... starttime (field 22)
	fields := []string{
		"S", "4200", "4242", "4242", "0", "0", "0", "0", "0", "0",
		"0", "0", "0", "0", "0", "0", "1", "0", "0", "987654", "0", "0",
	}
	line := func(f []string) []byte {
		return []byte("4242 (comm) " + strings.Join(f, " ") + "\n")
	}
	row, ok := parseProcStat(4242, line(fields))
	if !ok {
		t.Fatal("a well-formed stat line must parse")
	}
	if row.pid != 4242 || row.ppid != 4200 || row.zombie {
		t.Fatalf("unexpected row: %+v", row)
	}
	if row.ident != processIdentity(987654) {
		t.Fatalf("start time token = %d, want 987654", row.ident)
	}

	// A comm containing parentheses and spaces must not shift the fields.
	weird := append([]byte(nil), line(fields)...)
	weird = bytes.Replace(weird, []byte("(comm)"), []byte("(we(ird) name)"), 1)
	row, ok = parseProcStat(4242, weird)
	if !ok || row.ppid != 4200 || row.ident != processIdentity(987654) {
		t.Fatalf("parenthesised comm parsed wrong: ok=%v row=%+v", ok, row)
	}

	zombie := append([]string(nil), fields...)
	// The comm is what carries the state for this parser: state is fields[0].
	zombie[0] = "Z"
	row, ok = parseProcStat(4242, line(zombie))
	if !ok || !row.zombie {
		t.Fatalf("state Z must be reported as a zombie: ok=%v row=%+v", ok, row)
	}

	badPPID := append([]string(nil), fields...)
	badPPID[1] = "x"
	badStart := append([]string(nil), fields...)
	badStart[19] = "notanumber"
	for name, malformed := range map[string][]byte{
		"empty":          {},
		"no-comm-parens": []byte("4242 no-parens S 4200 4242 4242\n"),
		"truncated":      line(fields[:4]),
		"bad-ppid":       line(badPPID),
		"bad-start-time": line(badStart),
	} {
		if _, ok := parseProcStat(4242, malformed); ok {
			t.Fatalf("%s stat line was accepted: %q", name, string(malformed))
		}
	}
}
