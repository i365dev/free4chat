package harness

import "github.com/i365dev/free4chat/agent/internal/types"

/*
 * Free4Chat Harness capability model (#427).
 *
 * Three different facts are routinely conflated:
 *
 *   ACP protocol advertises X
 *        !=
 *   Free4Chat source appears to support X
 *        !=
 *   Free4Chat product capability VERIFIED against the pinned bridge
 *
 * This file gives the semantic seam one vocabulary for all three. Nothing here
 * enables a capability by itself: the per-provider values live in
 * providers.go, next to the launcher they describe, which is exactly where the
 * previous launcher-registry policy lived. Runtime behavior is unchanged.
 */

// SessionContinuationStatus is Free4Chat's product status for continuing one
// EXISTING native Harness session from the Room Start Task surface (#409).
//
// It is deliberately NOT derived from `sessionCapabilities.list` /
// `loadSession`: the #409 spike proved OpenCode and Hermes advertise both and
// still cannot continue a native session, while Pi was verified end-to-end.
type SessionContinuationStatus string

const (
	// SessionContinuationUnsupported means the bridge cannot bind an existing
	// native conversation at all.
	SessionContinuationUnsupported SessionContinuationStatus = "unsupported"
	// SessionContinuationSourceSupported means the pinned bridge source
	// appears to implement the path, but Free4Chat has NOT verified the exact
	// native-CLI -> ACP continuation end to end.
	SessionContinuationSourceSupported SessionContinuationStatus = "source-supported"
	// SessionContinuationVerified means a real native-CLI -> ACP session/load
	// continuation was verified against the pinned bridge.
	SessionContinuationVerified SessionContinuationStatus = "verified"
)

// Enabled reports whether continuation may be offered to Humans. Only VERIFIED
// enables it; source support is evidence, never a license.
func (s SessionContinuationStatus) Enabled() bool {
	return s == SessionContinuationVerified
}

// ExecutionCapability is the verified cross-session execution capability of one
// bridge. The zero value is the fail-safe serial policy.
//
// It never relaxes the hard invariant that ONE retained conversation executes
// at most one turn at a time: that is enforced independently, at the adapter,
// by native session identity.
type ExecutionCapability struct {
	// Mode is serial or cross-session. Empty is treated as serial.
	Mode types.TaskExecutionConcurrency
	// MaxConcurrent is the bounded number of independently executing
	// conversations. Only meaningful for cross-session.
	MaxConcurrent int
	// Evidence labels the measurement behind the decision. It never changes
	// behavior; it travels with the decision so a reader can tell measured
	// capability from assumption.
	Evidence types.TaskExecutionProbe
}

// Policy projects the capability into the existing Runtime policy type. It is
// the one conversion point, so a provider change never needs a Runtime edit.
func (e ExecutionCapability) Policy() types.TaskExecutionPolicy {
	return types.TaskExecutionPolicy{
		Probe:         e.Evidence,
		Concurrency:   e.Mode,
		MaxConcurrent: e.MaxConcurrent,
	}
}

// ApprovalMode is Free4Chat's normalized description of how a provider-side
// approval request can reach a Human. It is deliberately not a boolean:
// "the provider runs its own policy and never asks" is a common, legitimate
// state, and it is not the same as a broken Room approval transport.
type ApprovalMode string

const (
	// ApprovalUnsupported means no approval seam exists and none is expected.
	ApprovalUnsupported ApprovalMode = "unsupported"
	// ApprovalNativePolicyNoPrompt means the bridge/Harness executes under its
	// own default policy and emits no permission request Free4Chat could
	// present. (This was the #297 Codex/Hermes/Pi observation.)
	ApprovalNativePolicyNoPrompt ApprovalMode = "native-policy/no-prompt"
	// ApprovalRoomMediated means the bridge emits session/request_permission
	// and Free4Chat can carry the exact native option to a Room human.
	ApprovalRoomMediated ApprovalMode = "room-mediated"
	// ApprovalPartial means some approval paths surface a request and others
	// are known to bypass it; the exact split is tracked by evidence.
	ApprovalPartial ApprovalMode = "partial"
)

// Capabilities is the normalized product capability set of ONE provider. It is
// the only capability value the semantic seam exposes; runtime policy is
// projected from it.
type Capabilities struct {
	SessionContinuation SessionContinuationStatus
	Execution           ExecutionCapability
	Approval            ApprovalMode
}
