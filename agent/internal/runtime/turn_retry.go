package runtime

import (
	"errors"
	"strconv"
	"time"

	"github.com/i365dev/free4chat/agent/internal/harness"
	"github.com/i365dev/free4chat/agent/internal/types"
)

// maxTurnRetryAttempts bounds the autonomous retry of ONE canonical pending
// turn after a failed Harness turn. It is deliberately tiny: the Runtime is
// not a resilience framework, and a repeatedly failing Harness must end in a
// bounded truthful local state instead of spinning. Task/request correlation
// is preserved because the retry re-enters the same serial drain, which still
// processes the exact unacknowledged (scope, sequence) the failed turn kept
// pinned.
const maxTurnRetryAttempts = 2

// Bounded failure-class vocabulary used by turn diagnostics. Values are
// stable tokens only: they never contain work content.
const (
	turnFailureTimeout = "timeout"
	turnFailureProcess = "process"
	turnFailureSession = "session"
	turnFailureSend    = "send"
	turnFailureOther   = "other"
)

// turnRetryPlan is one armed autonomous retry of the exact canonical pending
// turn (logical scope + addressed sequence) whose Harness turn failed.
type turnRetryPlan struct {
	scope        string
	target       int64
	scopeKind    string
	failureClass string
	attempt      int
	delay        time.Duration
}

// canonicalTurnKey identifies one canonical pending turn: the logical scope
// plus the addressed Room sequence that triggered it. It is the identity both
// the bounded retry budget and the closed-recovery marker are keyed by, so an
// unrelated Room event can never be mistaken for the same turn.
type canonicalTurnKey struct {
	scope  string
	target int64
}

// scopeKindOf maps an opaque logical scope to the bounded diagnostic token
// used in logs. It never reveals the task/request id itself.
func scopeKindOf(scope string) string {
	if taskRequestIDForScope(scope) != "" {
		return "task"
	}
	return "room"
}

// turnFailureClassOf classifies one failed Harness turn into the bounded
// diagnostic vocabulary. It inspects the error value only: no message text,
// prompt content, tool argument, path, credential, or participant identity is
// ever read, copied, or logged. The ACP turn timeout is classified explicitly.
func turnFailureClassOf(err error) string {
	var timeout *harness.TurnTimeoutError
	if errors.As(err, &timeout) {
		return turnFailureTimeout
	}
	var process *harness.ProcessError
	if errors.As(err, &process) {
		return turnFailureProcess
	}
	if errors.Is(err, types.ErrHarnessSessionGenerationChanged) ||
		errors.Is(err, errScopedHarnessUnsupported) {
		return turnFailureSession
	}
	return turnFailureOther
}

// permanentTurnFailure reports a deterministic Harness misconfiguration that
// a retry cannot resolve (a legacy adapter that cannot serve a task scope).
func permanentTurnFailure(err error) bool {
	return errors.Is(err, errScopedHarnessUnsupported)
}

// turnRetryIndexFor reports how many autonomous retries the canonical turn
// identified by (scope, target) has already had scheduled. 0 means the next
// event describes the initial attempt.
func (r *ResidentRuntime) turnRetryIndexFor(scope string, target int64) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.turnRetryScope != scope || r.turnRetryTarget != target {
		return 0
	}
	return r.turnRetryAttempt
}

// failTurn records one failed Harness turn, emits the bounded secret-free
// diagnostic, and arms the bounded autonomous retry clock when the failure is
// retryable. It never logs Room/message text, prompt or thought content, tool
// arguments, local paths, credentials, participant handles/ids/names, request
// ids, or raw ACP payloads: only the logical scope kind, the failure class,
// elapsed milliseconds, and retry accounting.
func (r *ResidentRuntime) failTurn(
	scope string,
	target int64,
	lastErrorSource, failureClass string,
	started time.Time,
	err error,
	retryable bool,
) {
	elapsedMs := time.Since(started).Milliseconds()
	scopeKind := scopeKindOf(scope)
	retryAttempt := r.turnRetryIndexFor(scope, target)
	r.mu.Lock()
	r.lastError = err.Error()
	r.lastErrorSource = lastErrorSource
	r.state = StateReconnecting
	r.mu.Unlock()
	r.log("turn_failed", map[string]string{
		"scopeKind":    scopeKind,
		"failureClass": failureClass,
		"elapsedMs":    strconv.FormatInt(elapsedMs, 10),
		"retryAttempt": strconv.Itoa(retryAttempt),
	})
	if retryable {
		r.scheduleTurnRetry(scope, target, failureClass, elapsedMs)
		return
	}
	// A permanent, non-retryable Harness failure is deterministic: no retry
	// can resolve it. The canonical turn stays pending and unacknowledged,
	// but its autonomous recovery is closed so unrelated later Room traffic
	// can never re-execute it.
	r.mu.Lock()
	r.closeTurnRecoveryLocked(scope, target)
	r.mu.Unlock()
}

// scheduleTurnRetry records one failed Harness turn for the canonical target
// and arms the single bounded retry clock. The budget belongs to that exact
// (scope, target): an unrelated Room event re-entering the drain can never
// reset it, and once the budget is exhausted the same still-pending turn is
// marked closed so it is never executed again automatically.
func (r *ResidentRuntime) scheduleTurnRetry(scope string, target int64, failureClass string, elapsedMs int64) {
	scopeKind := scopeKindOf(scope)
	r.mu.Lock()
	if r.stopped {
		r.mu.Unlock()
		return
	}
	if r.turnRetryScope != scope || r.turnRetryTarget != target {
		r.turnRetryScope = scope
		r.turnRetryTarget = target
		r.turnRetryAttempt = 0
		r.turnRetryPlan = nil
	}
	r.turnRetryAttempt++
	attempt := r.turnRetryAttempt
	if attempt > maxTurnRetryAttempts {
		r.turnRetryPlan = nil
		// The budget for this exact canonical turn is spent: close its
		// autonomous recovery so later unrelated Room traffic can only keep
		// it pending, never re-execute it.
		r.closeTurnRecoveryLocked(scope, target)
		r.mu.Unlock()
		r.log("turn_retry_exhausted", map[string]string{
			"scopeKind":    scopeKind,
			"failureClass": failureClass,
			"retryAttempt": strconv.Itoa(maxTurnRetryAttempts),
		})
		return
	}
	delay := RetryDelay(attempt - 1)
	if r.turnRetryDelay != nil {
		delay = r.turnRetryDelay(attempt - 1)
	}
	r.turnRetryPlan = &turnRetryPlan{
		scope:        scope,
		target:       target,
		scopeKind:    scopeKind,
		failureClass: failureClass,
		attempt:      attempt,
		delay:        delay,
	}
	r.mu.Unlock()
	r.log("retry_scheduled", map[string]string{
		"scopeKind":    scopeKind,
		"failureClass": failureClass,
		"elapsedMs":    strconv.FormatInt(elapsedMs, 10),
		"retryAttempt": strconv.Itoa(attempt),
		"retryDelayMs": strconv.FormatInt(delay.Milliseconds(), 10),
	})
}

// takeTurnRetryPlan pops the armed plan, if any.
func (r *ResidentRuntime) takeTurnRetryPlan() (turnRetryPlan, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.turnRetryPlan == nil {
		return turnRetryPlan{}, false
	}
	plan := *r.turnRetryPlan
	r.turnRetryPlan = nil
	return plan, true
}

// clearTurnRetry drops the retry budget for a canonical turn that has just
// been delivered successfully. A send failure after that success therefore
// never replays Harness cognition.
func (r *ResidentRuntime) clearTurnRetry(scope string, target int64) {
	r.mu.Lock()
	if r.turnRetryScope == scope && r.turnRetryTarget == target {
		r.turnRetryScope = ""
		r.turnRetryTarget = 0
		r.turnRetryAttempt = 0
		r.turnRetryPlan = nil
	}
	r.mu.Unlock()
}

// unresolvedTurnFailureLocked reports whether the resident still holds
// unacknowledged work it could not hand to the Harness: an armed retry, a
// spent or permanently closed recovery, or an unresolved Harness/send
// failure. It is the single truthful-state predicate every "restore to
// normal" site must consult before claiming a healthy waiting state. Callers
// must hold r.mu.
func (r *ResidentRuntime) unresolvedTurnFailureLocked() bool {
	if r.harnessFailed || len(r.closedTurnRecovery) > 0 {
		return true
	}
	if r.lastErrorSource == "harness" || r.lastErrorSource == "send" {
		return true
	}
	return r.turnRetryPlan != nil || r.turnRetryAttempt > maxTurnRetryAttempts
}

// turnRecoveryClosed reports whether autonomous recovery of one canonical
// pending turn is over: its bounded retry budget is exhausted, or its Harness
// failure is permanent. The trigger itself is deliberately still
// unacknowledged in that case; only an explicit recovery boundary re-arms it.
func (r *ResidentRuntime) turnRecoveryClosed(scope string, target int64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.turnRecoveryClosedLocked(scope, target)
}

func (r *ResidentRuntime) turnRecoveryClosedLocked(scope string, target int64) bool {
	if len(r.closedTurnRecovery) == 0 {
		return false
	}
	scope = normalizeScope(scope)
	if scope == "" {
		return false
	}
	_, closed := r.closedTurnRecovery[canonicalTurnKey{scope: scope, target: target}]
	return closed
}

// closeTurnRecoveryLocked stops autonomous recovery of one canonical pending
// turn. Callers must hold r.mu. The canonical turn stays pending until
// RunTurn actually succeeds — this never acknowledges it — but the serial
// drain refuses to re-execute it for unrelated later Room traffic.
func (r *ResidentRuntime) closeTurnRecoveryLocked(scope string, target int64) {
	scope = normalizeScope(scope)
	if scope == "" {
		return
	}
	ref := r.sessionRefLocked(scope)
	if ref == nil || !containsSequence(*ref.pendingAddressed, target) {
		// The canonical turn already settled: there is no pinned trigger left
		// to protect and no automatic re-execution to refuse.
		return
	}
	if r.closedTurnRecovery == nil {
		r.closedTurnRecovery = make(map[canonicalTurnKey]struct{})
	}
	r.closedTurnRecovery[canonicalTurnKey{scope: scope, target: target}] = struct{}{}
}

// forgetTurnRecoveryLocked drops a closed-recovery marker for a canonical
// turn that settled. Callers must hold r.mu. The map is deliberately left
// non-nil when it drains: emptiness, never non-nilness, is the condition every
// caller must test (see unresolvedTurnFailureLocked).
func (r *ResidentRuntime) forgetTurnRecoveryLocked(scope string, target int64) {
	if len(r.closedTurnRecovery) == 0 {
		return
	}
	delete(r.closedTurnRecovery, canonicalTurnKey{scope: normalizeScope(scope), target: target})
}

// reopenTurnRecoveryLocked is the explicit recovery boundary: a new addressed
// trigger for the scope re-arms the parked canonical turn(s) of that scope and
// restarts the bounded budget of the one whose budget was spent, so the
// diagnostic retryAttempt count can never exceed its documented bound.
// Deleting the last marker intentionally leaves an empty (possibly non-nil)
// map: no caller may branch on non-nilness. Callers must hold r.mu.
func (r *ResidentRuntime) reopenTurnRecoveryLocked(scope string) {
	if len(r.closedTurnRecovery) == 0 {
		return
	}
	scope = normalizeScope(scope)
	for key := range r.closedTurnRecovery {
		if key.scope != scope {
			continue
		}
		delete(r.closedTurnRecovery, key)
		if r.turnRetryScope == key.scope && r.turnRetryTarget == key.target {
			r.turnRetryScope = ""
			r.turnRetryTarget = 0
			r.turnRetryAttempt = 0
			r.turnRetryPlan = nil
		}
	}
}

// drainTurnsWithRetryClock is the event-loop entry point. It runs the serial
// turn drain and then rides the bounded autonomous retry clock, so a pending
// addressed turn never needs an unrelated future Room event before it is
// retried. It adds no goroutine and no scheduler: the wait is the existing
// stop-aware sleep on the one event-loop goroutine that already owns drainTurns.
func (r *ResidentRuntime) drainTurnsWithRetryClock() {
	r.drainTurns()
	r.runTurnRetryClock()
}

// runTurnRetryClock waits the small explicit delay and re-enters the serial
// drain for the same canonical pending turn. Each iteration must have been
// armed by a fresh failed turn, so the loop is bounded by construction.
func (r *ResidentRuntime) runTurnRetryClock() {
	for {
		plan, ok := r.takeTurnRetryPlan()
		if !ok {
			return
		}
		if target, pending := r.peekPendingFor(plan.scope); !pending || target != plan.target {
			// The canonical turn settled while the clock was armed. Never
			// resurrect a stale retry for a different or already-delivered
			// trigger.
			return
		}
		if !r.sleep(plan.delay) {
			return
		}
		r.log("retry_started", map[string]string{
			"scopeKind":    plan.scopeKind,
			"failureClass": plan.failureClass,
			"retryAttempt": strconv.Itoa(plan.attempt),
			"retryDelayMs": strconv.FormatInt(plan.delay.Milliseconds(), 10),
		})
		r.drainTurns()
		if r.isStopped() {
			return
		}
	}
}
