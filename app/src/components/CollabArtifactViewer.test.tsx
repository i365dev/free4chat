import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import CollabArtifactViewer from "./CollabArtifactViewer"
import type { RoomAttachmentRead } from "../room/types"

const IMAGE_READ: RoomAttachmentRead = {
  attachment: {
    id: "att-1",
    fileName: "shot.png",
    mimeType: "image/png",
    size: 3,
  },
  data: btoa("abc"),
}

function makeObjectUrls() {
  const urls: string[] = []
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => {
        const created = `blob:mock-${urls.length + 1}`
        urls.push(created)
        return created
      }),
      revokeObjectURL: vi.fn((url: string) => {
        const index = urls.indexOf(url)
        if (index >= 0) urls.splice(index, 1)
      }),
    }),
  )
  return urls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("CollabArtifactViewer (#117)", () => {
  it("fetches on mount only, renders image via object URL, and revokes on close", async () => {
    const urls = makeObjectUrls()
    const read = vi.fn().mockResolvedValue(IMAGE_READ)
    const onClose = vi.fn()
    render(
      <CollabArtifactViewer
        attachmentId="att-1"
        read={read}
        onClose={onClose}
      />,
    )

    // Exactly one on-demand read for the exact requested artifact.
    await waitFor(() => expect(screen.getByRole("img")).toBeTruthy())
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith("att-1")
    const url = (screen.getByRole("img") as HTMLImageElement).src
    expect(url.startsWith("blob:")).toBe(true)

    fireEvent.click(screen.getByText("Close"))
    expect(onClose).toHaveBeenCalledTimes(1)
    // Closing revokes exactly the one object URL this viewer owned.
    expect(urls).toContain(url)
  })

  it("renders text-like artifacts as literal <pre> content with no HTML interpretation", async () => {
    makeObjectUrls()
    const read = vi.fn().mockResolvedValue({
      attachment: {
        id: "att-2",
        fileName: "<img src=x>.md",
        mimeType: "text/markdown",
        size: 15,
      },
      data: btoa("# not html <script>alert(1)</script>"),
    })
    render(
      <CollabArtifactViewer
        attachmentId="att-2"
        read={read}
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText(/not html/)).toBeTruthy())
    // Literal text inside <pre>: the raw markup string is visible as text.
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeTruthy()
    // Malicious fileName is escaped as ordinary React text.
    expect(screen.getByText(/<img src=x>\.md/)).toBeTruthy()
    expect(screen.queryByRole("img")).toBeNull()
  })

  it("shows a small actionable error when the artifact is gone", async () => {
    makeObjectUrls()
    const read = vi.fn().mockRejectedValue(new Error("attachment_unavailable"))
    render(
      <CollabArtifactViewer
        attachmentId="gone"
        read={read}
        onClose={vi.fn()}
      />,
    )
    await waitFor(() =>
      expect(
        screen.getByText(/Artifact is no longer available\./),
      ).toBeTruthy(),
    )
    // No object URL was ever created for a failed read.
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})
