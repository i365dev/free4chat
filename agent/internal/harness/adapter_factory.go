package harness

import (
	"strconv"

	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * The ONE place that turns a launcher-registry execution policy into a real
 * adapter topology (#421/#474).
 *
 * Before this seam existed, the daemon built the adapter inline and tests that
 * wanted the production topology had to re-implement that decision. A test
 * which reconstructs its own copy cannot fail when the real branch changes, so
 * it proves the layers BELOW the decision while claiming the decision itself.
 * Both the daemon and the regressions now call this function instead, which
 * makes "a provider whose registry policy is cross-session with N lanes really
 * gets N provider-process lanes" an executable contract rather than a
 * duplicated assumption.
 */

// BuildAdapter materializes the adapter topology selected by one launcher's
// TaskExecution policy.
//
// A cross-session policy with more than one lane gets exactly that many lazy,
// isolated ACP process owners; every other policy — including the fail-safe
// zero value and a cross-session policy that resolves to a single lane — keeps
// the pre-#421 serial adapter, which is also the compatibility path for a
// launcher that never opted in.
//
// No provider process is started here: lanes materialize inside
// EnsureSession/EnsureSessionFor, so this call is cheap and side-effect free
// beyond allocating adapters.
func BuildAdapter(launcher types.AgentLauncher, workspace string, options AdapterOptions) (types.HarnessAdapter, error) {
	laneCount := launcher.TaskExecution.Lanes()
	if launcher.TaskExecution.Concurrency != types.TaskExecutionCrossSession || laneCount <= 1 {
		return NewACPAdapter(launcher, workspace, options), nil
	}
	isolated, err := NewIsolatedACPAdapterWithCapacity(laneCount, func(lane int) *ACPAdapter {
		localOptions := options
		if options.LaneDiagnostics {
			base := options.DiagnosticSink
			localOptions.DiagnosticSink = func(event string, details map[string]string) {
				if base == nil {
					return
				}
				// Copy before tagging: the caller's map may be shared with the
				// adapter or another lane, and diagnostics must never mutate
				// shared state.
				tagged := make(map[string]string, len(details)+1)
				for key, value := range details {
					tagged[key] = value
				}
				tagged["lane"] = strconv.Itoa(lane)
				base(event, tagged)
			}
		}
		return NewACPAdapter(launcher, workspace, localOptions)
	})
	if err != nil {
		return nil, err
	}
	return isolated, nil
}
