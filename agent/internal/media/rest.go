package media

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/i365dev/free4chat/agent/internal/doctor"
)

// DecodedHandle is the participant capability decoded from the MCP
// participant handle (base64url(JSON), ported from the frozen Node
// participantHandle.ts). It is a bearer capability: room-scoped, held only
// inside the runtime/SFU client memory boundary.
type DecodedHandle struct {
	Room             string
	ParticipantID    string
	ParticipantToken string
}

// DecodeParticipantHandle parses and validates the handle. Any missing
// field fails closed with invalid_participant_handle.
func DecodeParticipantHandle(handle string) (DecodedHandle, error) {
	raw, err := base64.RawURLEncoding.DecodeString(handle)
	if err != nil {
		return DecodedHandle{}, errors.New("invalid_participant_handle")
	}
	var decoded struct {
		Room             string `json:"room"`
		ParticipantID    string `json:"participantId"`
		ParticipantToken string `json:"participantToken"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil ||
		decoded.Room == "" || decoded.ParticipantID == "" || decoded.ParticipantToken == "" {
		return DecodedHandle{}, errors.New("invalid_participant_handle")
	}
	return DecodedHandle{
		Room:             decoded.Room,
		ParticipantID:    decoded.ParticipantID,
		ParticipantToken: decoded.ParticipantToken,
	}, nil
}

// SiteOriginFromMCPURL derives the site origin from the MCP endpoint
// (same host, no path) — the SFU REST surface lives there.
func SiteOriginFromMCPURL(mcpURL string) (string, error) {
	parsed, err := url.Parse(mcpURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("invalid mcp url")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

// Purpose is the narrow, typed purpose every Agent signaling request must
// carry (the Worker/DO re-checks the matching grant per purpose).
type Purpose string

const (
	PurposeAgentTransport Purpose = "agent-transport"
	PurposeMeetingNotes   Purpose = "meeting-notes"
	PurposeVoiceReply     Purpose = "voice-reply"
)

// HumanMediaDiscoveryDenied is the DO's agent-room-media denial for an agent
// whose room has no active Meeting Notes grant — expected and tolerated at
// bootstrap when the shared session was admitted under voiceReply only.
const HumanMediaDiscoveryDenied = "meeting_notes_not_authorized"

// RoomMediaParticipant describes one Human's media state.
type RoomMediaParticipant struct {
	ParticipantID string      `json:"participantId"`
	Name          string      `json:"name"`
	SessionID     string      `json:"sessionId"`
	Tracks        []RoomTrack `json:"tracks"`
}

// RoomTrack is one remote track.
type RoomTrack struct {
	TrackName string `json:"trackName"`
	Kind      string `json:"kind"`
	Mid       string `json:"mid,omitempty"`
}

// PublishedAudioDiagnostic is the safe /agent-track-active projection.
type PublishedAudioDiagnostic struct {
	PublisherSessionLookupOK bool   `json:"publisher_session_lookup_ok"`
	MatchingTrackFound       bool   `json:"matching_track_found"`
	MatchingTrackStatus      string `json:"matching_track_status"` // active|inactive|waiting|unknown
	MatchingTrackHasMid      bool   `json:"matching_track_has_mid"`
	Active                   bool   `json:"active"`
}

// RestClientLike is the REST boundary the bridge depends on (fake-able).
type RestClientLike interface {
	CreateAgentSession() (string, error)
	EstablishDataChannelTransport(sessionID string, offer Description, purpose Purpose) (Description, error)
	RoomMedia() ([]RoomMediaParticipant, error)
	SubscribeTrack(sessionID, remoteSessionID, trackName string, purpose Purpose) (Description, string, error)
	PublishAudioTrack(sessionID, trackName, mid string, offer Description) (Description, error)
	Renegotiate(sessionID string, answer Description, purpose Purpose) error
	ConfirmPublishedAudioTrackActive(sessionID, trackName string) (bool, PublishedAudioDiagnostic, error)
}

// SfuRestClient is the thin REST client for the app's /api/sfu/* endpoints.
// No SFU credentials live here — only the participant token this Agent
// already holds from its normal room join. The token is never logged.
type SfuRestClient struct {
	siteOrigin string
	handle     DecodedHandle
	http       *http.Client
}

// NewSfuRestClient builds the client for one site origin + decoded handle.
func NewSfuRestClient(siteOrigin string, handle DecodedHandle) *SfuRestClient {
	return &SfuRestClient{
		siteOrigin: siteOrigin,
		handle:     handle,
		http:       &http.Client{Timeout: 30 * time.Second},
	}
}

func (c *SfuRestClient) base() map[string]any {
	return map[string]any{
		"room":          c.handle.Room,
		"participantId": c.handle.ParticipantID,
		"token":         c.handle.ParticipantToken,
	}
}

func (c *SfuRestClient) request(path, method string, body map[string]any) (map[string]any, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequest(method, c.siteOrigin+"/api/sfu/"+path, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	// The Worker's SFU origin allow-list requires the site origin; a Go
	// client does not add Origin automatically the way browser/Node fetch
	// does for cross-origin POSTs.
	request.Header.Set("Origin", c.siteOrigin)
	request.Header.Set("User-Agent", "free4chat-agent/"+doctor.Version)
	response, err := c.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("network_error")
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	var data map[string]any
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &data)
	}
	if data == nil {
		data = map[string]any{}
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		// Bounded diagnostics only: the stable machine error string (or the
		// HTTP status) — never the response body, SDP, or errorDescription.
		errorString, _ := data["error"].(string)
		if errorString == "" {
			errorCode, _ := data["errorCode"].(string)
			if errorCode != "" {
				errorString = "sfu_" + strings.ReplaceAll(path, "/", "_") + "_" + errorCode
			} else {
				errorString = fmt.Sprintf("SFU request failed (%d)", response.StatusCode)
			}
		}
		return nil, errors.New(errorString)
	}
	return data, nil
}

// CreateAgentSession creates this Agent's Cloudflare Realtime session
// (subscribe-only). Admission re-checks the current grant server-side.
func (c *SfuRestClient) CreateAgentSession() (string, error) {
	data, err := c.request("agent-session", http.MethodPost, c.base())
	if err != nil {
		return "", err
	}
	sessionID, _ := data["sessionId"].(string)
	if sessionID == "" {
		return "", errors.New("agent_session_invalid")
	}
	return sessionID, nil
}

// EstablishDataChannelTransport establishes the initial WebRTC transport
// exactly as the browser does, submitting the gathered LOCAL offer (client
// offer + server answer); the returned description's actual type is honored.
func (c *SfuRestClient) EstablishDataChannelTransport(sessionID string, offer Description, purpose Purpose) (Description, error) {
	body := c.base()
	body["sessionId"] = sessionID
	body["purpose"] = string(purpose)
	body["dataChannel"] = map[string]any{"location": "remote", "dataChannelName": "server-events"}
	body["sessionDescription"] = map[string]any{"type": offer.Type, "sdp": offer.SDP}
	data, err := c.request("datachannels/establish", http.MethodPost, body)
	if err != nil {
		return Description{}, err
	}
	return parseDescription(data["sessionDescription"])
}

// RoomMedia lists Human participants' sessionId/trackName (never exposed by
// the sanitized MCP room_info; authenticated with the participant token).
func (c *SfuRestClient) RoomMedia() ([]RoomMediaParticipant, error) {
	data, err := c.request("agent-room-media", http.MethodPost, c.base())
	if err != nil {
		return nil, err
	}
	rawParticipants, _ := data["participants"].([]any)
	participants := make([]RoomMediaParticipant, 0, len(rawParticipants))
	for _, raw := range rawParticipants {
		record, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		participantID, _ := record["participantId"].(string)
		sessionID, _ := record["sessionId"].(string)
		name, _ := record["name"].(string)
		rawTracks, _ := record["tracks"].([]any)
		tracks := make([]RoomTrack, 0, len(rawTracks))
		for _, rawTrack := range rawTracks {
			trackRecord, ok := rawTrack.(map[string]any)
			if !ok {
				continue
			}
			trackName, _ := trackRecord["trackName"].(string)
			kind, _ := trackRecord["kind"].(string)
			mid, _ := trackRecord["mid"].(string)
			if trackName == "" {
				continue
			}
			tracks = append(tracks, RoomTrack{TrackName: trackName, Kind: kind, Mid: mid})
		}
		if participantID == "" || sessionID == "" {
			continue
		}
		participants = append(participants, RoomMediaParticipant{
			ParticipantID: participantID, Name: name, SessionID: sessionID, Tracks: tracks,
		})
	}
	return participants, nil
}

// SubscribeTrack requests a remote subscription; returns Cloudflare's offer
// plus the matching track MID when present.
func (c *SfuRestClient) SubscribeTrack(sessionID, remoteSessionID, trackName string, purpose Purpose) (Description, string, error) {
	body := c.base()
	body["sessionId"] = sessionID
	body["purpose"] = string(purpose)
	body["tracks"] = []any{map[string]any{
		"location": "remote", "sessionId": remoteSessionID, "trackName": trackName,
	}}
	data, err := c.request("tracks", http.MethodPost, body)
	if err != nil {
		return Description{}, "", err
	}
	description, err := parseDescription(data["sessionDescription"])
	if err != nil {
		return Description{}, "", errors.New("no_session_description")
	}
	mid := ""
	if tracks, ok := data["tracks"].([]any); ok && len(tracks) > 0 {
		if first, ok := tracks[0].(map[string]any); ok {
			mid, _ = first["mid"].(string)
		}
	}
	return description, mid, nil
}

// PublishAudioTrack activates this agent's single outbound audio track on
// the upstream SFU (voice-reply purpose).
func (c *SfuRestClient) PublishAudioTrack(sessionID, trackName, mid string, offer Description) (Description, error) {
	body := c.base()
	body["sessionId"] = sessionID
	body["purpose"] = string(PurposeVoiceReply)
	body["tracks"] = []any{map[string]any{
		"location": "local", "trackName": trackName, "kind": "audio", "mid": mid,
	}}
	body["sessionDescription"] = map[string]any{"type": offer.Type, "sdp": offer.SDP}
	data, err := c.request("tracks", http.MethodPost, body)
	if err != nil {
		return Description{}, err
	}
	return parseDescription(data["sessionDescription"])
}

// Renegotiate submits a local answer (or fresh local description).
func (c *SfuRestClient) Renegotiate(sessionID string, answer Description, purpose Purpose) error {
	body := c.base()
	body["sessionId"] = sessionID
	body["purpose"] = string(purpose)
	body["sessionDescription"] = map[string]any{"type": answer.Type, "sdp": answer.SDP}
	_, err := c.request("renegotiate", http.MethodPut, body)
	return err
}

// ConfirmPublishedAudioTrackActive asks Cloudflare whether the publication
// is active; the Worker exposes it to Humans only on a positive result.
func (c *SfuRestClient) ConfirmPublishedAudioTrackActive(sessionID, trackName string) (bool, PublishedAudioDiagnostic, error) {
	body := c.base()
	body["sessionId"] = sessionID
	body["trackName"] = trackName
	data, err := c.request("agent-track-active", http.MethodPost, body)
	if err != nil {
		return false, PublishedAudioDiagnostic{}, err
	}
	diagnostic := PublishedAudioDiagnostic{
		PublisherSessionLookupOK: data["publisherSessionLookupOk"] == true,
		MatchingTrackFound:       data["matchingTrackFound"] == true,
		MatchingTrackHasMid:      data["matchingTrackHasMid"] == true,
		Active:                   data["active"] == true,
	}
	diagnostic.MatchingTrackStatus = "unknown"
	if status, ok := data["matchingTrackStatus"].(string); ok &&
		(status == "active" || status == "inactive" || status == "waiting") {
		diagnostic.MatchingTrackStatus = status
	}
	return diagnostic.Active, diagnostic, nil
}

func parseDescription(raw any) (Description, error) {
	record, ok := raw.(map[string]any)
	if !ok {
		return Description{}, errors.New("no_session_description")
	}
	descriptionType, _ := record["type"].(string)
	sdp, _ := record["sdp"].(string)
	if descriptionType == "" || sdp == "" {
		return Description{}, errors.New("no_session_description")
	}
	return Description{Type: descriptionType, SDP: sdp}, nil
}
