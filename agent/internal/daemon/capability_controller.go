package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"

	"github.com/i365dev/free4chat/agent/internal/capability"
	"github.com/i365dev/free4chat/agent/internal/types"
)

// daemonCapabilityController is a stable Runtime dependency. It resolves the
// daemon's current controller for every descriptor and request so residents
// remain current when capability configure replaces the fixture adapter.
type daemonCapabilityController struct {
	daemon *Daemon
}

func (c *daemonCapabilityController) current() *capability.Controller {
	if c == nil || c.daemon == nil {
		return nil
	}
	c.daemon.mu.Lock()
	defer c.daemon.mu.Unlock()
	return c.daemon.localCapability
}

func (c *daemonCapabilityController) DescribeCapabilities() []types.RuntimeCapabilityProjection {
	controller := c.current()
	if controller == nil {
		return nil
	}
	descriptors := controller.DescribeAll()
	projected := make([]types.RuntimeCapabilityProjection, 0, len(descriptors))
	for _, descriptor := range descriptors {
		item := types.RuntimeCapabilityProjection{
			CapabilityID: descriptor.ID,
			Title:        descriptor.Title,
			Version:      descriptor.Version,
			Observe:      descriptor.Observe != "",
			Actions:      make([]types.RuntimeCapabilityAction, 0, len(descriptor.Actions)),
		}
		for _, action := range descriptor.Actions {
			properties := make(map[string]string, len(action.Properties))
			for name, kind := range action.Properties {
				properties[name] = kind
			}
			projectedAction := types.RuntimeCapabilityAction{Name: action.Name, Title: action.Title}
			projectedAction.Input.Type = "object"
			projectedAction.Input.Properties = properties
			projectedAction.Input.Required = append([]string(nil), action.Required...)
			item.Actions = append(item.Actions, projectedAction)
		}
		if item.Valid() {
			projected = append(projected, item)
		}
	}
	return projected
}

func (c *daemonCapabilityController) HandleCapabilityRequest(
	ctx context.Context,
	request types.ResidentCapabilityRequest,
) (map[string]any, error) {
	if !request.Valid() {
		return nil, errors.New("invalid local capability request")
	}
	controller := c.current()
	if controller == nil {
		return nil, capability.ErrUnavailable
	}
	var result []byte
	switch request.Operation {
	case types.ResidentCapabilityObserve:
		observation, err := controller.Observe(ctx, request.CapabilityID)
		if err != nil {
			return nil, err
		}
		result = observation.State
	case types.ResidentCapabilityInvoke:
		args, err := json.Marshal(request.Args)
		if err != nil {
			return nil, capability.ErrInvalidArgs
		}
		invocation, err := controller.Invoke(ctx, request.CapabilityID, request.Action, args)
		if err != nil {
			return nil, err
		}
		result = invocation
	default:
		return nil, errors.New("unsupported local capability operation")
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(result))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, capability.ErrMalformedResponse
	}
	if object, ok := value.(map[string]any); ok {
		return object, nil
	}
	if request.Operation == types.ResidentCapabilityObserve {
		return map[string]any{"capabilityId": request.CapabilityID, "state": value}, nil
	}
	return map[string]any{"value": value}, nil
}
