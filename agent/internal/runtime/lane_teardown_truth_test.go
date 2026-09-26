package runtime

import (
	"sync"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/harness"
	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Truthful lane teardown (#482).
 *
 * A Human exact interrupt may only settle as Interrupted once the turn's owned
 * local execution is really gone. When the Harness lane reports that its owned
 * processes could not be confirmed stopped, the Runtime must keep the exact
 * turn and publish no Interrupting phase and no interrupted outcome.
 */

type logRecorder struct {
	mu     sync.Mutex
	events []string
}

func (r *logRecorder) record(event string, _ map[string]string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, event)
}

func (r *logRecorder) has(event string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, recorded := range r.events {
		if recorded == event {
			return true
		}
	}
	return false
}

func TestFailedLaneTeardownIsNotReportedAsInterrupted(t *testing.T) {
	rt, adapter, client := newExecutionRuntime(t)
	defer rt.Stop()
	logged := &logRecorder{}
	rt.log = logged.record

	drained := startTurn(rt, scopedEvent(50, "task:req-T", "long instruction"))
	waitForActiveScope(t, rt, "task:req-T")
	waitForExecution(t, client, "req-T", "running projection", func(p types.TaskExecutionProjection) bool {
		return p.CurrentTurnSequence == 50 && p.Phase == types.TaskExecutionPhaseRunning
	})

	adapter.failCancel(harness.ErrLaneNotQuiescent)
	rt.applyResidentTaskControl(interruptControl("req-T", 50))

	if got := adapter.cancelCount(); got != 1 {
		t.Fatalf("the exact control must still dispatch exactly once, got %d", got)
	}
	if !logged.has("task_interrupt_cancel_failed") {
		t.Fatalf("a teardown failure must be reported, got %v", logged.events)
	}
	// The lane could not confirm its owned execution stopped, so this exact
	// turn is NOT truthfully interrupted: it is still the active turn, it keeps
	// no interruption marker, and nothing was published for it.
	if got := activeScope(rt); got != "task:req-T" {
		t.Fatalf("a failed teardown settled the turn anyway: %q", got)
	}
	if rt.consumeTurnInterrupted("task:req-T", 50) {
		t.Fatal("a failed teardown must not mark the exact turn interrupted")
	}
	latest, ok := client.latest("req-T")
	if !ok || latest.CurrentTurnSequence != 50 || latest.Phase != types.TaskExecutionPhaseRunning {
		t.Fatalf("a failed teardown must leave the running projection untouched: %+v", latest)
	}
	if latest.LastOutcome != "" {
		t.Fatalf("a failed teardown must never publish an interrupted outcome: %+v", latest)
	}

	// The turn is still owned and can settle normally afterwards.
	adapter.releaseTurn()
	waitForDone(t, drained, "turn to settle")
}
