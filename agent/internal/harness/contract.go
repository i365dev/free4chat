package harness

import "github.com/i365dev/free4chat/agent/internal/types"

/*
 * The Free4Chat Harness semantic contract (#427).
 *
 * The Runtime depends on these operations and their INVARIANTS, not on ACP
 * methods and not on how one bridge happens to implement them. One shared ACP
 * adapter implements the whole contract; provider-specific facts (launch
 * material, bridge quirks, verified capability policy) configure it from the
 * provider registry. Runtime never needs to know that "Pi needs X".
 *
 * ACP transport (stdio, JSON-RPC framing, request correlation, session/update
 * decoding) is an implementation detail BELOW this seam and stays in the one
 * shared adapter. It is never part of the contract.
 *
 * INVARIANTS
 *
 *	LoadSession(scope, exact native conversation)
 *	  - binds exactly the requested native conversation;
 *	  - never silently creates a fresh conversation as a fallback;
 *	  - never destroys an unrelated active turn of another scope;
 *	  - returns a typed failure when the conversation cannot be bound.
 *
 *	EnsureSessionFor(scope)
 *	  - materializes exactly the retained conversation for that scope;
 *	  - fails closed for a scope whose adopted conversation is gone.
 *
 *	RunTurnFor(scope, turn, exact generation)
 *	  - executes one turn of exactly that scope's conversation;
 *	  - one retained conversation executes at most one turn at a time;
 *	  - per-scope stream, cancellation, and permission state stay isolated.
 *
 *	CancelTurnFor(scope)
 *	  - cancels exactly the active turn of that scope and no other.
 *
 *	TurnOwnerFor(scope)
 *	  - reports the scope currently executing on the same native
 *	    conversation, without ever exposing a native session id.
 *
 *	ReleaseSessionFor(scope)
 *	  - gives back exactly that scope's live conversation;
 *	  - reports whether the exact native identity survived the release, so a
 *	    later ensure either materializes that same conversation or a truly new
 *	    one — never an unstated substitution;
 *	  - refuses while that conversation is executing a turn.
 *
 *	ListSessions(options)
 *	  - bounded ACP session discovery only; the provider's wire spelling of
 *	    "no cwd filter" is a provider quirk normalized below this seam.
 *
 * The known 0.0.33 pi-acp violation of the LoadSession invariant
 * (closeAllExcept() disposing an unrelated busy worker) is handled at the
 * provider/distribution layer documented in providers.go and tracked by
 * upstream svkozak/pi-acp#131, never by Runtime provider branching.
 */

// SessionHandoff is the session discovery/adoption part of the contract: the
// Runtime may ask which native conversations exist, and bind one exact
// conversation to one logical scope.
type SessionHandoff interface {
	// ListSessions issues one bounded session-discovery request. The concrete
	// ACP option/result shapes are retained for now so existing callers and
	// provider tests keep working; normalizing them further is later work.
	ListSessions(options ACPSessionListOptions) (ACPSessionPage, error)
	// LoadSession binds one exact native conversation to one logical scope.
	LoadSession(scope string, sessionID string, cwd string) error
}

// Contract is the provider-neutral semantic seam for the session and turn
// operations the Runtime consumes. The shared ACP adapter is the one built-in
// implementation.
type Contract interface {
	types.HarnessAdapter
	types.ScopedHarnessAdapter
	types.ScopedProjectHarnessAdapter
	types.ScopedHarnessSessionControls
	types.ScopedHarnessReleaser
	types.ScopedTurnCanceller
	types.ScopedTurnOwnership
	SessionHandoff
}

// The shared ACP adapter is the ONE built-in implementation of the contract.
var _ Contract = (*ACPAdapter)(nil)

// ContractOf returns the contract view of an adapter when it implements the
// full seam. A legacy adapter that only implements types.HarnessAdapter keeps
// working through the Runtime's existing optional-interface fallbacks; new
// code paths should depend on this seam instead.
func ContractOf(adapter types.HarnessAdapter) (Contract, bool) {
	if adapter == nil {
		return nil, false
	}
	contract, ok := adapter.(Contract)
	return contract, ok
}
