package cli

import (
	"strings"

	"github.com/i365dev/free4chat/agent/internal/daemon"
)

/*
 * `free4chat-agent handoff` (#409 V1).
 *
 * Local terminal UX for cold Pi-session handoff. Everything here is local: the
 * ACP session identity is printed to this terminal or accepted from it, and the
 * daemon routes the request to exactly one resident Runtime. Nothing in this
 * file reaches the Room, the browser, status, workspace files, or logs.
 */

func runHandoff(args []string) error {
	list := hasFlag(args, "--list")
	status := hasFlag(args, "--status")
	clear := hasFlag(args, "--clear")
	adopt := option(args, "--adopt")
	selected := 0
	for _, set := range []bool{list, status, clear, adopt != ""} {
		if set {
			selected++
		}
	}
	if selected != 1 {
		return errUsage()
	}
	instanceID := option(args, "--instance")

	switch {
	case list:
		return runViaDaemon(&daemon.IpcRequest{
			Op:            "handoff-list",
			InstanceID:    instanceID,
			SessionCwd:    option(args, "--cwd"),
			SessionCursor: option(args, "--cursor"),
		})
	case status:
		return runViaDaemon(&daemon.IpcRequest{Op: "handoff-state", InstanceID: instanceID})
	case clear:
		return runViaDaemon(&daemon.IpcRequest{Op: "handoff-clear", InstanceID: instanceID})
	default:
		sessionID := strings.TrimSpace(adopt)
		if sessionID == "" {
			return errUsage()
		}
		return runViaDaemon(&daemon.IpcRequest{
			Op:                 "handoff-adopt",
			InstanceID:         instanceID,
			SessionID:          sessionID,
			SessionCwd:         option(args, "--cwd"),
			HumanParticipantID: option(args, "--human"),
		})
	}
}
