// Package main implements a bounded, non-production Pion/Cloudflare SFU
// transport spike for free4chat issue #100 Phase 1.
//
// This is a disposable local protocol experiment. It is NOT production code,
// is NOT imported by the Worker or agent-runtime, and must be easy to delete.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Tracer records staged protocol evidence (A–I) and full local debug dumps.
//
// LOCAL DEBUGGING POLICY (issue #100 Phase 1 brief §7/§8): this is a
// disposable local experiment — dump ANYTHING useful to the dump dir
// (complete SDP, ICE candidates, HTTP bodies, RTP headers). The only hard
// rule is publication discipline: never commit these artifacts or any
// participant capability into the repository.
type Tracer struct {
	mu      sync.Mutex
	dir     string
	stage   string
	journal *os.File // webrtc-state.jsonl
	httpLog *os.File // http-trace.jsonl
}

func NewTracer(dir string) (*Tracer, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	t := &Tracer{dir: dir}
	var err error
	if t.journal, err = os.Create(filepath.Join(dir, "webrtc-state.jsonl")); err != nil {
		return nil, err
	}
	if t.httpLog, err = os.Create(filepath.Join(dir, "http-trace.jsonl")); err != nil {
		return nil, err
	}
	return t, nil
}

// Stagef marks a named protocol stage transition and prints it. Stages are
// A–I per the issue #100 Phase 1 brief; the last successful stage is what a
// FAIL verdict reports.
func (t *Tracer) Stagef(stage, format string, args ...any) {
	t.mu.Lock()
	t.stage = stage
	t.mu.Unlock()
	msg := fmt.Sprintf(format, args...)
	line := fmt.Sprintf("[%s] %s", stage, msg)
	fmt.Fprintln(osStderr, line)
	t.Event(map[string]any{"event": "stage", "stage": stage, "detail": msg})
}

// Info logs a diagnostic line inside the current stage.
func (t *Tracer) Info(format string, args ...any) {
	fmt.Fprintf(osStderr, "      %s\n", fmt.Sprintf(format, args...))
	t.Event(map[string]any{"event": "info", "stage": t.Current(), "detail": fmt.Sprintf(format, args...)})
}

// Fail prints the exact failing stage + reason in the machine-readable
// verdict format and exits non-zero.
func (t *Tracer) Fail(reason string) {
	t.mu.Lock()
	stage := t.stage
	t.mu.Unlock()
	fmt.Printf("RESULT FAIL last_stage=%s reason=%q\n", stage, reason)
	os.Exit(1)
}

func (t *Tracer) Current() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.stage
}

// Event appends one JSON object to webrtc-state.jsonl.
func (t *Tracer) Event(obj map[string]any) {
	obj["ts"] = time.Now().UTC().Format(time.RFC3339Nano)
	b, err := json.Marshal(obj)
	if err != nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.journal != nil {
		fmt.Fprintf(t.journal, "%s\n", b)
	}
}

// Dump writes a named artifact file into the dump dir and returns its path.
// Names conventionally match issue #100 brief §8 (e.g. initial-local-offer.sdp).
func (t *Tracer) Dump(name string, data []byte) string {
	p := filepath.Join(t.dir, name)
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Info("dump %s failed: %v", name, err)
		return ""
	}
	return p
}

// DumpJSON marshals v and dumps it as <name>.json.
func (t *Tracer) DumpJSON(name string, v any) string {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return ""
	}
	return t.Dump(name+".json", b)
}

// AppendJSONL appends one JSON object line to <name>.jsonl (for ice-candidates,
// rtp-headers, etc.). Thread-safe.
func (t *Tracer) AppendJSONL(name string, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	f, err := os.OpenFile(filepath.Join(t.dir, name), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s\n", b)
}

// HTTPTrace records one full request/response exchange (local debugging only).
func (t *Tracer) HTTPTrace(method, url string, status int, dur time.Duration, reqBody, respBody []byte) {
	rec := map[string]any{
		"ts":     time.Now().UTC().Format(time.RFC3339Nano),
		"method": method,
		"url":    url,
		"status": status,
		"ms":     dur.Milliseconds(),
		"req":    strings.TrimSpace(string(reqBody)),
		"resp":   strings.TrimSpace(string(respBody)),
	}
	b, _ := json.Marshal(rec)
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.httpLog != nil {
		fmt.Fprintf(t.httpLog, "%s\n", b)
	}
}

func (t *Tracer) Close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.journal != nil {
		t.journal.Close()
	}
	if t.httpLog != nil {
		t.httpLog.Close()
	}
}

// SortedKeys is a tiny test-friendly helper used by response inspection.
func SortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

type appendFile struct {
	path string
	f    *os.File
}

func newAppendFile(dir, name string) *appendFile {
	p := filepath.Join(dir, name)
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return &appendFile{path: p}
	}
	return &appendFile{path: p, f: f}
}

func (a *appendFile) append(b []byte) {
	if a.f != nil {
		_, _ = a.f.Write(b)
	}
}

func (a *appendFile) close() {
	if a.f != nil {
		_ = a.f.Close()
	}
}

var osStderr = os.Stderr
