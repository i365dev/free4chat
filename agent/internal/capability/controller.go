// Package capability owns bounded, Runtime-local semantic capability calls.
package capability

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

const (
	MaxIDBytes     = 64
	MaxActionBytes = 32
	MaxArgsBytes   = 1024
	MaxResultBytes = 4096
	MaxDescriptor  = 1024
	RequestTimeout = 1500 * time.Millisecond
)

var (
	ErrUnknownCapability   = errors.New("unknown capability")
	ErrUnsupportedAction   = errors.New("unsupported action")
	ErrInvalidArgs         = errors.New("invalid capability arguments")
	ErrUnavailable         = errors.New("local capability unavailable")
	ErrTimeout             = errors.New("local capability timed out")
	ErrTooLarge            = errors.New("local capability payload exceeds limit")
	ErrMalformedResponse   = errors.New("local capability response malformed")
	ErrCapabilityCount     = errors.New("adapter must expose exactly one capability")
	ErrInvalidRegistration = errors.New("invalid local Adapter registration")
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
	Name       string            `json:"name"`
	Title      string            `json:"title"`
	Args       string            `json:"args"`
	Properties map[string]string `json:"properties"`
	Required   []string          `json:"required,omitempty"`
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
	if c == nil || c.adapter == nil {
		return Descriptor{}, ErrUnavailable
	}
	d := c.adapter.Describe()
	if id != d.ID {
		return Descriptor{}, ErrUnknownCapability
	}
	if !descriptorProjection(d).Valid() {
		return Descriptor{}, ErrMalformedResponse
	}
	return d, nil
}

// DescribeAll returns the bounded semantic descriptors currently owned by
// this controller. An unconfigured controller has no discoverable entries.
func (c *Controller) DescribeAll() []Descriptor {
	if c == nil || c.adapter == nil {
		return []Descriptor{}
	}
	descriptor := c.adapter.Describe()
	validated, err := c.Describe(descriptor.ID)
	if err != nil {
		return []Descriptor{}
	}
	return []Descriptor{validated}
}

func (c *Controller) Observe(ctx context.Context, id string) (Observation, error) {
	if c == nil || c.adapter == nil {
		return Observation{}, ErrUnavailable
	}
	descriptor := c.adapter.Describe()
	if descriptor.ID == "" {
		return Observation{}, ErrUnavailable
	}
	if id != descriptor.ID {
		return Observation{}, ErrUnknownCapability
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
	if c == nil || c.adapter == nil {
		return nil, ErrUnavailable
	}
	descriptor := c.adapter.Describe()
	if descriptor.ID == "" {
		return nil, ErrUnavailable
	}
	if id != descriptor.ID {
		return nil, ErrUnknownCapability
	}
	if len(action) == 0 || len(action) > MaxActionBytes || strings.TrimSpace(action) != action {
		return nil, ErrUnsupportedAction
	}
	var schema *ActionSchema
	for index := range descriptor.Actions {
		if descriptor.Actions[index].Name == action {
			schema = &descriptor.Actions[index]
			break
		}
	}
	if schema == nil {
		return nil, ErrUnsupportedAction
	}
	if len(args) > MaxArgsBytes {
		return nil, ErrTooLarge
	}
	if len(args) == 0 || !json.Valid(args) {
		return nil, ErrInvalidArgs
	}
	if !validActionArgs(*schema, args) {
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

func descriptorProjection(descriptor Descriptor) types.RuntimeCapabilityProjection {
	projection := types.RuntimeCapabilityProjection{
		CapabilityID: descriptor.ID,
		Title:        descriptor.Title,
		Version:      descriptor.Version,
		Observe:      descriptor.Observe != "",
		Actions:      make([]types.RuntimeCapabilityAction, 0, len(descriptor.Actions)),
	}
	for _, action := range descriptor.Actions {
		projected := types.RuntimeCapabilityAction{Name: action.Name, Title: action.Title}
		projected.Input.Type = "object"
		projected.Input.Properties = action.Properties
		projected.Input.Required = action.Required
		projection.Actions = append(projection.Actions, projected)
	}
	return projection
}

func validActionArgs(schema ActionSchema, args json.RawMessage) bool {
	var values map[string]json.RawMessage
	if json.Unmarshal(args, &values) != nil || values == nil {
		return false
	}
	for _, required := range schema.Required {
		if _, ok := values[required]; !ok {
			return false
		}
	}
	for name, raw := range values {
		kind, ok := schema.Properties[name]
		if !ok {
			return false
		}
		var value any
		decoder := json.NewDecoder(strings.NewReader(string(raw)))
		decoder.UseNumber()
		if decoder.Decode(&value) != nil {
			return false
		}
		switch kind {
		case "string":
			if _, ok := value.(string); !ok {
				return false
			}
		case "number":
			if _, ok := value.(json.Number); !ok {
				return false
			}
		case "boolean":
			if _, ok := value.(bool); !ok {
				return false
			}
		default:
			return false
		}
	}
	return true
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
