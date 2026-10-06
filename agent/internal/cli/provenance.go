package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/i365dev/free4chat/agent/internal/daemon"
	"github.com/i365dev/free4chat/agent/internal/doctor"
)

type provenanceReport struct {
	Schema   int                  `json:"schema"`
	Decision string               `json:"decision"`
	CLI      provenanceCLI        `json:"cli"`
	Daemon   provenanceDaemon     `json:"daemon"`
	Selected *provenanceSelection `json:"selected,omitempty"`
}

type provenanceCLI struct {
	BinaryName          string `json:"binaryName"`
	Version             string `json:"daemonVersion"`
	BuildIdentity       string `json:"buildIdentity,omitempty"`
	RuntimeRootIdentity string `json:"runtimeRootIdentity,omitempty"`
}

type provenanceDaemon struct {
	Reachable           bool   `json:"reachable"`
	DaemonVersion       string `json:"daemonVersion,omitempty"`
	BuildIdentity       string `json:"buildIdentity,omitempty"`
	RuntimeRootIdentity string `json:"runtimeRootIdentity,omitempty"`
	ResidentCount       int    `json:"residentCount"`
}

type provenanceSelection struct {
	Kind                string `json:"kind"`
	Matched             bool   `json:"matched"`
	MatchCount          int    `json:"matchCount"`
	RuntimeRootIdentity string `json:"runtimeRootIdentity,omitempty"`
	RuntimeHostID       string `json:"runtimeHostId,omitempty"`
}

// runProvenance is a bounded local preflight. Selector values are
// used only for matching and are never echoed; the returned status projection
// is deliberately allow-listed to exclude participant IDs and capabilities.
func runProvenance(args []string) error {
	instanceID, roomID, err := parseProvenanceArgs(args)
	if err != nil {
		return err
	}
	localRoot, rootErr := daemon.RuntimeRootIdentity()
	report := provenanceReport{
		Schema:   1,
		Decision: "ambiguous",
		CLI: provenanceCLI{
			BinaryName:          filepath.Base(os.Args[0]),
			Version:             doctor.Version,
			BuildIdentity:       doctor.BuildIdentity(),
			RuntimeRootIdentity: localRoot,
		},
	}
	if rootErr != nil {
		return printJSON(report)
	}

	infoRaw, err := daemon.SendIPC(&daemon.IpcRequest{Op: "daemon-info"})
	if err != nil {
		return printJSON(report)
	}
	var info daemon.DaemonInfo
	if err := json.Unmarshal(infoRaw, &info); err != nil {
		return printJSON(report)
	}
	report.Daemon = provenanceDaemon{
		Reachable:           true,
		DaemonVersion:       info.DaemonVersion,
		BuildIdentity:       info.BuildIdentity,
		RuntimeRootIdentity: info.RuntimeRootIdentity,
		ResidentCount:       info.ResidentCount,
	}

	var instances []map[string]any
	statusRaw, statusErr := daemon.SendIPC(&daemon.IpcRequest{Op: "status"})
	if statusErr == nil {
		if value, decodeErr := decodeAny(statusRaw); decodeErr == nil {
			if list, ok := value.([]any); ok {
				for _, item := range list {
					if record, ok := item.(map[string]any); ok {
						instances = append(instances, record)
					}
				}
			} else {
				statusErr = fmt.Errorf("invalid status projection")
			}
		} else {
			statusErr = decodeErr
		}
	}

	switch {
	case info.DaemonVersion != doctor.Version:
		report.Decision = "mismatch"
	case info.RuntimeRootIdentity == "" || info.RuntimeRootIdentity != localRoot:
		report.Decision = "mismatch"
	case doctor.BuildIdentity() != "" && info.BuildIdentity != "" && doctor.BuildIdentity() != info.BuildIdentity:
		report.Decision = "mismatch"
	case doctor.BuildIdentity() == "" || info.BuildIdentity == "":
		report.Decision = "ambiguous"
	case statusErr != nil || len(instances) != info.ResidentCount:
		report.Decision = "ambiguous"
	default:
		report.Decision = "valid"
	}

	if instanceID != "" || roomID != "" {
		selection := &provenanceSelection{Kind: "instance"}
		if roomID != "" {
			selection.Kind = "room"
		}
		for _, instance := range instances {
			matches := false
			if instanceID != "" {
				matches = stringField(instance, "instanceId") == instanceID
			} else {
				matches = stringField(instance, "roomId") == roomID
			}
			if matches {
				selection.MatchCount++
				selection.RuntimeHostID = stringField(instance, "runtimeHostId")
			}
		}
		selection.Matched = selection.MatchCount == 1
		if selection.Matched {
			selection.RuntimeRootIdentity = info.RuntimeRootIdentity
		} else if report.Decision == "valid" {
			if selection.MatchCount == 0 {
				report.Decision = "mismatch"
			} else {
				report.Decision = "ambiguous"
			}
		}
		report.Selected = selection
	}
	return printJSON(report)
}

func parseProvenanceArgs(args []string) (instanceID, roomID string, err error) {
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--instance":
			if instanceID != "" || i+1 >= len(args) || strings.HasPrefix(args[i+1], "--") {
				return "", "", errUsage()
			}
			instanceID = args[i+1]
			i++
		case "--room":
			if roomID != "" || i+1 >= len(args) || strings.HasPrefix(args[i+1], "--") {
				return "", "", errUsage()
			}
			roomID = args[i+1]
			i++
		case "--json":
		default:
			return "", "", errUsage()
		}
	}
	if instanceID != "" && roomID != "" {
		return "", "", errUsage()
	}
	return instanceID, roomID, nil
}

func stringField(record map[string]any, key string) string {
	value, _ := record[key].(string)
	return value
}
