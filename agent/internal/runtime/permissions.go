package runtime

import (
	"context"
	cryptorand "crypto/rand"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/i365dev/free4chat/agent/internal/harness"
	"github.com/i365dev/free4chat/agent/internal/types"
)

const (
	maxPendingRoomPermissions = 32
	maxRoomPermissionTitle    = 200
	maxRoomPermissionKind     = 64
	maxRoomPermissionOptions  = 8
	maxRoomPermissionOptionID = 64
	maxRoomPermissionName     = 160
	roomPermissionMinLifetime = time.Second
	roomPermissionMaxLifetime = 5 * time.Minute
)

var errRoomPermissionCancelled = errors.New("Room permission approval was cancelled")

type pendingRoomPermission struct {
	done    chan roomPermissionDecision
	offered map[string]struct{}
}

type roomPermissionDecision struct {
	optionID string
	err      error
}

// configurePermissionResponder attaches the Room bridge only to adapters
// that expose #290's optional setter. Existing test adapters and alternate
// Harness implementations retain their fail-closed behavior unchanged.
func configurePermissionResponder(r *ResidentRuntime) {
	setter, ok := r.options.Adapter.(interface {
		SetPermissionResponder(harness.ACPPermissionResponder)
	})
	if !ok {
		return
	}
	setter.SetPermissionResponder(r.respondToPermission)
}

func (r *ResidentRuntime) respondToPermission(
	ctx context.Context,
	request harness.ACPPermissionRequest,
) (harness.ACPPermissionResponse, error) {
	if ctx == nil {
		return harness.ACPPermissionResponse{}, errRoomPermissionCancelled
	}
	if err := ctx.Err(); err != nil {
		return harness.ACPPermissionResponse{}, err
	}
	client, ok := r.options.Client.(types.PermissionRequestClient)
	if !ok {
		return harness.ACPPermissionResponse{}, errors.New("Room permission approval is unavailable")
	}
	handle, err := r.requireHandle()
	if err != nil {
		return harness.ACPPermissionResponse{}, err
	}
	participantID := r.currentParticipantID()
	if participantID == "" {
		return harness.ACPPermissionResponse{}, errRoomPermissionCancelled
	}
	projected, offered, err := projectRoomPermission(request)
	if err != nil {
		return harness.ACPPermissionResponse{}, err
	}
	correlationID, err := newRoomPermissionCorrelationID()
	if err != nil {
		return harness.ACPPermissionResponse{}, errors.New("could not create Room permission correlation")
	}
	lifetime, err := r.roomPermissionLifetime()
	if err != nil {
		return harness.ACPPermissionResponse{}, err
	}
	projected.RequestID = correlationID
	projected.ExpiresInMs = lifetime

	pending := &pendingRoomPermission{
		done:    make(chan roomPermissionDecision, 1),
		offered: offered,
	}
	r.permissionMu.Lock()
	if len(r.pendingPermissions) >= maxPendingRoomPermissions {
		r.permissionMu.Unlock()
		return harness.ACPPermissionResponse{}, errors.New("too many pending Room permission requests")
	}
	r.pendingPermissions[correlationID] = pending
	r.permissionMu.Unlock()

	if err := client.RequestPermission(handle, projected); err != nil {
		r.removePendingPermission(correlationID, pending)
		return harness.ACPPermissionResponse{}, errors.New("Room permission request failed")
	}
	r.ensurePermissionEventReader()
	defer r.stopPermissionEventReader()

	select {
	case decision := <-pending.done:
		if decision.err != nil {
			return harness.ACPPermissionResponse{}, decision.err
		}
		return harness.ACPPermissionResponse{OptionID: decision.optionID}, nil
	case <-ctx.Done():
		r.removePendingPermission(correlationID, pending)
		return harness.ACPPermissionResponse{}, ctx.Err()
	case <-r.stopCh:
		r.removePendingPermission(correlationID, pending)
		return harness.ACPPermissionResponse{}, errRoomPermissionCancelled
	}
}

func projectRoomPermission(
	request harness.ACPPermissionRequest,
) (types.RoomPermissionRequest, map[string]struct{}, error) {
	title := strings.TrimSpace(request.ToolCall.Title)
	if !validRoomPermissionText(title, maxRoomPermissionTitle) {
		return types.RoomPermissionRequest{}, nil, errors.New("invalid Harness permission title")
	}
	kind := strings.TrimSpace(request.ToolCall.Kind)
	if kind != "" && !validRoomPermissionText(kind, maxRoomPermissionKind) {
		return types.RoomPermissionRequest{}, nil, errors.New("invalid Harness permission kind")
	}
	if len(request.Options) == 0 || len(request.Options) > maxRoomPermissionOptions {
		return types.RoomPermissionRequest{}, nil, errors.New("invalid Harness permission options")
	}
	offered := make(map[string]struct{}, len(request.Options))
	options := make([]types.RoomPermissionOption, 0, len(request.Options))
	for _, option := range request.Options {
		// Option IDs are opaque native identity. Reject surrounding whitespace
		// rather than trimming it and changing what the Harness expects back.
		if option.OptionID == "" || strings.TrimSpace(option.OptionID) != option.OptionID ||
			!validRoomPermissionText(option.OptionID, maxRoomPermissionOptionID) {
			return types.RoomPermissionRequest{}, nil, errors.New("invalid Harness permission option id")
		}
		if _, exists := offered[option.OptionID]; exists {
			return types.RoomPermissionRequest{}, nil, errors.New("duplicate Harness permission option id")
		}
		name := strings.TrimSpace(option.Name)
		if !validRoomPermissionText(name, maxRoomPermissionName) {
			return types.RoomPermissionRequest{}, nil, errors.New("invalid Harness permission option name")
		}
		optionKind := strings.TrimSpace(option.Kind)
		if optionKind != "" && !validRoomPermissionText(optionKind, maxRoomPermissionKind) {
			return types.RoomPermissionRequest{}, nil, errors.New("invalid Harness permission option kind")
		}
		offered[option.OptionID] = struct{}{}
		options = append(options, types.RoomPermissionOption{
			OptionID: option.OptionID,
			Name:     name,
			Kind:     optionKind,
		})
	}
	// ACP rawInput/content, toolCallId, status, sessionId, and the native
	// JSON-RPC request id are intentionally not projected into Room. #291's
	// presentation remains Human-useful without leaking local Harness state.
	return types.RoomPermissionRequest{
		ToolCall: types.RoomPermissionToolCall{Title: title, Kind: kind},
		Options:  options,
	}, offered, nil
}

func validRoomPermissionText(value string, maxUTF16 int) bool {
	return value != "" && len(utf16.Encode([]rune(value))) <= maxUTF16
}

func newRoomPermissionCorrelationID() (string, error) {
	var raw [16]byte
	if _, err := cryptorand.Read(raw[:]); err != nil {
		return "", err
	}
	// RFC 4122 version 4 UUID. The value is a Room correlation id only; it is
	// never used as an ACP JSON-RPC id or exposed to the Harness.
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16]), nil
}

func (r *ResidentRuntime) roomPermissionLifetime() (int64, error) {
	provider, ok := r.options.Adapter.(interface {
		PermissionRequestLifetime() time.Duration
	})
	if !ok {
		// #291's server default is the compatibility path for adapters that do
		// not expose a local ACP timeout. The built-in ACP adapter does expose
		// one, so production requests use the shorter derived lifetime below.
		return 0, nil
	}
	lifetime := provider.PermissionRequestLifetime()
	if lifetime < roomPermissionMinLifetime {
		return 0, errors.New("Harness permission lifetime is too short")
	}
	if lifetime > roomPermissionMaxLifetime {
		lifetime = roomPermissionMaxLifetime
	}
	return lifetime.Milliseconds(), nil
}

func (r *ResidentRuntime) handleRoomPermissionEvent(event types.RoomEvent) bool {
	if event.ActionType != "permission" || event.Permission == nil {
		return false
	}
	// Permission lifecycle events are never ordinary Harness context. Even a
	// malformed or misrouted event must not wake the Harness as a tool turn.
	if !event.Addressed || event.Permission.AgentParticipantID != r.currentParticipantID() {
		return true
	}
	if event.Permission.Kind != "resolved" && event.Permission.Kind != "expired" {
		return true
	}
	r.permissionMu.Lock()
	pending, ok := r.pendingPermissions[event.Permission.RequestID]
	if ok {
		delete(r.pendingPermissions, event.Permission.RequestID)
	}
	r.permissionMu.Unlock()
	if !ok {
		return true
	}
	decision := roomPermissionDecision{}
	if event.Permission.Kind == "resolved" {
		if _, offered := pending.offered[event.Permission.SelectedOptionID]; !offered {
			decision.err = errors.New("Room returned an option not offered by the Harness")
		} else {
			decision.optionID = event.Permission.SelectedOptionID
		}
	} else {
		decision.err = errRoomPermissionCancelled
	}
	pending.done <- decision
	return true
}

// ensurePermissionEventReader temporarily consumes the already-open resident
// WebSocket while the main resident loop is synchronously inside the ACP turn.
// It is intentionally one reader shared by all pending local permissions.
func (r *ResidentRuntime) ensurePermissionEventReader() {
	r.residentMu.Lock()
	stream := r.resident
	r.residentMu.Unlock()
	if stream == nil {
		return
	}
	r.permissionReaderMu.Lock()
	if r.permissionReaderCancel != nil {
		r.permissionReaderMu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	r.permissionReaderCancel = cancel
	r.permissionReaderDone = done
	r.permissionReaderMu.Unlock()

	go func() {
		defer close(done)
		defer func() {
			r.permissionReaderMu.Lock()
			if r.permissionReaderDone == done {
				r.permissionReaderCancel = nil
				r.permissionReaderDone = nil
			}
			r.permissionReaderMu.Unlock()
		}()
		for {
			result, err := stream.Receive(ctx)
			if err != nil {
				if ctx.Err() == nil && !r.isStopped() {
					r.cancelPendingPermissions(err)
				}
				return
			}
			r.advanceFromWait(result)
			if !r.hasPendingPermissions() {
				return
			}
		}
	}()
}

func (r *ResidentRuntime) stopPermissionEventReader() {
	r.permissionReaderMu.Lock()
	if r.hasPendingPermissions() {
		r.permissionReaderMu.Unlock()
		return
	}
	cancel := r.permissionReaderCancel
	done := r.permissionReaderDone
	r.permissionReaderCancel = nil
	r.permissionReaderDone = nil
	r.permissionReaderMu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
}

func (r *ResidentRuntime) hasPendingPermissions() bool {
	r.permissionMu.Lock()
	defer r.permissionMu.Unlock()
	return len(r.pendingPermissions) > 0
}

func (r *ResidentRuntime) removePendingPermission(
	correlationID string,
	pending *pendingRoomPermission,
) {
	r.permissionMu.Lock()
	if current, ok := r.pendingPermissions[correlationID]; ok && current == pending {
		delete(r.pendingPermissions, correlationID)
	}
	r.permissionMu.Unlock()
}

func (r *ResidentRuntime) cancelPendingPermissions(reason error) {
	if reason == nil {
		reason = errRoomPermissionCancelled
	}
	r.permissionMu.Lock()
	pending := make([]*pendingRoomPermission, 0, len(r.pendingPermissions))
	for correlationID, request := range r.pendingPermissions {
		delete(r.pendingPermissions, correlationID)
		pending = append(pending, request)
	}
	r.permissionMu.Unlock()
	for _, request := range pending {
		request.done <- roomPermissionDecision{err: reason}
	}
}
