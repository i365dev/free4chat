package runtime

import (
	"strings"

	"github.com/i365dev/free4chat/agent/internal/free4chat"
	"github.com/i365dev/free4chat/agent/internal/harness"
	"github.com/i365dev/free4chat/agent/internal/types"
)

// configureActivityHandler connects the optional generic ACP projection
// without changing the mandatory HarnessAdapter contract. Unexpected Harness
// death also clears the public projection and fails closed for media.
func configureActivityHandler(r *ResidentRuntime) {
	if r.options.Adapter == nil {
		return
	}
	if setter, ok := r.options.Adapter.(interface {
		SetActivityHandler(harness.ACPActivityHandler)
	}); ok {
		setter.SetActivityHandler(r.observeHarnessActivity)
	}
	r.options.Adapter.OnFailure(func(error) {
		r.clearActivity()
		r.failClosedResidentMediaState()
	})
}

func validActivityScope(scope string) bool {
	scope = normalizeScope(scope)
	if scope == roomScope {
		return true
	}
	return strings.HasPrefix(scope, "task:") && len(strings.TrimPrefix(scope, "task:")) >= 4
}

func (r *ResidentRuntime) publishActivity(scope string, state types.AgentActivityState) {
	client, ok := r.options.Client.(types.ResidentActivityClient)
	if !ok {
		return
	}
	handle := r.currentHandle()
	if handle == "" {
		return
	}
	if err := client.UpdateAgentActivity(handle, scope, state); err != nil {
		r.log("agent_activity_update_failed", map[string]string{
			"reason": string(free4chat.CodeOf(err)),
		})
	}
}

// beginActivity is called at the serialized prompt admission boundary. The
// local map suppresses repeated normalized ACP chunks before they can become
// HTTP requests, DO broadcasts, or writes.
func (r *ResidentRuntime) beginActivity(scope string) {
	if !validActivityScope(scope) {
		return
	}
	r.activityMu.Lock()
	r.activityTurnActive = true
	r.activityScope = scope
	previous, existed := r.activities[scope]
	if existed && previous == types.AgentActivityWorking {
		r.activityMu.Unlock()
		return
	}
	r.activities[scope] = types.AgentActivityWorking
	r.activityMu.Unlock()
	r.publishActivity(scope, types.AgentActivityWorking)
}

// observeHarnessActivity accepts normalized events only while the adapter's
// current serialized prompt is active. It therefore ignores late events from
// a settled/cancelled turn and cannot resurrect a cleared state.
func (r *ResidentRuntime) observeHarnessActivity(scope string, state types.AgentActivityState) {
	if !validActivityScope(scope) || !state.Valid() {
		return
	}
	r.activityMu.Lock()
	if !r.activityTurnActive || r.activityScope != scope {
		r.activityMu.Unlock()
		return
	}
	if r.activities[scope] == state {
		r.activityMu.Unlock()
		return
	}
	r.activities[scope] = state
	r.activityMu.Unlock()
	r.publishActivity(scope, state)
}

func (r *ResidentRuntime) finishActivity(scope string) {
	if !validActivityScope(scope) {
		return
	}
	r.activityMu.Lock()
	if r.activityScope == scope {
		r.activityTurnActive = false
		r.activityScope = ""
	}
	_, existed := r.activities[scope]
	delete(r.activities, scope)
	r.activityMu.Unlock()
	if existed {
		r.publishActivity(scope, "")
	}
}

// clearActivity is best-effort externally but authoritative locally. It is
// used on stop, Harness failure, and resident transport loss. The server also
// clears the same projection when the authenticated resident socket closes.
func (r *ResidentRuntime) clearActivity() {
	r.activityMu.Lock()
	entries := make([]string, 0, len(r.activities))
	for scope := range r.activities {
		entries = append(entries, scope)
	}
	r.activities = make(map[string]types.AgentActivityState)
	r.activityTurnActive = false
	r.activityScope = ""
	r.activityMu.Unlock()
	for _, scope := range entries {
		r.publishActivity(scope, "")
	}
}

func (r *ResidentRuntime) resetActivityLocal() {
	r.activityMu.Lock()
	r.activities = make(map[string]types.AgentActivityState)
	r.activityTurnActive = false
	r.activityScope = ""
	r.activityMu.Unlock()
}
