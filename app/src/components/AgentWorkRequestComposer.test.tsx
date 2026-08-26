import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import AgentWorkRequestComposer from "./AgentWorkRequestComposer"
import { MAX_ROOM_ATTACHMENT_BYTES } from "../common/roomAttachments"

const base = {
  agentName: "Agent B",
  capabilities: ["browser.control", "browser.authenticated"],
  maxLength: 1200,
}

describe("AgentWorkRequestComposer (#113)", () => {
  it("shows agent name, capability chips as metadata, and the explanatory copy", () => {
    render(
      <AgentWorkRequestComposer
        {...base}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByText(/Request work from Agent B/)).toBeTruthy()
    expect(screen.getByText("browser.control")).toBeTruthy()
    expect(
      screen.getByText(
        /The Agent may accept or decline\. This request does not grant new permissions\./,
      ),
    ).toBeTruthy()
  })

  it("disables Send for empty/whitespace summaries and enables with content", () => {
    const onSubmit = vi.fn()
    render(
      <AgentWorkRequestComposer
        {...base}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    const send = screen.getByText("Send request") as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.change(
      screen.getByPlaceholderText("What would you like this Agent to do?"),
      {
        target: { value: "   " },
      },
    )
    expect(
      (screen.getByText("Send request") as HTMLButtonElement).disabled,
    ).toBe(true)
    fireEvent.change(
      screen.getByPlaceholderText("What would you like this Agent to do?"),
      {
        target: { value: "Verify the dashboard" },
      },
    )
    const enabled = screen.getByText("Send request") as HTMLButtonElement
    expect(enabled.disabled).toBe(false)
    fireEvent.click(enabled)
    expect(onSubmit).toHaveBeenCalledWith("Verify the dashboard", [])
  })

  it("bounds input to maxLength and reports length", () => {
    render(
      <AgentWorkRequestComposer
        {...base}
        maxLength={10}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    const field = screen.getByPlaceholderText(
      "What would you like this Agent to do?",
    ) as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: "a".repeat(50) } })
    expect(field.value.length).toBe(10)
    expect(screen.getByText("10/10")).toBeTruthy()
  })

  it("Cancel invokes onCancel without submitting", () => {
    const onCancel = vi.fn()
    const onSubmit = vi.fn()
    render(
      <AgentWorkRequestComposer
        {...base}
        onCancel={onCancel}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.click(screen.getByText("Cancel"))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

function makeFile(name: string, opts: { size?: number } = {}) {
  const f = new File(["x"], name, { type: "text/plain" })
  if (opts.size !== undefined)
    Object.defineProperty(f, "size", { value: opts.size })
  return f
}

function chooseFiles(files: File[]) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, "files", { value: files, configurable: true })
  fireEvent.change(input)
}

describe("AgentWorkRequestComposer submit result handling (#123)", () => {
  async function fillSummaryAndSubmit(
    onSubmit: (summary: string, files: File[]) => Promise<boolean>,
  ) {
    render(
      <AgentWorkRequestComposer
        {...base}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.change(
      screen.getByPlaceholderText("What would you like this Agent to do?"),
      {
        target: { value: "Verify the dashboard" },
      },
    )
    fireEvent.click(screen.getByTestId("send-collab-request"))
  }

  it("keeps the composer open with a visible error when onSubmit resolves false", async () => {
    const onSubmit = vi.fn().mockResolvedValue(false)
    await fillSummaryAndSubmit(onSubmit)
    expect(
      await screen.findByText("Could not send request. Try again."),
    ).toBeTruthy()
    expect(screen.getByTestId("send-collab-request")).toBeTruthy()
    expect(
      (screen.getByTestId("send-collab-request") as HTMLButtonElement).disabled,
    ).toBe(false)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("keeps the composer open with a visible error when uploads throw", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("network down"))
    await fillSummaryAndSubmit(onSubmit)
    expect(await screen.findByText("Upload failed. Try again.")).toBeTruthy()
    expect(screen.getByTestId("send-collab-request")).toBeTruthy()
  })

  it("shows no error when onSubmit resolves true", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true)
    await fillSummaryAndSubmit(onSubmit)
    await waitFor(() =>
      expect(
        (screen.getByTestId("send-collab-request") as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )
    expect(screen.queryByText(/Try again\./)).toBeNull()
  })
})

describe("AgentWorkRequestComposer artifact selection (#123)", () => {
  function rendered() {
    return render(
      <AgentWorkRequestComposer
        {...base}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
  }

  it("adds supported artifacts up to three and reports the cap beyond it", () => {
    const { container } = rendered()
    chooseFiles([
      makeFile("a.txt"),
      makeFile("b.txt"),
      makeFile("c.txt"),
      makeFile("d.txt"),
    ])
    expect(screen.getByText("a.txt")).toBeTruthy()
    expect(screen.getByText("b.txt")).toBeTruthy()
    expect(screen.getByText("c.txt")).toBeTruthy()
    expect(screen.getByText("Maximum 3 artifacts per request.")).toBeTruthy()
    expect(screen.queryByText("d.txt")).toBeNull()
    expect(
      container.querySelectorAll('button[aria-label^="Remove"]').length,
    ).toBe(3)
  })

  it("rejects unsupported extensions with a visible error", () => {
    rendered()
    chooseFiles([makeFile("evil.exe")])
    expect(screen.getByText("Unsupported file type: evil.exe")).toBeTruthy()
    expect(screen.queryByText("evil.exe")).toBeNull()
  })

  it("rejects empty artifacts", () => {
    rendered()
    chooseFiles([makeFile("empty.txt", { size: 0 })])
    expect(screen.getByText("Empty file: empty.txt")).toBeTruthy()
    expect(screen.queryByText("empty.txt")).toBeNull()
  })

  it("rejects oversized artifacts against the shared byte limit", () => {
    rendered()
    chooseFiles([
      makeFile("big.txt", { size: MAX_ROOM_ATTACHMENT_BYTES + 1 }),
      makeFile("ok.txt", { size: 10 }),
    ])
    expect(
      screen.getByText(
        `File exceeds ${Math.floor(
          MAX_ROOM_ATTACHMENT_BYTES / 1024,
        )} KiB: big.txt`,
      ),
    ).toBeTruthy()
    expect(screen.getByText("ok.txt")).toBeTruthy()
  })

  it("removes a selected artifact via its remove control", () => {
    rendered()
    chooseFiles([makeFile("keep.txt"), makeFile("drop.txt")])
    fireEvent.click(screen.getByLabelText("Remove drop.txt"))
    expect(screen.queryByText("drop.txt")).toBeNull()
    expect(screen.getByText("keep.txt")).toBeTruthy()
  })
})

describe("AgentWorkRequestComposer artifact selection (#123 follow-ups)", () => {
  it("accepts .log artifacts as part of the actual allow-list", () => {
    render(
      <AgentWorkRequestComposer
        {...base}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    chooseFiles([makeFile("app.log")])
    expect(screen.getByText("app.log")).toBeTruthy()
  })
})

describe("AgentWorkRequestComposer submitting state (#123)", () => {
  it("disables Send while a submission is in flight and restores it afterwards", async () => {
    let resolveSubmit!: (value: boolean) => void
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSubmit = resolve
        }),
    )
    render(
      <AgentWorkRequestComposer
        {...base}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.change(
      screen.getByPlaceholderText("What would you like this Agent to do?"),
      { target: { value: "Verify the dashboard" } },
    )
    const sendButton = screen.getByTestId(
      "send-collab-request",
    ) as HTMLButtonElement
    expect(sendButton.disabled).toBe(false)
    fireEvent.click(sendButton)
    expect(
      (screen.getByTestId("send-collab-request") as HTMLButtonElement).disabled,
    ).toBe(true)
    resolveSubmit(true)
    await waitFor(() =>
      expect(
        (screen.getByTestId("send-collab-request") as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )
  })
})
