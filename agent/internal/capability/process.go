package capability

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

const (
	ProtocolVersion  = 1
	MaxFrameBytes    = 64 * 1024
	MaxAdapterArgs   = 16
	MaxAdapterArgLen = 1024
	MaxAdapterConfig = 16 * 1024
	MaxStderrBytes   = 8 * 1024
)

var unsafeAdapterPayloadPattern = regexp.MustCompile(`(?i)(https?://|"?(endpoint|url|credential|password|secret|token|authorization|cookie|adapter|protocol|hostname|accesskey)"?\s*[:=])`)

// Registration contains only executable identity and non-secret arguments.
// Adapter credentials and integration configuration remain Adapter-owned.
type Registration struct {
	Command string   `json:"command"`
	Args    []string `json:"args,omitempty"`
}

func (r Registration) Valid() bool {
	if strings.TrimSpace(r.Command) == "" || len(r.Command) > MaxAdapterArgLen || strings.ContainsRune(r.Command, '\x00') || len(r.Args) > MaxAdapterArgs {
		return false
	}
	total := len(r.Command)
	for _, arg := range r.Args {
		if len(arg) > MaxAdapterArgLen || strings.ContainsRune(arg, '\x00') {
			return false
		}
		total += len(arg)
	}
	return total <= MaxAdapterConfig
}

type protocolRequest struct {
	ProtocolVersion int             `json:"protocolVersion"`
	ID              string          `json:"id"`
	Method          string          `json:"method"`
	CapabilityID    string          `json:"capabilityId,omitempty"`
	Action          string          `json:"action,omitempty"`
	Args            json.RawMessage `json:"args,omitempty"`
}

type protocolResponse struct {
	ProtocolVersion int             `json:"protocolVersion"`
	ID              string          `json:"id"`
	Result          json.RawMessage `json:"result"`
	Error           *protocolError  `json:"error"`
}

type protocolError struct {
	Code string `json:"code"`
}

// ProcessAdapter is one daemon-owned stdio Adapter process. Calls are
// serialized; failures invalidate and reap the child so stale responses can
// never be paired with a later request.
type ProcessAdapter struct {
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	stdout     *bufio.Reader
	mu         sync.Mutex
	callMu     sync.Mutex
	request    uint64
	descriptor Descriptor
	done       chan struct{}
	closed     bool
	killOnce   sync.Once
	stderr     *boundedBuffer
}

type boundedBuffer struct {
	mu   sync.Mutex
	data []byte
}

func (b *boundedBuffer) Write(value []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	remaining := MaxStderrBytes - len(b.data)
	if remaining > 0 {
		if remaining > len(value) {
			remaining = len(value)
		}
		b.data = append(b.data, value[:remaining]...)
	}
	return len(value), nil
}

func NewProcessAdapter(registration Registration) (*ProcessAdapter, error) {
	if !registration.Valid() {
		return nil, ErrInvalidRegistration
	}
	cmd := exec.Command(registration.Command, registration.Args...)
	cmd.Env = adapterEnvironment()
	configureAdapterProcess(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, ErrUnavailable
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, ErrUnavailable
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, ErrUnavailable
	}
	process := &ProcessAdapter{
		cmd: cmd, stdin: stdin, stdout: bufio.NewReaderSize(stdout, 4096),
		done: make(chan struct{}), stderr: &boundedBuffer{},
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		_ = stderr.Close()
		return nil, ErrUnavailable
	}
	go func() { _, _ = io.Copy(process.stderr, stderr) }()
	go func() {
		_ = cmd.Wait()
		// Reap any ordinary descendants that kept the process group alive
		// after the Adapter parent exited.
		killAdapterProcess(cmd)
		close(process.done)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), RequestTimeout)
	defer cancel()
	listed, err := process.exchange(ctx, protocolRequest{Method: "list"})
	if err != nil {
		process.Close()
		return nil, err
	}
	var descriptors []types.RuntimeCapabilityProjection
	if strictJSONDecode(listed, &descriptors) != nil {
		process.fail()
		return nil, ErrMalformedResponse
	}
	if len(descriptors) != 1 {
		process.fail()
		return nil, ErrCapabilityCount
	}
	if unsafeAdapterPayloadPattern.Match(listed) || !descriptors[0].Valid() {
		process.fail()
		return nil, ErrMalformedResponse
	}
	encoded, _ := json.Marshal(descriptors[0])
	if len(encoded) > MaxDescriptor {
		process.fail()
		return nil, ErrTooLarge
	}
	described, err := process.exchange(ctx, protocolRequest{Method: "describe", CapabilityID: descriptors[0].CapabilityID})
	if err != nil {
		process.Close()
		return nil, err
	}
	var descriptor types.RuntimeCapabilityProjection
	if strictJSONDecode(described, &descriptor) != nil || unsafeAdapterPayloadPattern.Match(described) || !descriptor.Valid() || !bytes.Equal(encoded, mustJSON(descriptor)) {
		process.fail()
		return nil, ErrMalformedResponse
	}
	process.descriptor = descriptorToInternal(descriptor)
	return process, nil
}

func mustJSON(value any) []byte {
	encoded, _ := json.Marshal(value)
	return encoded
}

func strictJSONDecode(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return ErrMalformedResponse
	}
	return nil
}

func descriptorToInternal(descriptor types.RuntimeCapabilityProjection) Descriptor {
	result := Descriptor{ID: descriptor.CapabilityID, Title: descriptor.Title, Version: descriptor.Version, Actions: make([]ActionSchema, 0, len(descriptor.Actions))}
	if descriptor.Observe {
		result.Observe = "observe"
	}
	for _, action := range descriptor.Actions {
		result.Actions = append(result.Actions, ActionSchema{
			Name: action.Name, Title: action.Title,
			Properties: action.Input.Properties,
			Required:   action.Input.Required,
		})
	}
	return result
}

func adapterEnvironment() []string {
	// Do not inherit Runtime/vendor secrets. Adapters read their own local
	// configuration or native secret store; only basic process environment is
	// retained for executable lookup, locale, home, and temp-directory use.
	allowed := []string{"PATH", "HOME", "USER", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PATHEXT"}
	env := make([]string, 0, len(allowed))
	for _, key := range allowed {
		if value, exists := os.LookupEnv(key); exists {
			env = append(env, key+"="+value)
		}
	}
	return env
}

func (p *ProcessAdapter) Describe() Descriptor {
	if p == nil || !p.Alive() {
		return Descriptor{}
	}
	return p.descriptor
}

func (p *ProcessAdapter) Alive() bool {
	if p == nil {
		return false
	}
	select {
	case <-p.done:
		return false
	default:
		p.mu.Lock()
		alive := !p.closed
		p.mu.Unlock()
		return alive
	}
}

func (p *ProcessAdapter) Done() <-chan struct{} { return p.done }

func (p *ProcessAdapter) Observe(ctx context.Context) (json.RawMessage, error) {
	result, err := p.exchange(ctx, protocolRequest{Method: "observe", CapabilityID: p.descriptor.ID})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (p *ProcessAdapter) Invoke(ctx context.Context, action string, args json.RawMessage) (json.RawMessage, error) {
	result, err := p.exchange(ctx, protocolRequest{Method: "invoke", CapabilityID: p.descriptor.ID, Action: action, Args: args})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (p *ProcessAdapter) exchange(ctx context.Context, request protocolRequest) (json.RawMessage, error) {
	if p == nil {
		return nil, ErrUnavailable
	}
	p.callMu.Lock()
	defer p.callMu.Unlock()
	if !p.Alive() {
		return nil, ErrUnavailable
	}
	p.mu.Lock()
	p.request++
	request.ID = fmt.Sprintf("%d", p.request)
	p.mu.Unlock()
	request.ProtocolVersion = ProtocolVersion
	wire, err := json.Marshal(request)
	if err != nil || len(wire)+1 > MaxFrameBytes {
		return nil, ErrTooLarge
	}
	wire = append(wire, '\n')
	if err := writeFull(p.stdin, wire); err != nil {
		p.fail()
		return nil, ErrUnavailable
	}
	read := make(chan frameResult, 1)
	go func() {
		frame, err := readProtocolFrame(p.stdout)
		read <- frameResult{frame: frame, err: err}
	}()
	select {
	case <-ctx.Done():
		p.fail()
		return nil, ErrTimeout
	case <-p.done:
		p.fail()
		return nil, ErrUnavailable
	case result := <-read:
		if result.err != nil {
			p.fail()
			if errors.Is(result.err, ErrTooLarge) || errors.Is(result.err, ErrMalformedResponse) {
				return nil, result.err
			}
			return nil, ErrUnavailable
		}
		response, err := decodeProtocolResponse(result.frame, request.ID)
		if err != nil {
			p.fail()
			return nil, err
		}
		if response.Error != nil {
			mapped := protocolErrorToRuntime(response.Error.Code)
			if errors.Is(mapped, ErrMalformedResponse) {
				p.fail()
			}
			return nil, mapped
		}
		if len(response.Result) > MaxResultBytes {
			p.fail()
			return nil, ErrTooLarge
		}
		if unsafeAdapterPayloadPattern.Match(response.Result) {
			p.fail()
			return nil, ErrMalformedResponse
		}
		return response.Result, nil
	}
}

func writeFull(writer io.Writer, data []byte) error {
	for len(data) > 0 {
		written, err := writer.Write(data)
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
		data = data[written:]
	}
	return nil
}

type frameResult struct {
	frame []byte
	err   error
}

func readProtocolFrame(reader *bufio.Reader) ([]byte, error) {
	frame := make([]byte, 0, 1024)
	for {
		part, err := reader.ReadSlice('\n')
		if len(frame)+len(part) > MaxFrameBytes {
			return nil, ErrTooLarge
		}
		frame = append(frame, part...)
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil {
			return nil, err
		}
		if len(frame) < 2 || frame[len(frame)-1] != '\n' {
			return nil, ErrMalformedResponse
		}
		return frame[:len(frame)-1], nil
	}
}

func decodeProtocolResponse(frame []byte, expectedID string) (protocolResponse, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(frame, &fields) != nil || fields == nil {
		return protocolResponse{}, ErrMalformedResponse
	}
	for key := range fields {
		if key != "protocolVersion" && key != "id" && key != "result" && key != "error" {
			return protocolResponse{}, ErrMalformedResponse
		}
	}
	var response protocolResponse
	if json.Unmarshal(frame, &response) != nil || response.ProtocolVersion != ProtocolVersion || response.ID != expectedID || response.ID == "" {
		return protocolResponse{}, ErrMalformedResponse
	}
	_, hasResult := fields["result"]
	_, hasError := fields["error"]
	if hasResult == hasError {
		return protocolResponse{}, ErrMalformedResponse
	}
	if hasError {
		var shape map[string]json.RawMessage
		if json.Unmarshal(fields["error"], &shape) != nil || len(shape) != 1 || response.Error == nil || response.Error.Code == "" {
			return protocolResponse{}, ErrMalformedResponse
		}
	} else if len(response.Result) == 0 || !json.Valid(response.Result) {
		return protocolResponse{}, ErrMalformedResponse
	}
	return response, nil
}

func protocolErrorToRuntime(code string) error {
	switch code {
	case "invalid_request", "invalid_args":
		return ErrInvalidArgs
	case "unsupported_method", "unsupported_action":
		return ErrUnsupportedAction
	case "unknown_capability":
		return ErrUnknownCapability
	case "too_large":
		return ErrTooLarge
	case "unavailable", "internal":
		return ErrUnavailable
	default:
		return ErrMalformedResponse
	}
}

func (p *ProcessAdapter) fail() {
	if p == nil {
		return
	}
	p.killOnce.Do(func() {
		p.mu.Lock()
		p.closed = true
		p.mu.Unlock()
		_ = p.stdin.Close()
		killAdapterProcess(p.cmd)
		select {
		case <-p.done:
		case <-time.After(2 * time.Second):
		}
	})
}

func (p *ProcessAdapter) Close() error {
	if p == nil {
		return nil
	}
	p.callMu.Lock()
	defer p.callMu.Unlock()
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	p.mu.Unlock()
	_ = p.stdin.Close()
	select {
	case <-p.done:
		return nil
	case <-time.After(300 * time.Millisecond):
	}
	p.killOnce.Do(func() {
		killAdapterProcess(p.cmd)
	})
	select {
	case <-p.done:
		return nil
	case <-time.After(2 * time.Second):
		return fmt.Errorf("Adapter process failed to exit")
	}
}
