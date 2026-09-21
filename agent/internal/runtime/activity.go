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
	markFailure := func(scopes []string, _ error) {
		// Unexpected Harness process death is the ONE boundary that means a
		// Task's retained Harness session is gone. Room/resident transport
		// reconnects are not session loss and must never publish it. An adopted
		// Task additionally stops being eligible for a fresh session.
		if scopes == nil {
			r.noteAdoptedScopeLoss()
			r.noteTaskSessionLoss()
			r.clearActivity()
			r.failClosedResidentMediaState()
			return
		}
		failed := make(map[string]struct{}, len(scopes))
		roomFailed := false
		for _, scope := range scopes {
			scope = normalizeScope(scope)
			failed[scope] = struct{}{}
			if scope == roomScope {
				roomFailed = true
			}
		}
		r.noteAdoptedScopeLossFor(failed)
		r.noteTaskSessionLossFor(failed)
		r.clearActivityFor(failed)
		if roomFailed {
			r.failClosedResidentMediaState()
		}
	}
	if notifier, ok := r.options.Adapter.(types.ScopedAdapterFailureNotifier); ok {
		notifier.OnScopedFailure(markFailure)
	} else {
		r.options.Adapter.OnFailure(func(err error) { markFailure(nil, err) })
	}
}

func validActivityScope(scope string) bool {
	scope = normalizeScope(scope)
	if scope == roomScope {
		return true
	}
	return strings.HasPrefix(scope, "task:") && len(strings.TrimPrefix(scope, "task:")) >= 4
}

// activityTurnState is the locally retained activity of one logical scope,
// together with the exact canonical Room turn it belongs to. The pair is what
// makes a remote interrupt exact: a Task scope alone cannot distinguish two
// consecutive turns of the same Task.
type activityTurnState struct {
	state    types.AgentActivityState
	sequence int64
}

type activityPublication struct {
	handle       string
	state        types.AgentActivityState
	turnSequence int64
}

// publishActivity enqueues only the newest state for each scope. It is called
// from the ACP reader and serialized turn path, so it must never wait for
// Room/HTTP I/O. turnSequence is transient control correlation: it is never
// persisted, never rendered into a Harness prompt, and never reaches ACP.
func (r *ResidentRuntime) publishActivity(scope string, state types.AgentActivityState, turnSequence int64) {
	handle := r.currentHandle()
	if handle == "" {
		return
	}
	r.activityPublishMu.Lock()
	if r.activityPublishQueue == nil {
		r.activityPublishQueue = make(map[string]activityPublication)
	}
	r.activityPublishQueue[scope] = activityPublication{
		handle:       handle,
		state:        state,
		turnSequence: turnSequence,
	}
	if r.activityPublisherActive {
		r.activityPublishMu.Unlock()
		return
	}
	r.activityPublisherActive = true
	r.activityPublishMu.Unlock()
	go r.drainActivityPublications()
}

// drainActivityPublications is deliberately a small, per-Runtime publisher,
// not a general event bus. A single sender preserves application order for a
// scope: if an old state is already in flight, a later clear waits behind it;
// if it is still queued, latest-state replacement removes it. Thus a final
// clear cannot be overtaken by stale Working/Thinking network traffic.
func (r *ResidentRuntime) drainActivityPublications() {
	for {
		r.activityPublishMu.Lock()
		if len(r.activityPublishQueue) == 0 {
			r.activityPublisherActive = false
			r.activityPublishMu.Unlock()
			return
		}
		var scope string
		var publication activityPublication
		for queuedScope, queuedPublication := range r.activityPublishQueue {
			scope, publication = queuedScope, queuedPublication
			break
		}
		delete(r.activityPublishQueue, scope)
		r.activityPublishMu.Unlock()
		r.publishActivityNow(publication.handle, scope, publication.state, publication.turnSequence)
	}
}

func (r *ResidentRuntime) publishActivityNow(handle, scope string, state types.AgentActivityState, turnSequence int64) {
	client, ok := r.options.Client.(types.ResidentActivityClient)
	if !ok {
		return
	}
	if err := client.UpdateAgentActivity(handle, scope, state, turnSequence); err != nil {
		r.log("agent_activity_update_failed", map[string]string{
			"reason": string(free4chat.CodeOf(err)),
		})
	}
}

// beginActivity is called at the prompt admission boundary of ONE logical
// scope. It atomically replaces that scope's active turn identity with the
// exact canonical Room sequence this turn runs for (turnControlMu), and
// publishes the same sequence with the transient activity so the browser can
// bind an interrupt to the exact turn it is looking at.
//
// The identity is stored per scope, which is what makes a concurrent turn of
// an INDEPENDENT Task unable to observe, replace, or clear it (#421).
func (r *ResidentRuntime) beginActivity(scope string, turnSequence int64) {
	if !validActivityScope(scope) || turnSequence <= 0 {
		return
	}
	r.turnControlMu.Lock()
	r.activityMu.Lock()
	previous, existed := r.activities[scope]
	unchanged := existed && previous.state == types.AgentActivityWorking &&
		previous.sequence == turnSequence
	if !unchanged {
		r.activities[scope] = activityTurnState{
			state:    types.AgentActivityWorking,
			sequence: turnSequence,
		}
	}
	r.activityMu.Unlock()
	r.turnControlMu.Unlock()
	// This helper owns AgentActivity ONLY. The Task execution lifecycle is
	// owned by the serialized turn pipeline (drainTurns), which calls
	// beginTaskTurn/finishTaskTurn explicitly for the same exact turn.
	if unchanged {
		return
	}
	r.publishActivity(scope, types.AgentActivityWorking, turnSequence)
}

// observeHarnessActivity accepts normalized events only while THAT scope's
// prompt is active. It therefore ignores late events from a settled or
// cancelled turn, cannot resurrect a cleared state, and cannot attribute one
// Task's activity to another. Every state of one turn keeps that turn's exact
// sequence.
func (r *ResidentRuntime) observeHarnessActivity(scope string, state types.AgentActivityState) {
	if !validActivityScope(scope) || !state.Valid() {
		return
	}
	r.activityMu.Lock()
	current, active := r.activities[scope]
	if !active {
		r.activityMu.Unlock()
		return
	}
	turnSequence := current.sequence
	if current.state == state {
		r.activityMu.Unlock()
		return
	}
	r.activities[scope] = activityTurnState{state: state, sequence: turnSequence}
	r.activityMu.Unlock()
	r.publishActivity(scope, state, turnSequence)
}

// finishActivity clears the active turn identity of exactly this turn. Taking
// turnControlMu here is what makes the interrupt dispatch atomic: a remote
// control that already passed its exact-turn check finishes dispatching before
// this transition can clear the identity, and a control that arrives after the
// transition sees no matching turn at all.
func (r *ResidentRuntime) finishActivity(scope string, turnSequence int64) {
	if !validActivityScope(scope) {
		return
	}
	r.turnControlMu.Lock()
	r.activityMu.Lock()
	// Only THIS scope's identity is cleared, and only when it still describes
	// THIS exact turn: a concurrent Task's activity is untouched.
	if current, ok := r.activities[scope]; ok && current.sequence == turnSequence {
		delete(r.activities, scope)
		// Both locks are already held here; use the non-locking inner variant.
		r.clearTurnInterruptedActivityLocked(scope, turnSequence)
	}
	r.activityMu.Unlock()
	r.turnControlMu.Unlock()
	r.publishActivity(scope, "", 0)
}

// activeTurnOf reports the exact canonical turn this Runtime is executing for
// one scope, and whether it is executing one at all.
func (r *ResidentRuntime) activeTurnOf(scope string) (int64, bool) {
	r.activityMu.Lock()
	defer r.activityMu.Unlock()
	current, ok := r.activities[scope]
	if !ok {
		return 0, false
	}
	return current.sequence, true
}

// clearActivity is best-effort externally but authoritative locally. It is
// used on stop, Harness failure, and resident transport loss. The server also
// clears the same projection when the authenticated resident socket closes.
func (r *ResidentRuntime) clearActivity() {
	r.turnControlMu.Lock()
	r.activityMu.Lock()
	entries := make([]string, 0, len(r.activities))
	for scope := range r.activities {
		entries = append(entries, scope)
	}
	r.activities = make(map[string]activityTurnState)
	// A cleared transport boundary drops every interrupt marker with the turn
	// identity it described. With concurrency there may be several, so this is
	// a whole-map reset rather than the single marker the serial model kept.
	r.interrupts = make(map[string]int64)
	r.activityMu.Unlock()
	r.turnControlMu.Unlock()
	for _, scope := range entries {
		r.publishActivity(scope, "", 0)
	}
}

// clearActivityFor resets only projections owned by provider processes that
// failed. A healthy isolated lane keeps its current turn and interrupt state.
func (r *ResidentRuntime) clearActivityFor(failed map[string]struct{}) {
	if len(failed) == 0 {
		return
	}
	r.turnControlMu.Lock()
	r.activityMu.Lock()
	var entries []string
	for scope := range failed {
		if _, ok := r.activities[scope]; ok {
			entries = append(entries, scope)
			delete(r.activities, scope)
		}
		delete(r.interrupts, scope)
	}
	r.activityMu.Unlock()
	r.turnControlMu.Unlock()
	for _, scope := range entries {
		r.publishActivity(scope, "", 0)
	}
}

func (r *ResidentRuntime) resetActivityLocal() {
	r.turnControlMu.Lock()
	r.activityMu.Lock()
	r.activities = make(map[string]activityTurnState)
	r.interrupts = make(map[string]int64)
	r.activityMu.Unlock()
	r.turnControlMu.Unlock()
	r.activityPublishMu.Lock()
	// A normal resident stream reconnect keeps the same participant handle.
	// Preserve a queued clear behind any in-flight publication so the old
	// state cannot be resurrected after the server has fail-closed it. Any
	// queued non-empty state is stale at this boundary and must not be replayed.
	for scope, publication := range r.activityPublishQueue {
		if publication.state != "" {
			delete(r.activityPublishQueue, scope)
		}
	}
	r.activityPublishMu.Unlock()
}
