package doctor

import (
	"runtime/debug"
	"testing"
)

func TestBuildIdentityUsesDeterministicVCSRevision(t *testing.T) {
	buildInfo := &debug.BuildInfo{Settings: []debug.BuildSetting{
		{Key: "vcs.revision", Value: "0123456789abcdef0123456789abcdef01234567"},
		{Key: "vcs.modified", Value: "false"},
	}}
	first := BuildIdentityFromBuildInfo(buildInfo)
	second := BuildIdentityFromBuildInfo(buildInfo)
	if first != second || first != "git:0123456789abcdef0123456789abcdef01234567" {
		t.Fatalf("clean source identity must be deterministic: %q / %q", first, second)
	}
	buildInfo.Settings[0].Value = "abcdef0123456789abcdef0123456789abcdef01"
	if different := BuildIdentityFromBuildInfo(buildInfo); different == first {
		t.Fatalf("different source revisions must have different identities: %q", different)
	}
	buildInfo.Settings[0].Value = "0123456789abcdef0123456789abcdef01234567"
	buildInfo.Settings[1].Value = "true"
	if dirty := BuildIdentityFromBuildInfo(buildInfo); dirty != first+":dirty" {
		t.Fatalf("modified build should have a deterministic dirty marker: %q", dirty)
	}
}

func TestBuildIdentityIsUnavailableWithoutReliableRevision(t *testing.T) {
	for _, info := range []*debug.BuildInfo{
		nil,
		{Settings: []debug.BuildSetting{{Key: "vcs.modified", Value: "false"}}},
		{Settings: []debug.BuildSetting{{Key: "vcs.revision", Value: "not-a-revision"}}},
	} {
		if got := BuildIdentityFromBuildInfo(info); got != "" {
			t.Fatalf("unreliable source metadata must remain unknown, got %q", got)
		}
	}
}
