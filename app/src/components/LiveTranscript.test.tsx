import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import {
  authorizedLiveTranscriptHosts,
  LiveTranscriptControl,
  LiveTranscriptSegments,
} from "./LiveTranscript"

const participants = [
  { peerId: "human-a", name: "Alice", kind: "human" as const, connected: true },
  { peerId: "human-b", name: "Bob", kind: "human" as const, connected: true },
  {
    peerId: "agent-a",
    name: "Codex",
    kind: "agent" as const,
    connected: true,
    runtimeHostId: "host-a",
  },
]

const readyHost = {
  "host-a": { runtimeHostId: "host-a", speech: { stt: true, tts: true } },
}

function openControl() {
  fireEvent.click(screen.getByRole("button", { name: "Live Transcript" }))
}

describe("Room-wide Live Transcript UI (#177 PR3 / #236 header simplification)", () => {
  it("starts directly through a connected STT-ready Runtime Host", () => {
    const onStart = vi.fn()
    render(
      <LiveTranscriptControl
        liveTranscript={{ active: false }}
        runtimeHosts={readyHost}
        localParticipantId="human-a"
        participants={participants}
        mediaAvailable
        onStart={onStart}
        onStop={vi.fn()}
      />
    )

    // #236: the single header control opens the feature popover; Start lives
    // inside it and must not render the opaque host id.
    openControl()
    expect(screen.getByText("Ready to start.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Start" }))
    expect(onStart).toHaveBeenCalledWith("host-a")
    expect(screen.queryByText("host-a")).not.toBeInTheDocument()
  })

  it("offers an STT-ready Host for a Human's explicit Start action", () => {
    expect(
      authorizedLiveTranscriptHosts({
        runtimeHosts: readyHost,
        participants,
      })
    ).toHaveLength(1)

    render(
      <LiveTranscriptControl
        liveTranscript={{ active: false }}
        runtimeHosts={readyHost}
        localParticipantId="human-b"
        participants={participants}
        mediaAvailable
        onStart={vi.fn()}
        onStop={vi.fn()}
      />
    )
    openControl()
    // Any current Human can start this bounded Room action; the selected
    // Runtime Host id is never shown in the product UI.
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument()
    expect(screen.queryByText("host-a")).not.toBeInTheDocument()
  })

  it("asks the Human to join a Runtime only when none is connected", () => {
    render(
      <LiveTranscriptControl
        liveTranscript={{ active: false }}
        localParticipantId="human-a"
        participants={participants.slice(0, 2)}
        mediaAvailable
        onStart={vi.fn()}
        onStop={vi.fn()}
      />
    )

    // The header exposes ONLY the feature name — no plumbing labels.
    expect(screen.getByRole("button", { name: "Live Transcript" })).toBeTruthy()
    expect(
      screen.queryByText("No transcription Runtime connected")
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText("Connection command copied")
    ).not.toBeInTheDocument()
    expect(screen.queryByText("Connect local Runtime")).not.toBeInTheDocument()

    openControl()
    expect(
      screen.getByText("Turn room audio into shared text.")
    ).toBeInTheDocument()
    expect(screen.getByText(/No Runtime Host is connected/)).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /command|terminal/i })
    ).toBeNull()
  })

  it("offers a small Runtime choice inside the feature UI when multiple eligible Hosts exist", () => {
    const onStart = vi.fn()
    render(
      <LiveTranscriptControl
        liveTranscript={{ active: false }}
        runtimeHosts={{
          ...readyHost,
          "host-b": {
            runtimeHostId: "host-b",
            speech: { stt: true, tts: false },
          },
        }}
        localParticipantId="human-a"
        participants={[
          ...participants,
          {
            peerId: "agent-b",
            name: "Claude",
            kind: "agent",
            connected: true,
            runtimeHostId: "host-b",
          },
        ]}
        mediaAvailable
        onStart={onStart}
        onStop={vi.fn()}
      />
    )

    openControl()
    expect(
      screen.getByText("Choose a transcription Runtime")
    ).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("Claude Runtime"))
    fireEvent.click(screen.getByRole("button", { name: "Start" }))
    expect(onStart).toHaveBeenCalledWith("host-b")
    expect(screen.queryByText("host-b")).not.toBeInTheDocument()
  })

  it("shows a compact active header and keeps Stop available to any Human inside the popover", () => {
    const onStop = vi.fn()
    render(
      <LiveTranscriptControl
        liveTranscript={{
          active: true,
          producerRuntimeHostId: "host-a",
          epoch: 7,
          startedAt: 1,
        }}
        localParticipantId="human-b"
        participants={participants}
        mediaAvailable={false}
        onStart={vi.fn()}
        onStop={onStop}
      />
    )

    expect(screen.getByText("● Live Transcript")).toBeInTheDocument()
    // #236: active details live in the popover; Stop is NOT hidden behind
    // provider ownership — any current Human sees it.
    openControl()
    expect(screen.getByText("Live Transcript is on")).toBeInTheDocument()
    expect(screen.getByText("Using Codex Runtime")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it("follows server Off and a new active epoch without client-side failover", () => {
    const { rerender } = render(
      <LiveTranscriptControl
        liveTranscript={{
          active: true,
          producerRuntimeHostId: "host-a",
          epoch: 7,
          startedAt: 1,
        }}
        localParticipantId="human-b"
        participants={participants}
        mediaAvailable={false}
        onStart={vi.fn()}
        onStop={vi.fn()}
      />
    )
    openControl()
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: "Escape" })

    rerender(
      <LiveTranscriptControl
        liveTranscript={{ active: false }}
        localParticipantId="human-b"
        participants={participants}
        mediaAvailable={false}
        onStart={vi.fn()}
        onStop={vi.fn()}
      />
    )
    expect(
      screen.getByRole("button", { name: "Live Transcript" })
    ).toBeInTheDocument()

    rerender(
      <LiveTranscriptControl
        liveTranscript={{
          active: true,
          producerRuntimeHostId: "host-b",
          epoch: 8,
          startedAt: 2,
        }}
        localParticipantId="human-b"
        participants={participants}
        mediaAvailable={false}
        onStart={vi.fn()}
        onStop={vi.fn()}
      />
    )
    openControl()
    expect(screen.getByText("Using Runtime")).toBeInTheDocument()
  })

  it("asks for local STT configuration only when a connected Host is not ready", () => {
    render(
      <LiveTranscriptControl
        liveTranscript={{ active: false }}
        runtimeHosts={{
          "host-a": {
            runtimeHostId: "host-a",
            speech: { stt: false, tts: false },
          },
        }}
        localParticipantId="human-a"
        participants={participants}
        mediaAvailable
        onStart={vi.fn()}
        onStop={vi.fn()}
      />
    )
    openControl()
    expect(
      screen.getByText(/Configure STT credentials on a Runtime/)
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /command|terminal/i })
    ).toBeNull()
  })

  it("closes the popover on outside click and Escape", () => {
    render(
      <LiveTranscriptControl
        liveTranscript={{ active: false }}
        localParticipantId="human-a"
        participants={participants}
        mediaAvailable={false}
        onStart={vi.fn()}
        onStop={vi.fn()}
      />
    )
    openControl()
    expect(
      screen.getByText("Turn room audio into shared text.")
    ).toBeInTheDocument()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(
      screen.queryByText("Turn room audio into shared text.")
    ).not.toBeInTheDocument()

    openControl()
    fireEvent.mouseDown(document.body)
    expect(
      screen.queryByText("Turn room audio into shared text.")
    ).not.toBeInTheDocument()
  })

  it("resolves the local provider through the authenticated participant id", () => {
    render(
      <LiveTranscriptControl
        liveTranscript={{
          active: true,
          producerRuntimeHostId: "host-a",
          epoch: 7,
          startedAt: 1,
        }}
        localParticipantId="human-a"
        participants={participants}
        mediaAvailable={false}
        onStart={vi.fn()}
        onStop={vi.fn()}
      />
    )
    openControl()
    expect(screen.getByText("Using Codex Runtime")).toBeInTheDocument()
  })

  it("renders only committed segments in Room sequence order", () => {
    const { getAllByTestId } = render(
      <LiveTranscriptSegments
        segments={[
          {
            segmentId: "segment-2",
            epoch: 8,
            sequence: 2,
            participantId: "human-b",
            speaker: "Bob",
            text: "Second decision",
            createdAt: 2,
          },
          {
            segmentId: "segment-1",
            epoch: 8,
            sequence: 1,
            participantId: "human-a",
            speaker: "Alice",
            text: "First decision",
            createdAt: 1,
          },
        ]}
      />
    )

    const rows = getAllByTestId(/live-transcript-/)
    expect(rows.map((row) => row.textContent)).toEqual([
      "Alice: First decision",
      "Bob: Second decision",
    ])
  })

  it("starts compact and supports explicit expansion and collapse", () => {
    render(
      <LiveTranscriptSegments
        segments={[
          {
            segmentId: "one",
            epoch: 1,
            sequence: 1,
            participantId: "human-a",
            speaker: "Alice",
            text: "latest context",
            createdAt: 1,
          },
        ]}
      />
    )

    const list = screen.getByRole("list")
    const toggle = screen.getByRole("button", { name: "Expand" })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(list.className).toContain("max-h-16")
    fireEvent.click(toggle)
    expect(screen.getByRole("button", { name: "Collapse" })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    expect(list.className).toContain("max-h-40")
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }))
    expect(screen.getByRole("button", { name: "Expand" })).toHaveAttribute(
      "aria-expanded",
      "false"
    )
    expect(list.className).toContain("max-h-16")
    expect(screen.getByText("latest context")).toBeInTheDocument()
  })

  it("does not announce a new transcript when only expanding the list", () => {
    const { container } = render(
      <LiveTranscriptSegments
        segments={[
          {
            segmentId: "one",
            epoch: 1,
            sequence: 1,
            participantId: "human-a",
            speaker: "Alice",
            text: "first",
            createdAt: 1,
          },
          {
            segmentId: "two",
            epoch: 1,
            sequence: 2,
            participantId: "human-a",
            speaker: "Alice",
            text: "second",
            createdAt: 2,
          },
        ]}
      />
    )

    const list = container.querySelector("ol")!
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 20 },
      scrollHeight: { configurable: true, value: 100 },
    })
    list.scrollTop = 0
    fireEvent.scroll(list)
    fireEvent.click(screen.getByRole("button", { name: "Expand" }))

    expect(
      screen.queryByRole("button", { name: /New transcript/i })
    ).not.toBeInTheDocument()
    expect(list.scrollTop).toBe(0)
  })

  it("groups consecutive committed segments by speaker while preserving each identity and order", () => {
    render(
      <LiveTranscriptSegments
        segments={[
          {
            segmentId: "alice-1",
            epoch: 1,
            sequence: 1,
            participantId: "human-a",
            speaker: "Alice",
            text: "first",
            createdAt: 1,
          },
          {
            segmentId: "alice-2",
            epoch: 1,
            sequence: 2,
            participantId: "human-a",
            speaker: "Alice",
            text: "second",
            createdAt: 2,
          },
          {
            segmentId: "bob-1",
            epoch: 1,
            sequence: 3,
            participantId: "human-b",
            speaker: "Bob",
            text: "third",
            createdAt: 3,
          },
          {
            segmentId: "alice-3",
            epoch: 1,
            sequence: 4,
            participantId: "human-a",
            speaker: "Alice",
            text: "fourth",
            createdAt: 4,
          },
        ]}
      />
    )

    const rows = screen.getAllByTestId(/live-transcript-/)
    expect(rows.map((row) => row.textContent)).toEqual([
      "Alice: first",
      "Alice: second",
      "Bob: third",
      "Alice: fourth",
    ])
    expect(rows[1].querySelector(".sr-only")).toHaveTextContent("Alice:")
    expect(rows.map((row) => row.dataset.segmentId)).toEqual([
      "alice-1",
      "alice-2",
      "bob-1",
      "alice-3",
    ])
    expect(rows[1]).toHaveClass("pl-4")
    expect(rows[2]).not.toHaveClass("pl-4")
    expect(rows[3]).not.toHaveClass("pl-4")
  })

  it("follows the newest committed segment when the viewer is near the bottom", () => {
    const { container, rerender } = render(
      <LiveTranscriptSegments
        segments={[
          {
            segmentId: "one",
            epoch: 1,
            sequence: 1,
            participantId: "human-a",
            speaker: "Alice",
            text: "one",
            createdAt: 1,
          },
        ]}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Expand" }))
    const list = container.querySelector("ol")!
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 40 },
      scrollHeight: { configurable: true, value: 100 },
    })
    list.scrollTop = 60
    rerender(
      <LiveTranscriptSegments
        segments={[
          {
            segmentId: "one",
            epoch: 1,
            sequence: 1,
            participantId: "human-a",
            speaker: "Alice",
            text: "one",
            createdAt: 1,
          },
          {
            segmentId: "two",
            epoch: 1,
            sequence: 2,
            participantId: "human-b",
            speaker: "Bob",
            text: "two",
            createdAt: 2,
          },
        ]}
      />
    )
    expect(list.scrollTop).toBe(100)
  })

  it("preserves an upward scroll and offers jump to latest", () => {
    const { container, rerender } = render(
      <LiveTranscriptSegments
        segments={[
          {
            segmentId: "one",
            epoch: 1,
            sequence: 1,
            participantId: "human-a",
            speaker: "Alice",
            text: "one",
            createdAt: 1,
          },
        ]}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Expand" }))
    const list = container.querySelector("ol")!
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 40 },
      scrollHeight: { configurable: true, value: 100 },
    })
    list.scrollTop = 0
    fireEvent.scroll(list)
    rerender(
      <LiveTranscriptSegments
        segments={[
          {
            segmentId: "one",
            epoch: 1,
            sequence: 1,
            participantId: "human-a",
            speaker: "Alice",
            text: "one",
            createdAt: 1,
          },
          {
            segmentId: "two",
            epoch: 1,
            sequence: 2,
            participantId: "human-b",
            speaker: "Bob",
            text: "two",
            createdAt: 2,
          },
        ]}
      />
    )
    expect(list.scrollTop).toBe(0)
    const jump = screen.getByRole("button", { name: /Jump to latest/i })
    fireEvent.click(jump)
    expect(list.scrollTop).toBe(100)
  })
})
