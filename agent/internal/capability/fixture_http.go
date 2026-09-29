package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const fixtureMaxResponseBytes = MaxResultBytes

// FixtureAdapter is the only network adapter in Phase 1. It accepts one
// loopback origin, uses fixed paths and methods, and never follows redirects.
type FixtureAdapter struct {
	baseURL string
	client  *http.Client
}

func NewFixtureAdapter(endpoint string) (*FixtureAdapter, error) {
	u, err := validateFixtureEndpoint(endpoint)
	if err != nil {
		return nil, ErrUnavailable
	}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, splitErr := net.SplitHostPort(address)
			if splitErr != nil || port != u.Port() {
				return nil, ErrUnavailable
			}
			ips := make([]net.IP, 0, 2)
			if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil {
				ips = append(ips, ip)
			} else {
				addresses, lookupErr := net.DefaultResolver.LookupIPAddr(ctx, host)
				if lookupErr != nil {
					return nil, ErrUnavailable
				}
				for _, candidate := range addresses {
					if candidate.IP.IsLoopback() {
						ips = append(ips, candidate.IP)
					}
				}
			}
			if len(ips) == 0 {
				return nil, ErrUnavailable
			}
			var lastErr error
			for _, ip := range ips {
				if !ip.IsLoopback() {
					continue
				}
				conn, dialErr := (&net.Dialer{Timeout: RequestTimeout}).DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
				if dialErr == nil {
					return conn, nil
				}
				lastErr = dialErr
			}
			if lastErr != nil {
				return nil, lastErr
			}
			return nil, ErrUnavailable
		},
	}
	return &FixtureAdapter{
		baseURL: strings.TrimRight(u.String(), "/"),
		client: &http.Client{
			Transport: transport,
			Timeout:   RequestTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

func validateFixtureEndpoint(raw string) (*url.URL, error) {
	if len(raw) == 0 || len(raw) > 256 || strings.TrimSpace(raw) != raw {
		return nil, errors.New("invalid endpoint")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("invalid endpoint")
	}
	if u.Port() == "" || u.Hostname() == "" {
		return nil, errors.New("invalid endpoint")
	}
	host := strings.ToLower(u.Hostname())
	ip := net.ParseIP(host)
	if (ip == nil && host != "localhost") || (ip != nil && !ip.IsLoopback()) {
		return nil, errors.New("invalid endpoint")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return nil, errors.New("invalid endpoint")
	}
	return u, nil
}

func (a *FixtureAdapter) Describe() Descriptor {
	return Descriptor{
		ID:      CapabilityID,
		Title:   "Local fixture",
		Version: "1",
		Observe: "state",
		Actions: []ActionSchema{{
			Name:       "set_led",
			Title:      "Set color",
			Args:       `{"color":"#RRGGBB"}`,
			Properties: map[string]string{"color": "string"},
			Required:   []string{"color"},
		}},
	}
}

func (a *FixtureAdapter) Observe(ctx context.Context) (json.RawMessage, error) {
	return a.get(ctx, a.baseURL+"/state")
}

func (a *FixtureAdapter) Invoke(ctx context.Context, action string, args json.RawMessage) (json.RawMessage, error) {
	if action != "set_led" {
		return nil, ErrUnsupportedAction
	}
	var decoded struct {
		Color string `json:"color"`
	}
	if len(args) == 0 || len(args) > MaxArgsBytes || json.Unmarshal(args, &decoded) != nil || !validColor(decoded.Color) {
		return nil, ErrInvalidArgs
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(args, &fields) != nil || len(fields) != 1 || fields["color"] == nil {
		return nil, ErrInvalidArgs
	}
	body, _ := json.Marshal(struct {
		Color string `json:"color"`
	}{Color: decoded.Color})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL+"/actions/set-led", bytes.NewReader(body))
	if err != nil {
		return nil, ErrUnavailable
	}
	req.Header.Set("Content-Type", "application/json")
	return a.do(req)
}

func validColor(color string) bool {
	if len(color) != 7 || color[0] != '#' {
		return false
	}
	for _, ch := range color[1:] {
		if !(ch >= '0' && ch <= '9' || ch >= 'a' && ch <= 'f' || ch >= 'A' && ch <= 'F') {
			return false
		}
	}
	return true
}

func (a *FixtureAdapter) get(ctx context.Context, endpoint string) (json.RawMessage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, ErrUnavailable
	}
	return a.do(req)
}

func (a *FixtureAdapter) do(req *http.Request) (json.RawMessage, error) {
	resp, err := a.client.Do(req)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, ErrUnavailable
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, fixtureMaxResponseBytes+1))
	if err != nil {
		return nil, ErrUnavailable
	}
	if len(data) > fixtureMaxResponseBytes {
		return nil, ErrTooLarge
	}
	if !json.Valid(data) {
		return nil, ErrMalformedResponse
	}
	if bytes.Contains(data, []byte(a.baseURL)) {
		return nil, ErrMalformedResponse
	}
	return json.RawMessage(data), nil
}
