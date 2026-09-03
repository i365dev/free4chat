package cli

import "testing"

// #228: human-readable participation age rendering.
func TestFormatParticipation(t *testing.T) {
	cases := map[int64]string{
		0:          "0s",
		42_000:     "42s",
		59_000:     "59s",
		60_000:     "1m 0s",
		312_000:    "5m 12s",
		4_620_000:  "1h 17m",
		93_780_000: "26h 3m",
	}
	for millis, want := range cases {
		if got := formatParticipation(millis); got != want {
			t.Fatalf("formatParticipation(%d) = %q, want %q", millis, got, want)
		}
	}
}
