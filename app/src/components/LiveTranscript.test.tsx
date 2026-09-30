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
