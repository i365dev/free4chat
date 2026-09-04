import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { LOCAL_PEER_ID } from "@common/consts"

import {
  authorizedLiveTranscriptHosts,
  LiveTranscriptControl,
  LiveTranscriptSegments,
} from "./LiveTranscript"

const participants = [
  { peerId: "human-a", name: "Alice" },
  { peerId: "human-b", name: "Bob" },
]

const readyHost = {
  "host-a": { runtimeHostId: "host-a", speech: { stt: true, tts: true } },
}

function openControl() {
  fireEvent.click(screen.getByRole("button", { name: "Live Transcript" }))
}

describe("Room-wide Live Transcript UI (#177 PR3 / #236 header simplification)", () => {
  it("starts directly through the one server-associated STT-ready Runtime Host", () => {
    const onStart = vi.fn()
    render(
      <LiveTranscriptControl
        liveTranscript={{ active: false }}
        runtimeHosts={readyHost}
        runtimeHostProviders={{
          "host-a": { humanParticipantId: "human-a", claimedAt: 1 },
        }}
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

  it("does not mistake a copied public Runtime Host id for authorization", () => {
    expect(
      authorizedLiveTranscriptHosts({
        runtimeHosts: readyHost,
        runtimeHostProviders: {
          "host-a": { humanParticipantId: "human-a", claimedAt: 1 },
        },
        localParticipantId: "human-b",
      })
    ).toEqual([])

    render(
      <LiveTranscriptControl
        liveTranscript={{ active: false }}
        runtimeHosts={readyHost}
        runtimeHostProviders={{
          "host-a": { humanParticipantId: "human-a", claimedAt: 1 },
        }}
        localParticipantId="human-b"
        participants={participants}
        mediaAvailable
        onStart={vi.fn()}
        onStop={vi.fn()}
      />
    )
    openControl()
    // No authorized Host: the feature popover explains transcription is
    // unavailable; no Start is offered and no id leaks.
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull()
    expect(
      screen.getByText("Transcription is unavailable in this room right now.")
    ).toBeInTheDocument()
    expect(screen.queryByText("host-a")).not.toBeInTheDocument()
  })

  it("keeps a single compact header control with setup inside the popover when no Host is authorized", () => {
    const onConnect = vi.fn()
    render(
      <LiveTranscriptControl
        liveTranscript={{ active: false }}
        localParticipantId="human-a"
        participants={participants}
        mediaAvailable
        onStart={vi.fn()}
        onStop={vi.fn()}
        onConnect={onConnect}
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
    expect(
      screen.getByText(
        "A local Free4Chat Runtime with transcription is needed to start."
      )
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Copy setup command" }))
    expect(onConnect).toHaveBeenCalledTimes(1)
    expect(
      screen.queryByText(/provider claim|runtimeHostId/i)
    ).not.toBeInTheDocument()
  })

  it("keeps the primary setup action stable and shows transient copy feedback instead", () => {
    const onConnect = vi.fn()
    const { rerender } = render(
      <LiveTranscriptControl
        liveTranscript={{ active: false }}
        localParticipantId="human-a"
        participants={participants}
        mediaAvailable
        onStart={vi.fn()}
        onStop={vi.fn()}
        onConnect={onConnect}
        runtimeConnectionStatus="idle"
      />
    )
    openControl()
    fireEvent.click(screen.getByRole("button", { name: "Copy setup command" }))

    rerender(
      <LiveTranscriptControl
        liveTranscript={{ active: false }}
        localParticipantId="human-a"
        participants={participants}
        mediaAvailable
        onStart={vi.fn()}
        onStop={vi.fn()}
        onConnect={onConnect}
        runtimeConnectionStatus="copied"
      />
    )
    // The header control and the primary action never mutate into
    // "Connection command copied"; success is a separate status line.
    expect(screen.getByRole("button", { name: "Live Transcript" })).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Copy setup command" })
    ).toBeTruthy()
    expect(
      screen.queryByText("Connection command copied")
    ).not.toBeInTheDocument()
    expect(screen.getByText(/Setup command copied/i)).toBeInTheDocument()
  })

  it("disables the setup action truthfully while the claim is preparing", () => {
    const onConnect = vi.fn()
    render(
      <LiveTranscriptControl
        liveTranscript={{ active: false }}
        localParticipantId="human-a"
        participants={participants}
        mediaAvailable
        onStart={vi.fn()}
        onStop={vi.fn()}
        onConnect={onConnect}
        runtimeConnectionStatus="preparing"
      />
    )
    openControl()
    fireEvent.click(screen.getByRole("button", { name: "Preparing…" }))
    expect(onConnect).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Preparing…" })).toBeDisabled()
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
        runtimeHostProviders={{
          "host-a": { humanParticipantId: "human-a", claimedAt: 1 },
          "host-b": { humanParticipantId: "human-a", claimedAt: 2 },
        }}
        localParticipantId="human-a"
        participants={participants}
        mediaAvailable
        onStart={onStart}
        onStop={vi.fn()}
      />
    )

    openControl()
    expect(
      screen.getByText("Choose a transcription Runtime")
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole("button", { name: "Your STT-ready Runtime 2" })
    )
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
          startedByHumanParticipantId: "human-a",
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
    expect(screen.getByText("Provided by Alice")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it("follows server Off and a new active epoch without client-side failover", () => {
    const { rerender } = render(
      <LiveTranscriptControl
        liveTranscript={{
          active: true,
          producerRuntimeHostId: "host-a",
          startedByHumanParticipantId: "human-a",
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
          startedByHumanParticipantId: "human-b",
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
    expect(screen.getByText("Provided by Bob")).toBeInTheDocument()
  })

  it("surfaces setup errors inside the popover without leaking claims or ids", () => {
    render(
      <LiveTranscriptControl
        liveTranscript={{ active: false }}
        localParticipantId="human-a"
        participants={participants}
        mediaAvailable
        onStart={vi.fn()}
        onStop={vi.fn()}
        onConnect={vi.fn()}
        runtimeConnectError="Could not prepare the setup command. Try again."
      />
    )
    // The error is NOT part of the Room header.
    expect(
      screen.queryByText("Could not prepare the setup command. Try again.")
    ).not.toBeInTheDocument()
    openControl()
    expect(
      screen.getByText("Could not prepare the setup command. Try again.")
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/provider claim|runtimeHostId/i)
    ).not.toBeInTheDocument()
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
        onConnect={vi.fn()}
      />
    )
    openControl()
    expect(
      screen.getByText(/A local Free4Chat Runtime with transcription/)
    ).toBeInTheDocument()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(
      screen.queryByText(/A local Free4Chat Runtime with transcription/)
    ).not.toBeInTheDocument()

    openControl()
    fireEvent.mouseDown(document.body)
    expect(
      screen.queryByText(/A local Free4Chat Runtime with transcription/)
    ).not.toBeInTheDocument()
  })

  it("resolves the local provider through the authenticated participant id", () => {
    render(
      <LiveTranscriptControl
        liveTranscript={{
          active: true,
          producerRuntimeHostId: "host-a",
          startedByHumanParticipantId: "human-a",
          epoch: 7,
          startedAt: 1,
        }}
        localParticipantId="human-a"
        participants={[{ peerId: LOCAL_PEER_ID, name: "Alice" }]}
        mediaAvailable={false}
        onStart={vi.fn()}
        onStop={vi.fn()}
      />
    )
    openControl()
    expect(screen.getByText("Provided by Alice")).toBeInTheDocument()
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
