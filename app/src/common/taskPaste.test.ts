import { describe, expect, it } from "vitest"

import {
  isLargeTaskPaste,
  MAX_TASK_PASTE_BYTES,
  taskBriefLabel,
  taskPasteAttachment,
  taskPasteByteLength,
  taskPasteFitsAttachment,
  TASK_BRIEF_DEFAULT_LABEL,
  TASK_PASTE_ATTACHMENT_FILE_NAME,
  TASK_PASTE_ATTACHMENT_MIME_TYPE,
  TASK_PASTE_ATTACHMENT_THRESHOLD,
} from "./taskPaste"

/**
 * #421: the ONE large-paste → Task brief primitive shared by the active-Task
 * composer and the Start Task modal.
 */
/** jsdom's File has no `text()` in every runtime the suite covers. */
function fileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}

describe("shared Task big-paste primitive (#421)", () => {
  it("keeps an ordinary brief inline", () => {
    expect(isLargeTaskPaste("")).toBe(false)
    expect(isLargeTaskPaste("Fix the flaky test")).toBe(false)
    expect(isLargeTaskPaste("x".repeat(TASK_PASTE_ATTACHMENT_THRESHOLD))).toBe(
      false
    )
    expect(
      isLargeTaskPaste("x".repeat(TASK_PASTE_ATTACHMENT_THRESHOLD + 1))
    ).toBe(true)
  })

  it("preserves the exact pasted document, byte for byte", async () => {
    const brief = [
      "# Handoff",
      "",
      "  keep   leading spaces, trailing spaces  ",
      "unicode: 中文 — ok",
      "```ts",
      "const x = 1",
      "```",
    ].join("\n")
    const file = taskPasteAttachment(brief)
    expect(file.name).toBe(TASK_PASTE_ATTACHMENT_FILE_NAME)
    expect(file.type).toBe(TASK_PASTE_ATTACHMENT_MIME_TYPE)
    expect(file.size).toBe(taskPasteByteLength(brief))
    expect(await fileText(file)).toBe(brief)
  })

  it("bounds the attachment at the Room's Agent-readable store limit", () => {
    const atLimit = "x".repeat(MAX_TASK_PASTE_BYTES)
    expect(taskPasteFitsAttachment(atLimit)).toBe(true)
    expect(taskPasteFitsAttachment(`${atLimit}x`)).toBe(false)
    // Multi-byte characters are counted as bytes, not as UTF-16 code units.
    const wide = "中".repeat(MAX_TASK_PASTE_BYTES / 3)
    expect(taskPasteByteLength(wide)).toBe(MAX_TASK_PASTE_BYTES)
    expect(taskPasteFitsAttachment(`${wide}中`)).toBe(false)
    expect(taskPasteFitsAttachment("")).toBe(false)
  })

  it("derives a bounded Task label from the brief, never a truncated copy", () => {
    expect(taskBriefLabel("# Refactor the auth module\n\nDetails…")).toBe(
      "Refactor the auth module"
    )
    expect(taskBriefLabel("\n\n   \n- second line wins")).toBe(
      "second line wins"
    )
    expect(taskBriefLabel("-".repeat(3) + "é".repeat(400))).toHaveLength(120)
    expect(taskBriefLabel("\n  \n")).toBe("")
    expect(TASK_BRIEF_DEFAULT_LABEL.length).toBeGreaterThan(0)
  })
})
