import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import RoomAppHost from "./RoomAppHost"
import type {
  RoomAppParticipantProjection,
  RoomAppTransportEnvelope,
} from "../common/roomApp"

class TestPort {
  onmessage: ((event: MessageEvent) => void) | null = null
  postMessage = vi.fn()
  start = vi.fn()
  close = vi.fn()

  emit(data: unknown) {
    this.onmessage?.({ data } as MessageEvent)
  }
}

let lastChannel: { port1: TestPort; port2: TestPort } | null = null

class TestMessageChannel {
  port1 = new TestPort()
  port2 = new TestPort()

  constructor() {
    lastChannel = this
  }
}

const app = {
  id: "whiteboard",
  label: "Whiteboard",
  url: "https://room-apps.free4.chat/whiteboard",
  origin: "https://room-apps.free4.chat",
} as const

const self: RoomAppParticipantProjection = {
  participantId: "human-a",
  name: "Alice",
  kind: "human",
}

const participants = [
  self,
  { participantId: "human-b", name: "Bob", kind: "human" as const },
]

afterEach(() => {
  lastChannel = null
  vi.unstubAllGlobals()
})

describe("RoomAppHost", () => {
  it("sandboxes an allowlisted App and establishes an owned MessagePort", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    const onReady = vi.fn()
    const onClose = vi.fn()
    const subscribe = vi.fn(() => () => undefined)
    const send = vi.fn(() => true)
    const rendered = render(
      <RoomAppHost
        app={app}
        appInstanceId="whiteboard:room"
        self={self}
        participants={participants}
        subscribe={subscribe}
        send={send}
        onReady={onReady}
        onClose={onClose}
      />
    )
    const iframe = screen.getByTestId("room-app-iframe") as HTMLIFrameElement
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts")
    expect(iframe.getAttribute("allow")).toBe("")
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer")
    expect(iframe.src).toContain(app.url)

    const frameWindow = { postMessage: vi.fn() }
    Object.defineProperty(iframe, "contentWindow", { value: frameWindow })
    fireEvent.load(iframe)
    expect(frameWindow.postMessage).toHaveBeenCalledTimes(1)
    const [bootstrap, targetOrigin, ports] =
      frameWindow.postMessage.mock.calls[0]
    expect(targetOrigin).toBe("*")
    expect(bootstrap).toMatchObject({
      type: "room-app-bootstrap",
      appInstanceId: "whiteboard:room",
    })
    expect(bootstrap).not.toHaveProperty("token")
    expect(bootstrap).not.toHaveProperty("participantToken")
    expect(ports).toHaveLength(1)
    expect(lastChannel).not.toBeNull()

    act(() => {
      lastChannel!.port1.emit({
        type: "ready",
        appInstanceId: "whiteboard:room",
        handshakeToken: bootstrap.handshakeToken,
      })
    })
    expect(lastChannel!.port1.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ready",
        appInstanceId: "whiteboard:room",
        self,
        participants,
      })
    )
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledWith("whiteboard")
    act(() => {
      lastChannel!.port1.emit({
        type: "ready",
        appInstanceId: "whiteboard:room",
        handshakeToken: bootstrap.handshakeToken,
      })
    })
    expect(onReady).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(onClose).toHaveBeenCalledTimes(1)
    rendered.unmount()
    expect(lastChannel!.port1.close).toHaveBeenCalled()
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
  })

  it("rejects malformed or wrong-instance messages and forwards bounded lanes", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    const send = vi.fn(() => true)
    render(
      <RoomAppHost
        app={app}
        appInstanceId="whiteboard:room"
        self={self}
        participants={participants}
        subscribe={() => () => undefined}
        send={send}
        onClose={() => undefined}
      />
    )
    const iframe = screen.getByTestId("room-app-iframe") as HTMLIFrameElement
    const frameWindow = { postMessage: vi.fn() }
    Object.defineProperty(iframe, "contentWindow", { value: frameWindow })
    fireEvent.load(iframe)
    const bootstrap = frameWindow.postMessage.mock.calls[0][0]
    const port = lastChannel!.port1
    act(() => {
      port.emit({ type: "bogus", appInstanceId: "whiteboard:room" })
    })
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", error: "unsupported_message" })
    )
    act(() => {
      port.emit({
        type: "ready",
        appInstanceId: "other:room",
        handshakeToken: bootstrap.handshakeToken,
      })
    })
    expect(send).not.toHaveBeenCalled()
    act(() => {
      port.emit({
        type: "ready",
        appInstanceId: "whiteboard:room",
        handshakeToken: bootstrap.handshakeToken,
      })
      port.emit({
        type: "sendReliable",
        appInstanceId: "whiteboard:room",
        payload: { type: "stroke", points: [[1, 2]] },
      })
    })
    expect(send).toHaveBeenCalledWith("reliable", "whiteboard:room", {
      type: "stroke",
      points: [[1, 2]],
    })
  })

  it("forwards remote lanes and emits participant lifecycle changes", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    let listener: ((message: RoomAppTransportEnvelope) => void) | undefined
    const subscribe = vi.fn((next: typeof listener) => {
      listener = next
      return () => undefined
    })
    const { rerender } = render(
      <RoomAppHost
        app={app}
        appInstanceId="whiteboard:room"
        self={self}
        participants={participants}
        subscribe={subscribe}
        send={() => true}
        onClose={() => undefined}
      />
    )
    const iframe = screen.getByTestId("room-app-iframe") as HTMLIFrameElement
    const frameWindow = { postMessage: vi.fn() }
    Object.defineProperty(iframe, "contentWindow", { value: frameWindow })
    fireEvent.load(iframe)
    const bootstrap = frameWindow.postMessage.mock.calls[0][0]
    act(() => {
      lastChannel!.port1.emit({
        type: "ready",
        appInstanceId: "whiteboard:room",
        handshakeToken: bootstrap.handshakeToken,
      })
      listener?.({
        protocolVersion: 1,
        appInstanceId: "whiteboard:room",
        lane: "realtime",
        sourceParticipantId: "human-b",
        payload: { type: "cursor", x: 2 },
      })
    })
    expect(lastChannel!.port1.postMessage).toHaveBeenCalledWith({
      type: "realtime",
      appInstanceId: "whiteboard:room",
      sourceParticipantId: "human-b",
      payload: { type: "cursor", x: 2 },
    })
    rerender(
      <RoomAppHost
        app={app}
        appInstanceId="whiteboard:room"
        self={self}
        participants={[self]}
        subscribe={subscribe}
        send={() => true}
        onClose={() => undefined}
      />
    )
    expect(lastChannel!.port1.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "participant_leave",
        participant: participants[1],
      })
    )
  })
})
