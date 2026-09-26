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

// laneProcessTree is the ownership walk itself: it must reach grandchildren,
// keep every process's own identity token, and never include a zombie (already
// stopped) or the provider it started from.
func TestLaneProcessTreeWalksDescendantsAndDropsZombies(t *testing.T) {
	rows := []processRow{
		{pid: 10, ppid: 1, ident: 1000},
		{pid: 20, ppid: 10, ident: 2000}, // tool runner
		{pid: 21, ppid: 20, ident: 2100}, // tool (grandchild)
		{pid: 22, ppid: 20, ident: 2200, zombie: true},
		{pid: 30, ppid: 1, ident: 3000}, // unrelated process
	}
	owned := laneProcessTree(rows, 10)
	if len(owned) != 2 {
		t.Fatalf("expected the runner and the tool, got %+v", owned)
	}
	if owned[0].pid != 20 || owned[0].ident != processIdentity(2000) {
		t.Fatalf("runner identity lost: %+v", owned[0])
	}
	if owned[1].pid != 21 || owned[1].ident != processIdentity(2100) {
		t.Fatalf("grandchild identity lost: %+v", owned[1])
	}
	if laneProcessTree(rows, 1) != nil {
		t.Fatal("an invalid root must own nothing")
	}
}

// Ownership is known only when every read succeeded: one unreadable table means
// the lane cannot prove what it owned at that moment, so the merged result must
// stay unknown even if the other read worked.
func TestLaneOwnershipMergeFailsClosedWhenEitherReadIsUnknown(t *testing.T) {
	known := laneOwnership{processes: []laneProcess{{pid: 20, ident: 2000}}, known: true}
	other := laneOwnership{processes: []laneProcess{{pid: 21, ident: 2100}, {pid: 20, ident: 2000}}, known: true}
	merged := known.merge(other)
	if !merged.known || len(merged.processes) != 2 {
		t.Fatalf("a union of two known reads must keep both processes once: %+v", merged)
	}

	unknown := laneOwnership{}
	if merged.merge(unknown).known {
		t.Fatal("a failed read must make the merged ownership unknown")
	}
	if unknown.merge(merged).known {
		t.Fatal("a failed read must make the merged ownership unknown in either order")
	}
}
