package runtime

import (
	"github.com/i365dev/free4chat/agent/internal/types"
)

const (
	maxImagesPerTurn = 2
	maxTextFileChars = 32_000
)

// ReadAttachmentFunc fetches one ephemeral attachment copy through the
// room client; implemented by the runtime with the live handle.
type ReadAttachmentFunc func(attachmentID string) (types.AttachmentRead, error)

// UnavailableFunc reports one failed enrichment without aborting the turn
// (attachments stay fail-open, matching the Node reference).
type UnavailableFunc func(event types.HarnessEvent, message string)

// EnrichTurnAttachments is the pure attachment-enrichment pass shared by the
// turn pipeline: text-like attachments become bounded inline textFile
// content; binary image attachments become image blocks (when the Harness
// negotiated image support, up to two per turn); per-event failures are
// reported and never abort the turn.
func EnrichTurnAttachments(
	input *types.HarnessTurnInput,
	readAttachment ReadAttachmentFunc,
	onUnavailable UnavailableFunc,
	options *EnrichOptions,
) {
	var imagesSupported bool
	if options == nil || options.ImagesSupported == nil {
		imagesSupported = true
	} else {
		imagesSupported = *options.ImagesSupported
	}
	imageCount := 0
	for i := range input.Events {
		event := &input.Events[i]
		if event.Attachment == nil {
			continue
		}
		attachment, err := readAttachment(event.Attachment.ID)
		if err != nil {
			message := err.Error()
			if onUnavailable != nil {
				onUnavailable(*event, message)
			}
			continue
		}
		if attachment.Text != "" {
			content := attachment.Text
			if len(content) > maxTextFileChars {
				content = content[:maxTextFileChars]
			}
			event.TextFile = &types.TextFileContent{
				FileName: event.Attachment.FileName,
				MimeType: attachment.MimeType,
				Content:  content,
			}
			continue
		}
		if !imagesSupported || imageCount >= maxImagesPerTurn {
			continue
		}
		event.Image = &types.HarnessImage{
			Data:     attachment.Data,
			MimeType: attachment.MimeType,
		}
		imageCount++
	}
}

// EnrichOptions carries per-turn tuning for enrichment.
type EnrichOptions struct {
	// ImagesSupported reflects the negotiated ACP image capability. Nil
	// defaults to true (matching the Node signature default).
	ImagesSupported *bool
}

// BuildHarnessTurn projects buffered room events into a bounded,
// untrusted-safe Harness turn input: sender names/kinds, collab envelopes
// resolved with fromName, self context, and roster. It never carries the
// participant capability handle.
func BuildHarnessTurn(
	events []types.RoomEvent,
	context *TurnContextOptions,
) *types.HarnessTurnInput {
	input := &types.HarnessTurnInput{
		Room: types.RoomTurnContext{Ephemeral: true},
	}
	if context != nil {
		input.Room.Self = context.Self
		if len(context.Participants) > 0 {
			input.Room.Participants = context.Participants
		}
	}
	for _, event := range events {
		normalized := types.HarnessEvent{
			Sender:        event.Participant.Name,
			Kind:          event.Participant.Kind,
			Text:          event.Text,
			ActionType:    event.ActionType,
			ActionPayload: event.ActionPayload,
			Addressed:     event.Addressed,
			Attachment:    event.Attachment,
			TextFile:      event.TextFile,
			Image:         event.Image,
			Sequence:      event.Sequence,
			CreatedAt:     event.CreatedAt,
		}
		if event.Collab != nil {
			collab := types.CollabEventView{
				WireCollabEvent: *event.Collab,
				FromName:        event.Participant.Name,
			}
			normalized.Collab = &collab
		}
		input.Events = append(input.Events, normalized)
	}
	return input
}

// TurnContextOptions bundles the stable per-room context for a turn.
type TurnContextOptions struct {
	Self         *types.RoomSelfContext
	Participants []types.ParticipantRosterEntry
}
