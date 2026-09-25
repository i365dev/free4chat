package runtime

import (
	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Task identity retention (#473).
 *
 * Some Task facts must never change silently when a Task continues:
 *
 *   - the project a Task was explicitly started in (a fresh conversation may
 *     never quietly run in the default workspace);
 *   - the native session controls the Human selected for it (a fresh
 *     conversation may never quietly fall back to provider defaults);
 *   - an adopted native conversation (a Task the Human handed off may never
 *     quietly start a fresh conversation, and must fail closed once its
 *     conversation is gone).
 *
 * All three are keyed by Task, so keeping them forever would be exactly the
 * lifetime growth #473 exists to remove. Deleting them on a timer would be
 * worse: each one silently changes a Task's meaning.
 *
 * The resolution is that the ROOM already decides how long a Task can still
 * happen. A Task text/follow-up is delivered only while the Room retains that
 * Task's canonical collaboration request (`projectTaskEvent` fails closed for an
 * evicted request), and the Room's message log is bounded and temporary. So an
 * identity record is kept for every Task the Room can still trigger and pruned
 * exactly when the Room's retained window has moved past that Task's canonical
 * request: the bounds are the Room's own retention, the resident never grows a
 * lifetime map, and nothing is ever silently rewritten.
 *
 * Live scopes are exempt: a Task being worked on right now keeps its identity
 * even if its request has just aged out of the Room window, because the Task is
 * still live locally.
 *
 * One narrow Room exception is worth naming: a permission terminal envelope may
 * still be projected for a Task whose canonical request was evicted. It can
 * only exist for a permission this resident itself requested while that Task was
 * live (permission lifetimes are minutes), so the scope is live — and therefore
 * exempt — for the whole window in which such an envelope can arrive.
 */

// maxTaskIdentitiesBeforeSweep is a SWEEP THRESHOLD, not a memory bound: the
// resident only asks the Room for its retained window when it is holding more
// identities than one live window plus one released window. The actual bound is
// the Room's retained Task set, which is what the prune below enforces.
const maxTaskIdentitiesBeforeSweep = 2 * types.MaxLogicalTaskScopes

// taskIdentity is the resident-local identity of one Task. It is independent of
// whether that Task's conversation is currently materialized.
type taskIdentity struct {
	// requestSequence is the canonical Room sequence of this Task's first
	// delivered trigger. It is the ONLY fact that decides when the record may be
	// pruned: once the Room's retained window has moved past it, the Room can
	// never deliver another trigger for this Task. Zero means "unknown", and an
	// unknown record is never pruned.
	requestSequence int64
	// projectCwd is the exact project this Task was started in. Empty means the
	// Resident's default workspace, which is the ordinary Task path.
	projectCwd string
	// modeID and configOptions are the native Harness controls the Human
	// selected for this Task.
	modeID        string
	configOptions map[string]string
	// adopted marks a Task bound to a native conversation the Human handed off.
	// adoptedLost marks that conversation as gone: such a Task fails closed
	// instead of ever starting a fresh conversation.
	adopted     bool
	adoptedLost bool
}

// taskIdentityLocked returns the identity record of one scope, or nil when the
// resident holds none. Callers must hold r.mu.
func (r *ResidentRuntime) taskIdentityLocked(scope string) *taskIdentity {
	if r.taskIdentities == nil {
		return nil
	}
	return r.taskIdentities[scope]
}

// recordTaskIdentityLocked returns the identity record of one Task, creating it
// with the scope's canonical request sequence when absent. Callers must hold
// r.mu.
func (r *ResidentRuntime) recordTaskIdentityLocked(scope string) *taskIdentity {
	if r.taskIdentities == nil {
		r.taskIdentities = make(map[string]*taskIdentity)
	}
	if identity := r.taskIdentities[scope]; identity != nil {
		return identity
	}
	identity := &taskIdentity{}
	if state := r.scopedSessions[scope]; state != nil {
		identity.requestSequence = state.admittedSequence
	}
	r.taskIdentities[scope] = identity
	return identity
}

// taskProjectCwdLocked reports the exact project bound to one Task. Callers
// must hold r.mu.
func (r *ResidentRuntime) taskProjectCwdLocked(scope string) (string, bool) {
	identity := r.taskIdentityLocked(scope)
	if identity == nil || identity.projectCwd == "" {
		return "", false
	}
	return identity.projectCwd, true
}

// taskSessionControlsLocked snapshots the native controls selected for one
// Task. Callers must hold r.mu.
func (r *ResidentRuntime) taskSessionControlsLocked(scope string) (string, map[string]string) {
	identity := r.taskIdentityLocked(scope)
	if identity == nil {
		return "", nil
	}
	return identity.modeID, cloneNativeControlSelections(identity.configOptions)
}

// pruneUnreachableTaskIdentities asks the Room for its retained window and
// drops the identity records of Tasks the Room can no longer trigger. A narrow
// race is possible and harmless: a Task whose canonical request is evicted
// between this read and the next trigger keeps its record one sweep longer.
func (r *ResidentRuntime) pruneUnreachableTaskIdentities() {
	r.mu.Lock()
	held := len(r.taskIdentities)
	r.mu.Unlock()
	if held <= maxTaskIdentitiesBeforeSweep {
		return
	}
	client, ok := r.options.Client.(types.RoomContextClient)
	if !ok {
		return
	}
	handle, err := r.requireHandle()
	if err != nil {
		return
	}
	// One bounded read is all this needs: the Room's window reports the oldest
	// retained sequence, and nothing below it can reach this resident again.
	context, err := client.ReadRoomContext(handle, types.RoomContextReadOptions{Limit: 1})
	if err != nil {
		return
	}
	floor := context.Room.OldestSequence
	if floor <= 0 {
		return
	}
	if pruned := r.pruneTaskIdentitiesBelow(floor); pruned > 0 {
		r.log("task_identity_pruned", map[string]string{"reason": "room_retention"})
	}
}

// pruneTaskIdentitiesBelow drops identity records whose canonical request is no
// longer retained by the Room. Live scopes and undated records are kept.
func (r *ResidentRuntime) pruneTaskIdentitiesBelow(floor int64) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	pruned := 0
	for scope, identity := range r.taskIdentities {
		if identity == nil || identity.requestSequence <= 0 || identity.requestSequence >= floor {
			continue
		}
		if _, live := r.scopedSessions[scope]; live {
			continue
		}
		delete(r.taskIdentities, scope)
		pruned++
	}
	return pruned
}

// taskIdentityCount reports how many Task identity records the resident holds.
// It exists for bounded-state assertions.
func (r *ResidentRuntime) taskIdentityCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.taskIdentities)
}
