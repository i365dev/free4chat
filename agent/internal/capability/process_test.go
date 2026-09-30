package capability

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestProcessAdapterHelperProcess(t *testing.T) {
	separator := -1
	for index, arg := range os.Args {
		if arg == "--" {
			separator = index
			break
		}
	}
	if separator < 0 || separator+1 >= len(os.Args) {
		return
	}
	mode := os.Args[separator+1]
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1024), MaxFrameBytes)
	for scanner.Scan() {
		var request map[string]json.RawMessage
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			os.Exit(3)
		}
		var id, method, action string
		_ = json.Unmarshal(request["id"], &id)
		_ = json.Unmarshal(request["method"], &method)
		_ = json.Unmarshal(request["action"], &action)
		if mode == "timeout" {
			time.Sleep(4 * time.Second)
		}
		if mode == "crash" {
			os.Exit(4)
		}
		if method == "list" {
			switch mode {
			case "zero":
				writeAdapterHelperResponse(id, `[]`)
				continue
			case "multi":
				writeAdapterHelperResponse(id, `[`+descriptorJSON()+`,`+descriptorJSON()+`]`)
				continue
			case "malformed":
				fmt.Println("not-json")
				os.Exit(0)
			case "oversized":
				fmt.Println(strings.Repeat("x", MaxFrameBytes))
				os.Exit(0)
			case "wrong-version":
				fmt.Printf(`{"protocolVersion":2,"id":%q,"result":[]}`+"\n", id)
				os.Exit(0)
			case "wrong-id":
				fmt.Printf(`{"protocolVersion":1,"id":"wrong","result":[]}` + "\n")
				os.Exit(0)
			case "duplicate":
				frame := adapterHelperFrame(id, `[`+descriptorJSON()+`]`)
				fmt.Print(frame, frame)
				continue
			}
			writeAdapterHelperResponse(id, `[`+descriptorJSON()+`]`)
			continue
		}
		if method == "describe" {
			writeAdapterHelperResponse(id, descriptorJSON())
			continue
		}
		if method == "observe" {
			if mode == "env-probe" {
				secretPresent := os.Getenv("F4C_TEST_ADAPTER_SECRET") != ""
				result, _ := json.Marshal(map[string]bool{"secretPresent": secretPresent})
				writeAdapterHelperResponse(id, string(result))
			} else {
				writeAdapterHelperResponse(id, `{"ready":true}`)
			}
			continue
		}
		if method == "invoke" {
			if action == "unsupported" {
				fmt.Printf(`{"protocolVersion":1,"id":%q,"error":{"code":"unsupported_action"}}`+"\n", id)
			} else {
				writeAdapterHelperResponse(id, `{"ok":true}`)
			}
			continue
		}
		os.Exit(5)
	}
}

func descriptorJSON() string {
	return `{"capabilityId":"test_light","title":"Test light","version":"1","observe":true,"actions":[{"name":"turn_on","title":"Turn on","input":{"type":"object","properties":{"on":"boolean"},"required":["on"]}}]}`
}

func adapterHelperFrame(id, result string) string {
	return fmt.Sprintf(`{"protocolVersion":1,"id":%q,"result":%s}`+"\n", id, result)
}

func writeAdapterHelperResponse(id, result string) { fmt.Print(adapterHelperFrame(id, result)) }

func helperRegistration(mode string) Registration {
	return Registration{Command: os.Args[0], Args: []string{"-test.run=^TestProcessAdapterHelperProcess$", "--", mode}}
}

func TestProcessAdapterValidOperationsAndSecretEnvironmentIsolation(t *testing.T) {
	t.Setenv("F4C_TEST_ADAPTER_SECRET", "must-not-inherit")
	process, err := NewProcessAdapter(helperRegistration("normal"))
	if err != nil {
		t.Fatal(err)
	}
	defer process.Close()
	pid := process.cmd.Process.Pid
	controller := NewController(process)
	if descriptors := controller.DescribeAll(); len(descriptors) != 1 || descriptors[0].ID != "test_light" {
		t.Fatalf("list = %#v", descriptors)
	}
	if _, err := controller.Describe("test_light"); err != nil {
		t.Fatal(err)
	}
	if state, err := controller.Observe(context.Background(), "test_light"); err != nil || string(state.State) != `{"ready":true}` {
		t.Fatalf("observe = %#v, %v", state, err)
	}
	if result, err := controller.Invoke(context.Background(), "test_light", "turn_on", json.RawMessage(`{"on":true}`)); err != nil || string(result) != `{"ok":true}` {
		t.Fatalf("invoke = %s, %v", result, err)
	}
	if process.cmd.Process.Pid != pid || !process.Alive() {
		t.Fatal("Adapter process did not remain the single long-lived process")
	}
	if _, err := process.Invoke(context.Background(), "unsupported", json.RawMessage(`{}`)); !errors.Is(err, ErrUnsupportedAction) {
		t.Fatalf("unsupported action error = %v", err)
	}
	envProbe, err := NewProcessAdapter(helperRegistration("env-probe"))
	if err != nil {
		t.Fatal(err)
	}
	defer envProbe.Close()
	state, err := NewController(envProbe).Observe(context.Background(), "test_light")
	if err != nil || string(state.State) != `{"secretPresent":false}` {
		t.Fatalf("Adapter inherited an unrelated environment secret: %s (%v)", state.State, err)
	}
}

func TestProcessAdapterRejectsProtocolAndCountFailures(t *testing.T) {
	for _, mode := range []string{"wrong-version", "wrong-id", "malformed", "oversized", "duplicate", "timeout", "crash"} {
		t.Run(mode, func(t *testing.T) {
			_, err := NewProcessAdapter(helperRegistration(mode))
			if err == nil {
				t.Fatal("invalid Adapter was accepted")
			}
			if mode == "timeout" && !errors.Is(err, ErrTimeout) {
				t.Fatalf("timeout error = %v", err)
			}
		})
	}
	for _, mode := range []string{"zero", "multi"} {
		t.Run(mode, func(t *testing.T) {
			_, err := NewProcessAdapter(helperRegistration(mode))
			if !errors.Is(err, ErrCapabilityCount) {
				t.Fatalf("capability count error = %v", err)
			}
		})
	}
}

func TestProcessAdapterCloseReapsChild(t *testing.T) {
	process, err := NewProcessAdapter(helperRegistration("normal"))
	if err != nil {
		t.Fatal(err)
	}
	if err := process.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-process.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("Adapter process was not reaped")
	}
}

func TestProcessAdapterRegistrationValidation(t *testing.T) {
	for _, registration := range []Registration{
		{}, {Command: "python3", Args: make([]string, MaxAdapterArgs+1)},
		{Command: "python3", Args: []string{"bad\x00argument"}},
	} {
		if registration.Valid() {
			t.Errorf("invalid registration accepted: %#v", registration)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := ctx.Err(); err != nil {
		t.Fatal(err)
	}
}

func TestProcessAdapterPythonReferenceDogfood(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is required for the reference Adapter dogfood")
	}
	var mu sync.Mutex
	var requests []string
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests = append(requests, r.Method+" "+r.URL.Path)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /state":
			_, _ = w.Write([]byte(`{"ready":true,"brightness":42}`))
		case "POST /actions/set-led":
			var body map[string]string
			if json.NewDecoder(r.Body).Decode(&body) != nil || body["color"] != "#123456" {
				http.Error(w, "bad fixture request", http.StatusBadRequest)
				return
			}
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer fixture.Close()

	_, source, _, _ := runtime.Caller(0)
	adapterPath := filepath.Join(filepath.Dir(source), "..", "..", "experimental", "local-capability-adapter", "adapter.py")
	configPath := filepath.Join(t.TempDir(), "adapter-config.json")
	config, _ := json.Marshal(map[string]string{"fixtureBaseUrl": fixture.URL})
	if err := os.WriteFile(configPath, config, 0o600); err != nil {
		t.Fatal(err)
	}
	adapter, err := NewProcessAdapter(Registration{Command: python, Args: []string{adapterPath, "--config", configPath}})
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.Close()
	controller := NewController(adapter)
	listed, _ := json.Marshal(controller.DescribeAll())
	if strings.Contains(string(listed), fixture.URL) {
		t.Fatalf("fixture endpoint leaked through projection: %s", listed)
	}
	state, err := controller.Observe(context.Background(), "living_room_light")
	if err != nil || !strings.Contains(string(state.State), `"brightness":42`) {
		t.Fatalf("external observe = %s, %v", state.State, err)
	}
	result, err := controller.Invoke(context.Background(), "living_room_light", "set_led", json.RawMessage(`{"color":"#123456"}`))
	if err != nil || string(result) != `{"ok":true}` {
		t.Fatalf("external invoke = %s, %v", result, err)
	}
	mu.Lock()
	gotRequests := append([]string(nil), requests...)
	mu.Unlock()
	if strings.Join(gotRequests, ",") != "GET /state,POST /actions/set-led" {
		t.Fatalf("HTTP calls did not stay inside the Adapter implementation: %v", gotRequests)
	}
}
