//go:build linux

package harness

import (
	"bytes"
	"os"
	"strconv"
	"strings"
)

// testProcessParent reads the parent pid straight from /proc. It is
// deliberately independent of the implementation under test, so a broken
// ownership sweep cannot make its own regression pass.
func testProcessParent(pid int) (int, bool) {
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0, false
	}
	closing := bytes.LastIndexByte(raw, ')')
	if closing < 0 || closing+2 >= len(raw) {
		return 0, false
	}
	fields := strings.Fields(string(raw[closing+2:]))
	if len(fields) < 2 {
		return 0, false
	}
	parent, convErr := strconv.Atoi(fields[1])
	if convErr != nil {
		return 0, false
	}
	return parent, true
}
