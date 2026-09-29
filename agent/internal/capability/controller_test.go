package capability

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestFixtureControllerDescribeObserveInvokeAndBounds(t *testing.T) {
	const privateURL = "http://127.0.0.1:43127"
	var observedAction bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/state":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"color":"#00ff00","available":true}`))
		case r.Method == http.MethodPost && r.URL.Path == "/actions/set-led":
			observedAction = true
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["color"] != "#ff0000" {
				t.Errorf("unexpected fixed action payload: %#v, %v", body, err)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	endpoint := strings.Replace(server.URL, "127.0.0.1", "127.0.0.1", 1)
	adapter, err := NewFixtureAdapter(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	c := NewController(adapter)

	descriptor, err := c.Describe(CapabilityID)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(descriptor)
	if strings.Contains(string(encoded), privateURL) || strings.Contains(string(encoded), server.URL) {
		t.Fatalf("descriptor leaked local endpoint: %s", encoded)
	}
	if _, err := c.Describe("other"); !errors.Is(err, ErrUnknownCapability) {
		t.Fatalf("unknown capability error = %v", err)
	}

	observation, err := c.Observe(context.Background(), CapabilityID)
	if err != nil || string(observation.State) != `{"color":"#00ff00","available":true}` {
		t.Fatalf("observe = %#v, %v", observation, err)
	}
	if strings.Contains(string(observation.State), server.URL) {
		t.Fatalf("observation leaked endpoint: %s", observation.State)
	}
	result, err := c.Invoke(context.Background(), CapabilityID, "set_led", json.RawMessage(`{"color":"#ff0000"}`))
	if err != nil || string(result) != `{"ok":true}` || !observedAction {
		t.Fatalf("invoke = %s, called=%t, err=%v", result, observedAction, err)
	}
	if strings.Contains(string(result), server.URL) {
		t.Fatalf("invocation result leaked endpoint: %s", result)
	}
	if _, err := c.Invoke(context.Background(), CapabilityID, "delete", json.RawMessage(`{}`)); !errors.Is(err, ErrUnsupportedAction) {
		t.Fatalf("unsupported action error = %v", err)
	}
	for _, args := range []string{`{}`, `{"color":"red"}`, `{"color":"#ff0000","extra":true}`, `null`} {
		if _, err := c.Invoke(context.Background(), CapabilityID, "set_led", json.RawMessage(args)); !errors.Is(err, ErrInvalidArgs) {
			t.Errorf("invalid args %s error = %v", args, err)
		}
	}
	if _, err := c.Invoke(context.Background(), CapabilityID, "set_led", json.RawMessage("{\"color\":\"#ff0000\"}"+strings.Repeat(" ", MaxArgsBytes))); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversized args error = %v", err)
	}
}

func TestUnconfiguredControllerFailsPredictably(t *testing.T) {
	var c *Controller
	if _, err := c.Describe(CapabilityID); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unconfigured describe error = %v", err)
	}
	if _, err := c.Observe(context.Background(), CapabilityID); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unconfigured observe error = %v", err)
	}
	if _, err := c.Invoke(context.Background(), CapabilityID, "set_led", json.RawMessage(`{"color":"#123456"}`)); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unconfigured invoke error = %v", err)
	}
}

func TestFixtureControllerFailuresAreBoundedAndSanitized(t *testing.T) {
	secretURL := "http://localhost:43211"
	for name, handler := range map[string]http.HandlerFunc{
		"unavailable": func(w http.ResponseWriter, r *http.Request) { http.Error(w, "secret body", http.StatusBadGateway) },
		"oversized": func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"state":"` + strings.Repeat("x", MaxResultBytes) + `"}`))
		},
		"malformed": func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("not-json-secret")) },
		"timeout": func(w http.ResponseWriter, r *http.Request) {
			time.Sleep(100 * time.Millisecond)
			_, _ = w.Write([]byte(`{}`))
		},
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(handler)
			defer server.Close()
			adapter, err := NewFixtureAdapter(strings.Replace(server.URL, "127.0.0.1", "localhost", 1))
			if err != nil {
				t.Fatal(err)
			}
			c := NewController(adapter)
			if name == "timeout" {
				c.timeout = 10 * time.Millisecond
			}
			_, err = c.Observe(context.Background(), CapabilityID)
			if err == nil {
				t.Fatal("expected failure")
			}
			if strings.Contains(err.Error(), secretURL) || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), server.URL) {
				t.Fatalf("error leaked local details: %v", err)
			}
			switch name {
			case "unavailable":
				if !errors.Is(err, ErrUnavailable) {
					t.Fatalf("error = %v", err)
				}
			case "oversized":
				if !errors.Is(err, ErrTooLarge) {
					t.Fatalf("error = %v", err)
				}
			case "malformed":
				if !errors.Is(err, ErrMalformedResponse) {
					t.Fatalf("error = %v", err)
				}
			case "timeout":
				if !errors.Is(err, ErrTimeout) {
					t.Fatalf("error = %v", err)
				}
			}
		})
	}
}

func TestFixtureEndpointIsLoopbackOnlyAndFixedOrigin(t *testing.T) {
	for _, endpoint := range []string{
		"https://127.0.0.1:1234", "http://192.168.1.2:1234", "http://localhost:1234/arbitrary",
		"http://user:pass@localhost:1234", "http://localhost:1234?x=y", "http://localhost", "http://localhost:65536",
	} {
		if _, err := NewFixtureAdapter(endpoint); !errors.Is(err, ErrUnavailable) {
			t.Errorf("endpoint %q accepted, err=%v", endpoint, err)
		}
	}
}

func TestFixtureResponseCannotReflectLocalEndpoint(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"endpoint":"` + server.URL + `"}`))
	}))
	defer server.Close()
	adapter, err := NewFixtureAdapter(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	_, err = NewController(adapter).Observe(context.Background(), CapabilityID)
	if !errors.Is(err, ErrMalformedResponse) || strings.Contains(err.Error(), server.URL) {
		t.Fatalf("endpoint reflection error = %v", err)
	}
}

func TestConfigPersistsOnlyPrivateLocalEndpoint(t *testing.T) {
	dir := t.TempDir()
	if err := SaveFixtureEndpoint(dir, "http://127.0.0.1:43127"); err != nil {
		t.Fatal(err)
	}
	adapter, err := LoadFixtureAdapter(dir)
	if err != nil || adapter == nil {
		t.Fatalf("load configured adapter: %v", err)
	}
}
