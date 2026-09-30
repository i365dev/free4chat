package capability

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

type semanticTestAdapter struct {
	descriptor Descriptor
	observe    json.RawMessage
	invoke     json.RawMessage
	observeErr error
	invokeErr  error
}

func (a *semanticTestAdapter) Describe() Descriptor { return a.descriptor }
func (a *semanticTestAdapter) Observe(context.Context) (json.RawMessage, error) {
	return a.observe, a.observeErr
}
func (a *semanticTestAdapter) Invoke(_ context.Context, _ string, _ json.RawMessage) (json.RawMessage, error) {
	return a.invoke, a.invokeErr
}

func validTestDescriptor() Descriptor {
	return Descriptor{
		ID: "test_light", Title: "Test light", Version: "1", Observe: "observe",
		Actions: []ActionSchema{{
			Name: "turn_on", Title: "Turn on",
			Properties: map[string]string{"on": "boolean", "level": "number"},
			Required:   []string{"on"},
		}},
	}
}

func TestControllerDescribeObserveInvokeAndBounds(t *testing.T) {
	adapter := &semanticTestAdapter{descriptor: validTestDescriptor(), observe: json.RawMessage(`{"ready":true}`), invoke: json.RawMessage(`{"ok":true}`)}
	controller := NewController(adapter)

	descriptors := controller.DescribeAll()
	if len(descriptors) != 1 || descriptors[0].ID != "test_light" {
		t.Fatalf("descriptors = %#v", descriptors)
	}
	if _, err := controller.Describe("missing"); !errors.Is(err, ErrUnknownCapability) {
		t.Fatalf("unknown capability error = %v", err)
	}
	observation, err := controller.Observe(context.Background(), "test_light")
	if err != nil || string(observation.State) != `{"ready":true}` {
		t.Fatalf("observe = %#v, %v", observation, err)
	}
	result, err := controller.Invoke(context.Background(), "test_light", "turn_on", json.RawMessage(`{"on":true,"level":0.5}`))
	if err != nil || string(result) != `{"ok":true}` {
		t.Fatalf("invoke = %s, %v", result, err)
	}
	if _, err := controller.Invoke(context.Background(), "test_light", "missing", json.RawMessage(`{}`)); !errors.Is(err, ErrUnsupportedAction) {
		t.Fatalf("unsupported action error = %v", err)
	}
	for _, args := range []string{`{}`, `null`, `[]`, `{"on":"yes"}`, `{"on":true,"unexpected":0}`} {
		if _, err := controller.Invoke(context.Background(), "test_light", "turn_on", json.RawMessage(args)); !errors.Is(err, ErrInvalidArgs) {
			t.Errorf("invalid args %s error = %v", args, err)
		}
	}
	if _, err := controller.Invoke(context.Background(), "test_light", "turn_on", json.RawMessage(strings.Repeat("x", MaxArgsBytes+1))); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversized args error = %v", err)
	}
}

func TestControllerRejectsInvalidDescriptorsAndResults(t *testing.T) {
	t.Run("secret-shaped descriptor", func(t *testing.T) {
		descriptor := validTestDescriptor()
		descriptor.Title = "http://127.0.0.1:1234"
		if got := NewController(&semanticTestAdapter{descriptor: descriptor}).DescribeAll(); len(got) != 0 {
			t.Fatalf("unsafe descriptor accepted: %#v", got)
		}
	})
	for name, result := range map[string]json.RawMessage{
		"oversized": json.RawMessage(`{"value":"` + strings.Repeat("x", MaxResultBytes) + `"}`),
		"malformed": json.RawMessage(`not-json`),
	} {
		t.Run(name, func(t *testing.T) {
			controller := NewController(&semanticTestAdapter{descriptor: validTestDescriptor(), observe: result})
			_, err := controller.Observe(context.Background(), "test_light")
			if name == "oversized" && !errors.Is(err, ErrTooLarge) {
				t.Fatalf("error = %v", err)
			}
			if name == "malformed" && !errors.Is(err, ErrMalformedResponse) {
				t.Fatalf("error = %v", err)
			}
		})
	}
	controller := NewController(&semanticTestAdapter{descriptor: validTestDescriptor(), observeErr: context.DeadlineExceeded})
	controller.timeout = 10 * time.Millisecond
	_, err := controller.Observe(context.Background(), "test_light")
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("timeout error = %v", err)
	}
}

func TestUnconfiguredControllerFailsPredictably(t *testing.T) {
	var controller *Controller
	if _, err := controller.Describe("test_light"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("describe error = %v", err)
	}
	if _, err := controller.Observe(context.Background(), "test_light"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("observe error = %v", err)
	}
	if _, err := controller.Invoke(context.Background(), "test_light", "turn_on", json.RawMessage(`{"on":true}`)); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("invoke error = %v", err)
	}
}

func TestRegistrationConfigStoresOnlyCommandAndArgs(t *testing.T) {
	dir := t.TempDir()
	registration := Registration{Command: "/usr/bin/python3", Args: []string{"adapter.py", "--config", "./adapter-config.json"}}
	if err := SaveRegistration(dir, registration); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadRegistration(dir)
	if err != nil || loaded == nil || loaded.Command != registration.Command || strings.Join(loaded.Args, "\x00") != strings.Join(registration.Args, "\x00") {
		t.Fatalf("loaded registration = %#v, %v", loaded, err)
	}
	if err := RemoveRegistration(dir); err != nil {
		t.Fatal(err)
	}
	loaded, err = LoadRegistration(dir)
	if err != nil || loaded != nil {
		t.Fatalf("registration after remove = %#v, %v", loaded, err)
	}
}
