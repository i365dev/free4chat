package free4chat

// ErrorCode mirrors the Node client's error codes: the runtime rejoin and
// room-expiry lifecycle switches on these, so they must survive transport
// classification unchanged.
type ErrorCode string

const (
	CodeInvalidParticipantHandle ErrorCode = "invalid_participant_handle"
	CodeRoomExpired              ErrorCode = "room_expired"
	CodeTransient                ErrorCode = "transient"
	CodeToolError                ErrorCode = "tool_error"
)

// Error is a classified Free4Chat MCP failure.
type Error struct {
	Message string
	Code    ErrorCode
}

func (e *Error) Error() string { return e.Message }

// CodeOf extracts the classification from any error; non-typed failures are
// treated as transient by the runtime.
func CodeOf(err error) ErrorCode {
	if e, ok := err.(*Error); ok {
		return e.Code
	}
	return CodeTransient
}

// toolErrorCode maps a structured server-side tool error string onto the
// lifecycle codes (mirrors toToolErrorCode in the Node modern client).
func toolErrorCode(errorString string) ErrorCode {
	switch errorString {
	case "invalid_participant_handle":
		return CodeInvalidParticipantHandle
	case "room_expired":
		return CodeRoomExpired
	default:
		return CodeToolError
	}
}

// ClassifyHTTPStatus decides whether an HTTP status is retryable
// (>=500 or 429), mirroring the Node modern client.
func ClassifyHTTPStatus(status int) ErrorCode {
	if status >= 500 || status == 429 {
		return CodeTransient
	}
	return CodeToolError
}
