package runtime

import (
	"errors"

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
// negotiated image support, up to two per turn). Structured collaboration
// attachment references are resolved into their own bounded collection rather
// than being collapsed into the singular event.Attachment field. Reads are
// cached within the turn, and per-reference failures are reported without
// aborting the collaboration lifecycle.
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
	textChars := 0
	type resolution struct {
		read types.AttachmentRead
		err  error
	}
	cache := make(map[string]resolution)
	resolve := func(attachmentID string) (types.AttachmentRead, error) {
		if cached, ok := cache[attachmentID]; ok {
			return cached.read, cached.err
		}
		read, err := readAttachment(attachmentID)
		cache[attachmentID] = resolution{read: read, err: err}
		return read, err
	}
	reportUnavailable := func(event types.HarnessEvent, attachmentID string, err error) {
		if onUnavailable == nil {
			return
		}
		if event.Attachment == nil || event.Attachment.ID != attachmentID {
			// Keep the existing callback shape while making the referenced id
			// available to the Runtime's secret-free diagnostic logger.
			event.Attachment = &types.RoomAttachmentMetadata{ID: attachmentID}
		}
		onUnavailable(event, err.Error())
	}
	addText := func(fileName, mimeType, content string) *types.TextFileContent {
		remaining := maxTextFileChars - textChars
		if remaining <= 0 {
			return nil
		}
		if len(content) > remaining {
			content = content[:remaining]
		}
		textChars += len(content)
		return &types.TextFileContent{
			FileName: fileName,
			MimeType: mimeType,
			Content:  content,
		}
	}
	explicitAttachmentIDs := make(map[string]struct{})
	resolveCollabAttachments := func(event *types.HarnessEvent) {
		if event.Collab == nil {
			return
		}
		seen := make(map[string]struct{}, len(event.Collab.AttachmentIDs))
		for _, attachmentID := range event.Collab.AttachmentIDs {
			explicitAttachmentIDs[attachmentID] = struct{}{}
			if _, duplicate := seen[attachmentID]; duplicate {
				continue
			}
			seen[attachmentID] = struct{}{}
			referenced := types.HarnessReferencedAttachment{ID: attachmentID}
			attachment, err := resolve(attachmentID)
			if err != nil {
				referenced.Unavailable = true
				reportUnavailable(*event, attachmentID, err)
				event.ReferencedAttachments = append(event.ReferencedAttachments, referenced)
				continue
			}
			referenced.FileName = firstNonEmpty(attachment.FileName, attachmentID)
			referenced.MimeType = attachment.MimeType
			switch {
			case attachment.Text != "":
				referenced.TextFile = addText(
					referenced.FileName,
					attachment.MimeType,
					attachment.Text,
				)
				if referenced.TextFile == nil {
					referenced.Unavailable = true
				}
			case attachment.Data != "" && imagesSupported && imageCount < maxImagesPerTurn:
				referenced.Image = &types.HarnessImage{
					Data:     attachment.Data,
					MimeType: attachment.MimeType,
				}
				imageCount++
			case attachment.Data != "":
				// The bytes stay out of the prompt when the ACP session does
				// not negotiate image support or the turn image bound is full.
				// The reference remains visible as metadata-only context.
			default:
				referenced.Unavailable = true
				reportUnavailable(*event, attachmentID, errors.New("attachment content is unavailable"))
			}
			event.ReferencedAttachments = append(event.ReferencedAttachments, referenced)
		}
	}
	// Explicit collaboration references are the reliable handoff primitive;
	// resolve and charge them before incidental standalone attachment context.
	for i := range input.Events {
		resolveCollabAttachments(&input.Events[i])
	}
	for i := range input.Events {
		event := &input.Events[i]
		if event.Attachment == nil {
			continue
		}
		attachmentID := event.Attachment.ID
		if _, referenced := explicitAttachmentIDs[attachmentID]; referenced {
			// Keep the correlated content under ReferencedAttachments rather
			// than charging or duplicating it as incidental context.
			continue
		}
		attachment, err := resolve(attachmentID)
		if err != nil {
			reportUnavailable(*event, attachmentID, err)
		} else if attachment.Text != "" {
			event.TextFile = addText(
				firstNonEmpty(attachment.FileName, event.Attachment.FileName, attachmentID),
				firstNonEmpty(attachment.MimeType, event.Attachment.MimeType),
				attachment.Text,
			)
		} else if attachment.Data != "" && imagesSupported && imageCount < maxImagesPerTurn {
			event.Image = &types.HarnessImage{
				Data:     attachment.Data,
				MimeType: firstNonEmpty(attachment.MimeType, event.Attachment.MimeType),
			}
			imageCount++
		}
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

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
