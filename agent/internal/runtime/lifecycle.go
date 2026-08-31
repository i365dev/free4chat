package runtime

import "github.com/i365dev/free4chat/agent/internal/types"

const lifecycleLeaveFailureText = "I couldn't leave the Room; I'm still connected."

// handleLifecycleIntent consumes the closed local Harness control intent
// before arbitrary Harness body text can be published. It returns true when
// the result was lifecycle-shaped, including rejected and failed paths, so a
// model can never turn its own unverified wording into a successful-leave
// claim while this participant remains resident.
func (r *ResidentRuntime) handleLifecycleIntent(
	input *types.HarnessTurnInput,
	result types.HarnessTurnResult,
) bool {
	if result.LifecycleIntent == types.LifecycleIntentNone {
		return false
	}
	// Treat unknown future strings and ambiguous custom-adapter results as
	// fail-closed local controls. Only this release's exact leave value may
	// proceed, and it must never be combined with conversational targeting.
	if result.LifecycleIntent != types.LifecycleIntentLeave ||
		len(result.TargetParticipantIDs) != 0 || !hasAddressedHuman(input) {
		r.log("lifecycle_leave_failed", nil)
		r.publishLifecycleLeaveFailure()
		return true
	}

	r.log("lifecycle_leave_requested", nil)
	handle, err := r.requireHandle()
	if err != nil {
		r.log("lifecycle_leave_failed", nil)
		r.publishLifecycleLeaveFailure()
		return true
	}
	// This is the authoritative successful-leave boundary. Normal Stop keeps
	// its best-effort LeaveRoom semantics for operator shutdown, but a Harness
	// lifecycle claim is accepted only after this call confirms success.
	if err := r.options.Client.LeaveRoom(handle); err != nil {
		r.log("lifecycle_leave_failed", nil)
		r.publishLifecycleLeaveFailure()
		return true
	}

	if !r.beginStop("") {
		// Another terminal owner already took over. In particular, never emit a
		// delayed Harness body after a concurrent operator stop.
		return true
	}
	// Do not let the later host-owned Stop perform a second best-effort leave.
	// Clearing this private capability also makes rejoin impossible because the
	// terminal state has already closed stopCh before the wait loop can retry.
	r.mu.Lock()
	r.participantHandle = ""
	r.participantID = ""
	r.mu.Unlock()
	r.log("lifecycle_leave_completed", nil)

	if r.options.OnSelfLeave != nil {
		// The daemon implementation schedules Stop/unregister/workspace cleanup
		// in another goroutine. Calling blocking Stop here would self-wait on
		// this wait-loop goroutine through loopWG.
		r.options.OnSelfLeave()
	} else {
		// Standalone Runtime users still receive bounded cleanup without a
		// daemon, while preserving the same no-self-wait ordering.
		go r.Stop()
	}
	return true
}

// hasAddressedHuman is the hard structural gate for the one lifecycle action:
// unaddressed Room context, Agent-authored text, transcript content, and
// attachment content cannot create this authority.
func hasAddressedHuman(input *types.HarnessTurnInput) bool {
	if input == nil {
		return false
	}
	for _, event := range input.Events {
		if event.Addressed && event.Kind == types.KindHuman {
			return true
		}
	}
	return false
}

// publishLifecycleLeaveFailure uses Runtime-owned fixed truth rather than any
// model-supplied body. Failure keeps the resident, handle, and reconnect path
// live; a send failure is diagnostic-only and never becomes a success claim.
func (r *ResidentRuntime) publishLifecycleLeaveFailure() {
	handle, err := r.requireHandle()
	if err != nil {
		return
	}
	if _, err := r.options.Client.SendText(handle, lifecycleLeaveFailureText, nil); err != nil {
		r.log("lifecycle_leave_failure_report_failed", nil)
	}
}
