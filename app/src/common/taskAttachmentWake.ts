// #363 (second review): the ACTIVE-Task composer is compose-first, so one
// Human Send can carry an attachment and text together. A Task-correlated
// Human attachment therefore must NOT derive its Agent wake from
// `senderKind === human && taskRequestId` alone: the composer decides whether
// this upload is the whole submission and sends that decision as one bounded
// token on the existing Task-correlated attachment upload. The Room persists
// it with the attachment record, so a reconnect/replay rebuilds the same
// `addressed` value — an immediate-only broadcast would not survive replay.
//
//   "1" => attachment-only submission: the persisted attachment addresses the
//          canonical participating Task Agent(s) and wakes an idle Harness.
//   "0" => attachment + text submission: the attachment is Task context only,
//          and the following addressed Task text is the single wake boundary.
//
// Anything else — including an absent header — is "no explicit wake intent"
// and never wakes an Agent on its own.
export const TASK_ATTACHMENT_WAKE_HEADER = "X-Task-Attachment-Wake"

export function encodeTaskAttachmentWake(wakeAgent: boolean): "1" | "0" {
  return wakeAgent ? "1" : "0"
}

/** Strict, bounded parse: only the two exact one-character tokens are
 * accepted, so no client string can smuggle a second wake intent. */
export function parseTaskAttachmentWake(
  value: string | null | undefined
): boolean | undefined {
  if (value === "1") return true
  if (value === "0") return false
  return undefined
}
