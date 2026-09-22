package harness

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"

	"github.com/i365dev/free4chat/agent/internal/types"
)

func opaqueSessionHash(sessionID string) string {
	if sessionID == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(sessionID))
	return hex.EncodeToString(sum[:6])
}

func (a *ACPAdapter) diagnosticSnapshot(lane int) types.HarnessLaneDiagnostic {
	a.mu.Lock()
	proc := a.proc
	closing := a.closing
	active := len(a.activeTurns) > 0
	activeScope := ""
	for _, turn := range a.activeTurns {
		if turn != nil && turn.scope != "" {
			activeScope = turn.scope
			break
		}
	}
	current := make(map[string]int64, 1+len(a.sessions)+len(a.retainedSessions))
	if a.sessionID != "" {
		current["room"] = a.sessionGeneration
	}
	for scope, session := range a.sessions {
		if session != nil && session.sessionID != "" {
			current[scope] = session.generation
		}
	}
	for scope, session := range a.retainedSessions {
		if _, exists := current[scope]; !exists && session.sessionID != "" {
			current[scope] = session.generation
		}
	}
	ids := make([]string, 0, len(current))
	for scope := range current {
		ids = append(ids, scope)
	}
	sort.Strings(ids)
	var scope string
	var generation int64
	if activeScope != "" {
		scope = activeScope
		generation = current[scope]
	} else if len(ids) > 0 {
		// Prefer a retained Task scope over the compatibility Room session so
		// a lane snapshot remains useful after a Task has been materialized.
		for _, candidate := range ids {
			if candidate != "room" {
				scope = candidate
				break
			}
		}
		if scope == "" {
			scope = ids[0]
		}
		generation = current[scope]
	}
	pid := 0
	if proc != nil && proc.cmd != nil && proc.cmd.Process != nil {
		pid = proc.cmd.Process.Pid
	}
	a.mu.Unlock()

	state := "idle"
	if proc != nil {
		state = "materialized"
		if active {
			state = "running"
		}
		if closing {
			state = "stopping"
		}
	} else if len(ids) > 0 {
		state = "reaped"
	}
	process := snapshotProviderProcess(pid)
	return types.HarnessLaneDiagnostic{
		Lane:              lane,
		State:             state,
		Scope:             scope,
		SessionHash:       sessionHashForScope(a, scope),
		SessionGeneration: generation,
		ProviderPID:       pid,
		ProcessGroupID:    process.pgid,
		ProviderAlive:     process.alive,
		DescendantCount:   process.descendants,
		RSSKB:             process.rssKB,
		TurnActive:        active,
	}
}

func sessionHashForScope(a *ACPAdapter, scope string) string {
	if scope == "" {
		return ""
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if scope == "room" {
		return opaqueSessionHash(a.sessionID)
	}
	if session := a.sessions[scope]; session != nil {
		return opaqueSessionHash(session.sessionID)
	}
	if session := a.retainedSessions[scope]; session.sessionID != "" {
		return opaqueSessionHash(session.sessionID)
	}
	return ""
}

func (a *ACPAdapter) DiagnosticsSnapshot() types.HarnessDiagnosticSnapshot {
	lane := a.diagnosticSnapshot(0)
	materialized := 0
	active := 0
	if lane.ProviderPID > 0 {
		materialized = 1
	}
	if lane.TurnActive {
		active = 1
	}
	provider := a.Name()
	a.mu.Lock()
	if a.options.ProviderSpec != "" {
		provider = a.options.ProviderSpec
	}
	a.mu.Unlock()
	return types.HarnessDiagnosticSnapshot{
		Provider:     provider,
		Capacity:     1,
		ActiveLanes:  active,
		Materialized: materialized,
		Lanes:        []types.HarnessLaneDiagnostic{lane},
	}
}

func (a *IsolatedACPAdapter) DiagnosticsSnapshot() types.HarnessDiagnosticSnapshot {
	lanes := make([]types.HarnessLaneDiagnostic, 0, len(a.lanes))
	active, materialized := 0, 0
	for lane, adapter := range a.lanes {
		if snapshotter, ok := adapter.(*ACPAdapter); ok {
			snapshot := snapshotter.diagnosticSnapshot(lane)
			lanes = append(lanes, snapshot)
			if snapshot.ProviderPID > 0 {
				materialized++
			}
			if snapshot.TurnActive {
				active++
			}
		}
	}
	provider := a.Name()
	if len(a.lanes) > 0 {
		if snapshotter, ok := a.lanes[0].(*ACPAdapter); ok {
			snapshot := snapshotter.DiagnosticsSnapshot()
			provider = snapshot.Provider
		}
	}
	return types.HarnessDiagnosticSnapshot{
		Provider:     provider,
		Capacity:     a.capacity,
		ActiveLanes:  active,
		Materialized: materialized,
		Lanes:        lanes,
	}
}

var _ types.HarnessDiagnostics = (*ACPAdapter)(nil)
var _ types.HarnessDiagnostics = (*IsolatedACPAdapter)(nil)
