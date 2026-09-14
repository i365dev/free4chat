import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import RoomAudioSinks from "./RoomAudioSinks"

const LOCAL_PEER_ID = "local-peer"

function stream(id: string): MediaStream {
  // jsdom has no WebRTC stack; playback identity is what matters here.
  return { id } as unknown as MediaStream
}

const sink = (peerId: string) =>
  document.querySelector<HTMLAudioElement>(
    `[data-testid="room-audio-sink"][data-peer-id="${peerId}"]`
  )

const allSinks = () => [
  ...document.querySelectorAll<HTMLAudioElement>(
    '[data-testid="room-audio-sink"]'
  ),
]

describe("RoomAudioSinks", () => {
  it("plays every remote participant and never the local microphone", () => {
    const bob = stream("bob-audio")
    const carol = stream("carol-audio")
    render(
      <RoomAudioSinks
        participants={[
          { peerId: LOCAL_PEER_ID, audioStream: stream("self-audio") },
          { peerId: "peer-bob", audioStream: bob },
          { peerId: "peer-carol", audioStream: carol },
          { peerId: "peer-agent", audioStream: null },
        ]}
      />
    )

    // Remote voice is audible, unmuted and bound to the participant's stream.
    expect(sink("peer-bob")).not.toBeNull()
    expect(sink("peer-bob")!.srcObject).toBe(bob)
    expect(sink("peer-bob")!.muted).toBe(false)
    expect(sink("peer-bob")!.autoplay).toBe(true)
    expect(sink("peer-carol")!.srcObject).toBe(carol)

    // The local participant must never be played back into the Room.
    expect(sink(LOCAL_PEER_ID)).toBeNull()
    expect(allSinks()).toHaveLength(3)
  })

  it("switches an existing sink to a replaced stream without recreating it", () => {
    const first = stream("bob-audio-1")
    const second = stream("bob-audio-2")
    const { rerender } = render(
      <RoomAudioSinks
        participants={[{ peerId: "peer-bob", audioStream: first }]}
      />
    )
    const element = sink("peer-bob")
    expect(element!.srcObject).toBe(first)

    // Media reconnect / participant projection hands Bob a new MediaStream.
    rerender(
      <RoomAudioSinks
        participants={[{ peerId: "peer-bob", audioStream: second }]}
      />
    )

    expect(sink("peer-bob")).toBe(element)
    expect(sink("peer-bob")!.srcObject).toBe(second)
    expect(allSinks()).toHaveLength(1)
  })

  it("drops the sink and releases the stream when a participant leaves", () => {
    const bob = stream("bob-audio")
    const { rerender } = render(
      <RoomAudioSinks
        participants={[
          { peerId: "peer-bob", audioStream: bob },
          { peerId: "peer-carol", audioStream: stream("carol-audio") },
        ]}
      />
    )
    const element = sink("peer-bob")
    expect(element!.srcObject).toBe(bob)

    rerender(
      <RoomAudioSinks
        participants={[
          { peerId: "peer-carol", audioStream: stream("carol-audio") },
        ]}
      />
    )

    expect(sink("peer-bob")).toBeNull()
    // The detached element must not keep holding the departed stream.
    expect(element!.srcObject).toBeNull()
    expect(allSinks()).toHaveLength(1)
  })

  it("releases every stream when the Room session itself ends", () => {
    const bob = stream("bob-audio")
    const { unmount } = render(
      <RoomAudioSinks
        participants={[{ peerId: "peer-bob", audioStream: bob }]}
      />
    )
    const element = sink("peer-bob")
    expect(element!.srcObject).toBe(bob)

    unmount()

    expect(element!.srcObject).toBeNull()
  })

  it("keeps a stable sink per participant across an unrelated roster change", () => {
    const bob = stream("bob-audio")
    const { rerender } = render(
      <RoomAudioSinks
        participants={[{ peerId: "peer-bob", audioStream: bob }]}
      />
    )
    const element = sink("peer-bob")

    rerender(
      <RoomAudioSinks
        participants={[
          { peerId: "peer-carol", audioStream: stream("carol-audio") },
          { peerId: "peer-bob", audioStream: bob },
        ]}
      />
    )

    expect(sink("peer-bob")).toBe(element)
    expect(sink("peer-bob")!.srcObject).toBe(bob)
  })
})
