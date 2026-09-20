/**
 * #409/#421: the ONE large-paste → Task attachment primitive.
 *
 * A large paste is a Task BRIEF, not a chat message. Above a deliberate UX
 * threshold one pasted string becomes a generated text/markdown Task
 * attachment instead of textarea content, so a huge prompt cannot pollute the
 * Task conversation and cannot be silently truncated by a composer bound.
 *
 * It lives in `common` because two composers share exactly the same rule and
 * the same generated artifact:
 *
 *   - the Task composer inside an ACTIVE Task (#409), and
 *   - the Start Task modal's initial brief (#421).
 *
 * The threshold is a UX threshold, NOT a security or transport limit: the
 * bounded Task attachment path keeps its own hard store bound and an ordinary
 * Room message keeps the Room-level bound it already had. Character length
 * only — no token estimator, no LLM, no language-specific heuristics.
 */
export const TASK_PASTE_ATTACHMENT_THRESHOLD = 2000

/** Stable name/type for the generated Task brief attachment. */
export const TASK_PASTE_ATTACHMENT_FILE_NAME = "task-brief.md"
export const TASK_PASTE_ATTACHMENT_MIME_TYPE = "text/markdown"

/**
 * The Room's bounded Agent-readable attachment store (`MAX_AGENT_ATTACHMENT_BYTES`,
 * 768 KB). A paste beyond it cannot be preserved exactly, so the composer fails
 * closed with a visible message instead of silently dropping the tail.
 */
export const MAX_TASK_PASTE_BYTES = 768 * 1024

/**
 * A Start Task always needs a bounded canonical summary. When the Human pasted
 * a large brief and typed no separate instruction, this derives a short Task
 * label from the brief's first non-empty line. It is a LABEL only: the exact
 * content stays in the attachment, which the canonical Task event references
 * explicitly.
 */
export const MAX_TASK_BRIEF_LABEL_LENGTH = 120
export const TASK_BRIEF_DEFAULT_LABEL = "Read the attached brief"

export function taskPasteByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

/** Would this pasted string be converted into a Task brief attachment? */
export function isLargeTaskPaste(text: string): boolean {
  return text.length > TASK_PASTE_ATTACHMENT_THRESHOLD
}

/** Can the whole pasted string be preserved exactly as one attachment? */
export function taskPasteFitsAttachment(text: string): boolean {
  return text.length > 0 && taskPasteByteLength(text) <= MAX_TASK_PASTE_BYTES
}

/**
 * Exact content, byte for byte: no trim, no normalization, no wrapper prose,
 * no summary, no truncation.
 */
export function taskPasteAttachment(text: string): File {
  return new File([text], TASK_PASTE_ATTACHMENT_FILE_NAME, {
    type: TASK_PASTE_ATTACHMENT_MIME_TYPE,
  })
}

/**
 * The bounded canonical Task label for a brief-only start. Empty when the
 * brief has no usable text at all, so the caller can fall back explicitly
 * instead of creating a Task with an empty summary.
 */
export function taskBriefLabel(text: string): string {
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/^[#>\-*\s]+/, "").trim()
    if (!line) continue
    return line.slice(0, MAX_TASK_BRIEF_LABEL_LENGTH)
  }
  return ""
}
