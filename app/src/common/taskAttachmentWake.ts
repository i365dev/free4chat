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

// #421: PRE-TASK context staging for the Start Task modal's large brief.
//
// A large first brief must be INSIDE the canonical Task before the Task's
// first wake reaches the Runtime, otherwise the Agent's first turn can start
// without it. Free4Chat therefore allows ONE explicitly marked upload of a
// Human's own Task-correlated attachment for a Task requestId that does not
// exist yet: the browser pins the canonical id, uploads the brief against it,
// and only then creates the Task with the same id and an explicit
// `attachmentIds` reference. Nothing is inferred and nothing is global.
//
// The marker is one exact token, absent means "an unknown Task is still a hard
// refusal", and the upload stays bounded by the ordinary attachment store.
export const TASK_ATTACHMENT_PENDING_HEADER = "X-Task-Attachment-Pending"

export function parseTaskAttachmentPending(
  value: string | null | undefined
): boolean {
  return value === "1"
}
