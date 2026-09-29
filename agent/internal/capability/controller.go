// Package capability owns bounded, Runtime-local semantic capability calls.
package capability

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const (
	CapabilityID   = "local_fixture"
	MaxIDBytes     = 48
	MaxActionBytes = 32
	MaxArgsBytes   = 1024
	MaxResultBytes = 4096
	MaxDescriptor  = 2048
	RequestTimeout = 1500 * time.Millisecond
)

var (
	ErrUnknownCapability = errors.New("unknown capability")
	ErrUnsupportedAction = errors.New("unsupported action")
	ErrInvalidArgs       = errors.New("invalid capability arguments")
	ErrUnavailable       = errors.New("local capability unavailable")
	ErrTimeout           = errors.New("local capability timed out")
	ErrTooLarge          = errors.New("local capability payload exceeds limit")
	ErrMalformedResponse = errors.New("local capability response malformed")
)

// Descriptor contains semantic metadata only. Adapter configuration is never
// represented here.
type Descriptor struct {
	ID      string         `json:"id"`
	Title   string         `json:"title"`
	Version string         `json:"version"`
	Observe string         `json:"observe"`
	Actions []ActionSchema `json:"actions"`
}

type ActionSchema struct {
	Name string `json:"name"`
	Args string `json:"args"`
}

type Observation struct {
	CapabilityID string          `json:"capabilityId"`
	State        json.RawMessage `json:"state"`
}

// Adapter is intentionally semantic: it has no arbitrary URL, method, or path
// arguments. Implementations own their local endpoint configuration.
type Adapter interface {
	Describe() Descriptor
	Observe(context.Context) (json.RawMessage, error)
	Invoke(context.Context, string, json.RawMessage) (json.RawMessage, error)
}

type Controller struct {
	adapter Adapter
	timeout time.Duration
}

func NewController(adapter Adapter) *Controller {
	return &Controller{adapter: adapter, timeout: RequestTimeout}
}

func (c *Controller) Describe(id string) (Descriptor, error) {
	if id != CapabilityID {
		return Descriptor{}, ErrUnknownCapability
	}
	if c == nil || c.adapter == nil {
		return Descriptor{}, ErrUnavailable
	}
	d := c.adapter.Describe()
	b, err := json.Marshal(d)
	if err != nil || len(b) > MaxDescriptor || len(d.ID) > MaxIDBytes {
		return Descriptor{}, ErrMalformedResponse
	}
	return d, nil
}

func (c *Controller) Observe(ctx context.Context, id string) (Observation, error) {
	if id != CapabilityID {
		return Observation{}, ErrUnknownCapability
	}
	if c == nil || c.adapter == nil {
		return Observation{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	result, err := c.adapter.Observe(ctx)
	if err != nil {
		return Observation{}, safeError(ctx, err)
	}
	if len(result) > MaxResultBytes {
		return Observation{}, ErrTooLarge
	}
	if len(result) == 0 || !json.Valid(result) {
		return Observation{}, ErrMalformedResponse
	}
	return Observation{CapabilityID: id, State: append(json.RawMessage(nil), result...)}, nil
}

func (c *Controller) Invoke(ctx context.Context, id, action string, args json.RawMessage) (json.RawMessage, error) {
	if id != CapabilityID {
		return nil, ErrUnknownCapability
	}
	if len(action) == 0 || len(action) > MaxActionBytes || strings.TrimSpace(action) != action {
		return nil, ErrUnsupportedAction
	}
	if c == nil || c.adapter == nil {
		return nil, ErrUnavailable
	}
	if len(args) > MaxArgsBytes {
		return nil, ErrTooLarge
	}
	if len(args) == 0 || !json.Valid(args) {
		return nil, ErrInvalidArgs
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	result, err := c.adapter.Invoke(ctx, action, append(json.RawMessage(nil), args...))
	if err != nil {
		return nil, safeError(ctx, err)
	}
	if len(result) > MaxResultBytes {
		return nil, ErrTooLarge
	}
	if len(result) == 0 || !json.Valid(result) {
		return nil, ErrMalformedResponse
	}
	return append(json.RawMessage(nil), result...), nil
}

func safeError(ctx context.Context, err error) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return ErrTimeout
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return ErrUnavailable
	}
	if errors.Is(err, ErrUnsupportedAction) || errors.Is(err, ErrInvalidArgs) || errors.Is(err, ErrUnavailable) || errors.Is(err, ErrTooLarge) || errors.Is(err, ErrMalformedResponse) {
		return err
	}
	return ErrUnavailable
}
