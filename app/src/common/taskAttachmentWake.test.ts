import { describe, expect, it } from "vitest"

import {
  encodeTaskAttachmentWake,
  parseTaskAttachmentWake,
  TASK_ATTACHMENT_WAKE_HEADER,
} from "./taskAttachmentWake"

/**
 * #363 second review: the Task attachment wake intent is a bounded boolean
 * carried on the existing Task-correlated upload and persisted with the
 * attachment. The transport contract is exactly two one-character tokens so
 * no client string can smuggle a second wake intent.
 */
describe("Task attachment wake intent transport", () => {
  it("keeps the wire header stable", () => {
    expect(TASK_ATTACHMENT_WAKE_HEADER).toBe("X-Task-Attachment-Wake")
  })

  it("round-trips both explicit intents", () => {
    for (const intent of [true, false]) {
      expect(parseTaskAttachmentWake(encodeTaskAttachmentWake(intent))).toBe(
        intent
      )
    }
    expect(encodeTaskAttachmentWake(true)).toBe("1")
    expect(encodeTaskAttachmentWake(false)).toBe("0")
  })

  it("never interprets an unknown or absent value as a wake", () => {
    for (const value of [undefined, null, "", "true", "false", "yes", "2"]) {
      expect(parseTaskAttachmentWake(value)).toBeUndefined()
    }
  })
})
