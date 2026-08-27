package cli

import (
	"encoding/json"
	"os"
	"strings"

	"github.com/i365dev/free4chat/agent/internal/daemon"
	"github.com/i365dev/free4chat/agent/internal/doctor"
	"github.com/i365dev/free4chat/agent/internal/speech"
)

// ReadinessReport is the Go runtime readiness projection. Media and speech
// are reported honestly: Pion is compiled in-process (available), while
// speech distinguishes provider configuration from a live room grant (the
// grant is room state, never claimed locally).
type ReadinessReport struct {
	Runtime map[string]any            `json:"runtime"`
	Media   map[string]any            `json:"media"`
	Speech  map[string]map[string]any `json:"speech"`
	Harness map[string]any            `json:"harness,omitempty"`
	Room    map[string]any            `json:"room,omitempty"`
}

func runReadiness(args []string) error {
	speechConfig := speech.LoadConfig(daemon.RuntimeDirectory(), os.Getenv)
	report := ReadinessReport{
		Runtime: map[string]any{
			"ready":   true,
			"runtime": "go",
			"version": doctor.Version,
		},
		Media: map[string]any{
			"engine":    "pion",
			"supported": true,
			"ready":     true,
		},
		Speech: map[string]map[string]any{
			"stt": {
				"provider":   "doubao",
				"configured": speechConfig.STTEnabled,
				"ready":      speechConfig.STTEnabled,
			},
			"tts": {
				"provider":   "doubao",
				"configured": speechConfig.TTSEnabled,
				"ready":      speechConfig.TTSEnabled,
			},
		},
	}

	if agentID := option(args, "--agent"); agentID != "" {
		for _, launcher := range doctor.Collect().Launchers {
			if launcher.ID == agentID {
				harnessView := map[string]any{"id": launcher.ID, "ready": launcher.Ready}
				if launcher.Note != "" {
					harnessView["note"] = launcher.Note
				}
				report.Harness = harnessView
				break
			}
		}
	}

	if roomID := option(args, "--room"); roomID != "" {
		var instances []map[string]any
		if err := daemon.EnsureDaemon(); err == nil {
			if result, ipcErr := daemon.SendIPC(&daemon.IpcRequest{Op: "status"}); ipcErr == nil {
				decoded, marshalErr := decodeAny(result)
				if marshalErr == nil {
					if list, ok := decoded.([]any); ok {
						for _, item := range list {
							if record, ok := item.(map[string]any); ok {
								instances = append(instances, record)
							}
						}
					}
				}
			}
		}
		report.Room = roomReadiness(roomID, instances)
	}

	return printJSON(report)
}

// roomReadiness projects daemon status into per-room readiness, matching the
// Node projection shape.
func roomReadiness(roomID string, instances []map[string]any) map[string]any {
	for _, instance := range instances {
		if instanceRoom, _ := instance["roomId"].(string); instanceRoom == roomID {
			view := map[string]any{"joined": true, "roomId": roomID}
			if id, ok := instance["instanceId"].(string); ok && id != "" {
				view["instanceId"] = id
			}
			if pid, ok := instance["participantId"].(string); ok && pid != "" {
				view["participantId"] = pid
			}
			return view
		}
	}
	return map[string]any{"joined": false, "roomId": roomID, "reason": "not_joined"}
}

// decodeAny decodes raw JSON preserving number fidelity via json.Number.
func decodeAny(raw json.RawMessage) (any, error) {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var doc any
	if err := dec.Decode(&doc); err != nil {
		return nil, err
	}
	return doc, nil
}
