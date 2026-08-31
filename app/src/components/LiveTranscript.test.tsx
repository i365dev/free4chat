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

describe("Room-wide Live Transcript UI (#177 PR3)", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Start" }))
    expect(onStart).toHaveBeenCalledWith("host-a")
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
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled()
    expect(
      screen.getByTitle("No authorized transcription Runtime is available")
    ).toBeInTheDocument()
  })

  it("offers an understandable local Runtime connection when no Host is authorized", () => {
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
    expect(
      screen.getByText("No transcription Runtime connected")
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole("button", { name: "Connect local Runtime" })
    )
    expect(onConnect).toHaveBeenCalledTimes(1)
    expect(
      screen.queryByText(/provider claim|runtimeHostId/i)
    ).not.toBeInTheDocument()
  })

  it("offers a small Runtime choice only when the Human has multiple eligible Hosts", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Start" }))
    expect(screen.getByText("Choose a Runtime")).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole("button", { name: "Your STT-ready Runtime 2" })
    )
    expect(onStart).toHaveBeenCalledWith("host-b")
    expect(screen.queryByText("host-b")).not.toBeInTheDocument()
  })

  it("keeps the global active state visible to another Human, who may Stop it", () => {
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
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument()

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
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled()

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
    expect(screen.getByText("Provided by Bob")).toBeInTheDocument()
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
    expect(screen.getByText("Provided by Alice")).toBeInTheDocument()
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
