import type { ComponentProps } from "react"

import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import RoomAppHost from "./RoomAppHost"
import {
  EMPTY_ROOM_APP_CATALOG,
  parseRoomAppCatalog,
  setProductionRoomAppCatalog,
} from "../common/roomApp"
import type {
  RoomAppDefinition,
  RoomAppAgentRequestEnvelope,
  RoomAppParticipantProjection,
  RoomAppUnicastEnvelope,
  RoomAppUnicastResult,
  RoomAppTransportEnvelope,
} from "../common/roomApp"
import { RoomAppTransportDiagnosticTrace } from "../common/roomAppTransportDiagnostics"

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
  id: "test-app",
  label: "Test App",
  url: "https://room-apps.free4.chat/test-app",
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
  setProductionRoomAppCatalog(EMPTY_ROOM_APP_CATALOG)
  vi.unstubAllGlobals()
})

describe("RoomAppHost", () => {
  beforeEach(() => setProductionRoomAppCatalog([app]))

  it("records a missing originating Agent while keeping the App error bounded", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    const appInstanceId = "generated:123e4567-e89b-12d3-a456-426614174000"
    const trace = new RoomAppTransportDiagnosticTrace(() => "browser-one")
    trace.enable()
    const rendered = render(
      <RoomAppHost
        app={{
          ...app,
          source: "generated",
          srcDoc: "<main>generated app</main>",
        }}
        appInstanceId={appInstanceId}
        generatedAppBundleRevision={3}
        generatedAppTaskRequestId="task-a"
        self={self}
        participants={participants}
        subscribe={() => () => undefined}
        send={() => true}
        subscribeUnicast={() => () => undefined}
        subscribeUnicastResults={() => () => undefined}
        sendUnicast={() => "sent"}
        recordTransportDiagnostic={(fields) => trace.record(fields)}
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
      port.emit({
        type: "ready",
        appInstanceId,
        handshakeToken: bootstrap.handshakeToken,
      })
      port.emit({
        type: "capabilityRequest",
        appInstanceId,
        bundleRevision: 3,
        requestId: "request-1",
        capabilityId: "printer_status",
        operation: "observe",
      })
    })

    expect(port.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "capability_result",
        result: expect.objectContaining({ ok: false, error: "unavailable" }),
      })
    )
    expect(trace.read().at(-1)).toMatchObject({
      component: "room_app_host",
      transition: "rejected",
      reason: "originating_agent_missing",
    })
    rendered.unmount()
  })

  it("reports the first ready App engagement once without sending into the Room", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    const onEngaged = vi.fn()
    const send = vi.fn(() => true)
    const sendUnicast = vi.fn(() => "sent" as const)
    const rendered = render(
      <RoomAppHost
        app={app}
        appInstanceId="test-app:room"
        self={self}
        participants={participants}
        subscribe={() => () => undefined}
        send={send}
        subscribeUnicast={() => () => undefined}
        subscribeUnicastResults={() => () => undefined}
        sendUnicast={sendUnicast}
        onClose={() => undefined}
        onEngaged={onEngaged}
      />
    )
    const iframe = screen.getByTestId("room-app-iframe") as HTMLIFrameElement
    const frameWindow = { postMessage: vi.fn() }
    Object.defineProperty(iframe, "contentWindow", { value: frameWindow })
    fireEvent.load(iframe)
    const bootstrap = frameWindow.postMessage.mock.calls[0][0]
    const port = lastChannel!.port1

    act(() => {
      port.emit({
        type: "milestone",
        appInstanceId: "test-app:room",
        milestone: "engaged",
      })
      port.emit({
        type: "ready",
        appInstanceId: "test-app:room",
        handshakeToken: bootstrap.handshakeToken,
      })
      port.emit({
        type: "milestone",
        appInstanceId: "test-app:room",
        milestone: "engaged",
      })
      port.emit({
        type: "milestone",
        appInstanceId: "test-app:room",
        milestone: "engaged",
      })
    })

    expect(onEngaged).toHaveBeenCalledTimes(1)
    expect(onEngaged).toHaveBeenCalledWith("test-app")
    expect(send).not.toHaveBeenCalled()
    expect(sendUnicast).not.toHaveBeenCalled()
    rendered.unmount()
  })

  it("copies an App invite in fullscreen without replacing its iframe or port", async () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    const onInvite = vi.fn().mockResolvedValue(true)
    const props = {
      app,
      appInstanceId: "test-app:room",
      self,
      participants,
      subscribe: () => () => undefined,
      send: () => true,
      subscribeUnicast: () => () => undefined,
      subscribeUnicastResults: () => () => undefined,
      sendUnicast: () => "sent" as const,
      onClose: () => undefined,
      onInvite,
    }
    const rendered = render(<RoomAppHost {...props} isFullscreen={false} />)
    const iframe = screen.getByTestId("room-app-iframe") as HTMLIFrameElement
    const frameWindow = { postMessage: vi.fn() }
    Object.defineProperty(iframe, "contentWindow", { value: frameWindow })
    fireEvent.load(iframe)
    const port = lastChannel!.port1

    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }))
    rendered.rerender(<RoomAppHost {...props} isFullscreen />)
    fireEvent.click(
      screen.getByRole("button", { name: "Invite to this activity" })
    )

    expect(await screen.findByText("Copied!")).toBeInTheDocument()
    expect(onInvite).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("room-app-host")).toHaveAttribute(
      "data-layout",
      "fullscreen"
    )
    expect(screen.getByTestId("room-app-iframe")).toBe(iframe)
    expect(lastChannel!.port1).toBe(port)
    expect(port.close).not.toHaveBeenCalled()
  })

  it("toggles generic host layout without replacing the iframe or MessagePort", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    const onToggleFullscreen = vi.fn()
    const props = {
      app,
      appInstanceId: "test-app:room",
      self,
      participants,
      subscribe: () => () => undefined,
      send: () => true,
      subscribeUnicast: () => () => undefined,
      subscribeUnicastResults: () => () => undefined,
      sendUnicast: () => "sent" as const,
      onClose: () => undefined,
      onToggleFullscreen,
    }
    const rendered = render(<RoomAppHost {...props} isFullscreen={false} />)
    const iframe = screen.getByTestId("room-app-iframe") as HTMLIFrameElement
    const frameWindow = { postMessage: vi.fn() }
    Object.defineProperty(iframe, "contentWindow", { value: frameWindow })
    fireEvent.load(iframe)
    const port = lastChannel!.port1

    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }))
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1)
    rendered.rerender(<RoomAppHost {...props} isFullscreen />)

    expect(screen.getByTestId("room-app-host")).toHaveAttribute(
      "data-layout",
      "fullscreen"
    )
    expect(
      screen.getByRole("button", { name: "Exit fullscreen" })
    ).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("room-app-iframe")).toBe(iframe)
    expect(lastChannel!.port1).toBe(port)
    expect(port.close).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }))
    rendered.rerender(<RoomAppHost {...props} isFullscreen={false} />)
    expect(screen.getByTestId("room-app-host")).toHaveAttribute(
      "data-layout",
      "stage"
    )
    expect(screen.getByTestId("room-app-iframe")).toBe(iframe)
    expect(lastChannel!.port1).toBe(port)
    expect(port.close).not.toHaveBeenCalled()
  })

  it("sandboxes an allowlisted App and establishes an owned MessagePort", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    const onReady = vi.fn()
    const onClose = vi.fn()
    const subscribe = vi.fn(() => () => undefined)
    const send = vi.fn(() => true)
    const sendUnicast = vi.fn(
      (
        _requestId: string,
        _targetParticipantId: string,
        _appInstanceId: string,
        _payload: Record<string, unknown>
      ) => "sent" as const
    )
    const rendered = render(
      <RoomAppHost
        app={app}
        appInstanceId="test-app:room"
        self={self}
        participants={participants}
        subscribe={subscribe}
        send={send}
        onReady={onReady}
        subscribeUnicast={() => () => undefined}
        subscribeUnicastResults={() => () => undefined}
        sendUnicast={sendUnicast}
        onClose={onClose}
      />
    )
    const iframe = screen.getByTestId("room-app-iframe") as HTMLIFrameElement
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-downloads")
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin")
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
      appInstanceId: "test-app:room",
    })
    expect(bootstrap).not.toHaveProperty("token")
    expect(bootstrap).not.toHaveProperty("participantToken")
    expect(ports).toHaveLength(1)
    expect(lastChannel).not.toBeNull()

    act(() => {
      lastChannel!.port1.emit({
        type: "ready",
        appInstanceId: "test-app:room",
        handshakeToken: bootstrap.handshakeToken,
      })
    })
    expect(lastChannel!.port1.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ready",
        appInstanceId: "test-app:room",
        self,
        participants,
      })
    )
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledWith("test-app")
    act(() => {
      lastChannel!.port1.emit({
        type: "ready",
        appInstanceId: "test-app:room",
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

  it("delegates only clipboard-write to an opted-in curated App", () => {
    const optedIn = { ...app, clipboardWrite: true } as const
    setProductionRoomAppCatalog([optedIn])
    render(
      <RoomAppHost
        app={optedIn}
        appInstanceId="test-app:room"
        self={self}
        participants={participants}
        subscribe={() => () => undefined}
        send={() => true}
        subscribeUnicast={() => () => undefined}
        subscribeUnicastResults={() => () => undefined}
        sendUnicast={() => "sent"}
        onClose={() => undefined}
      />
    )

    const iframe = screen.getByTestId("room-app-iframe")
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-downloads")
    expect(iframe).toHaveAttribute("allow", "clipboard-write")
    expect(iframe.getAttribute("allow")).not.toContain("clipboard-read")
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin")
  })

  it("keeps clipboard-write disabled for generated Apps and rejects invented metadata", () => {
    const generated = {
      id: "generated:task-1",
      label: "Task App",
      url: "https://room-apps.free4.chat/generated",
      origin: "https://room-apps.free4.chat",
      source: "generated" as const,
      srcDoc: "<main>Task</main>",
    }
    const props = {
      app: generated,
      appInstanceId: generated.id,
      self,
      participants,
      subscribe: () => () => undefined,
      send: () => true,
      subscribeUnicast: () => () => undefined,
      subscribeUnicastResults: () => () => undefined,
      sendUnicast: () => "sent" as const,
      onClose: () => undefined,
    }
    const rendered = render(<RoomAppHost {...props} />)
    const generatedIframe = screen.getByTestId("room-app-iframe")
    expect(generatedIframe).toHaveAttribute("sandbox", "allow-scripts")
    expect(generatedIframe.getAttribute("sandbox")).not.toContain(
      "allow-downloads"
    )
    expect(generatedIframe.getAttribute("sandbox")).not.toContain(
      "allow-same-origin"
    )
    expect(generatedIframe).toHaveAttribute("allow", "")
    rendered.unmount()

    const malformed = {
      ...generated,
      clipboardWrite: true,
    } as unknown as RoomAppDefinition
    render(<RoomAppHost {...props} app={malformed} />)
    expect(screen.queryByTestId("room-app-iframe")).not.toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This Room App is not allowlisted."
    )
  })

  it("does not grant a capability absent from the current curated allowlist", () => {
    const optedIn = { ...app, clipboardWrite: true } as const
    render(
      <RoomAppHost
        app={optedIn}
        appInstanceId="test-app:room"
        self={self}
        participants={participants}
        subscribe={() => () => undefined}
        send={() => true}
        subscribeUnicast={() => () => undefined}
        subscribeUnicastResults={() => () => undefined}
        sendUnicast={() => "sent"}
        onClose={() => undefined}
      />
    )
    expect(screen.queryByTestId("room-app-iframe")).not.toBeInTheDocument()
  })

  it("counts only THIS Human's accepted generated-state update as engagement", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    let generatedStateListener:
      | ((message: {
          appInstanceId: string
          revision: number
          state: Record<string, unknown>
          sourceParticipantId?: string
        }) => void)
      | undefined
    const subscribeGeneratedState = vi.fn(
      (listener: typeof generatedStateListener) => {
        generatedStateListener = listener
        return () => undefined
      }
    )
    const onEngaged = vi.fn()
    render(
      <RoomAppHost
        app={app}
        appInstanceId="test-app:room"
        self={self}
        participants={participants}
        subscribe={() => () => undefined}
        send={() => true}
        subscribeUnicast={() => () => undefined}
        subscribeUnicastResults={() => () => undefined}
        sendUnicast={() => "sent" as const}
        subscribeGeneratedState={subscribeGeneratedState}
        onReady={() => undefined}
        onEngaged={onEngaged}
        onClose={() => undefined}
      />
    )
    const iframe = screen.getByTestId("room-app-iframe") as HTMLIFrameElement
    const frameWindow = { postMessage: vi.fn() }
    Object.defineProperty(iframe, "contentWindow", { value: frameWindow })
    fireEvent.load(iframe)
    const port = lastChannel!.port1
    const bootstrap = frameWindow.postMessage.mock.calls[0][0]

    // Mount, bootstrap, hydration and another Human's change are NOT this
    // browser's engagement.
    act(() => {
      port.emit({
        type: "ready",
        appInstanceId: "test-app:room",
        handshakeToken: bootstrap.handshakeToken,
      })
    })
    expect(onEngaged).not.toHaveBeenCalled()

    act(() => {
      generatedStateListener?.({
        appInstanceId: "test-app:room",
        revision: 1,
        state: { count: 1 },
        sourceParticipantId: "human-b",
      })
    })
    expect(onEngaged).not.toHaveBeenCalled()

    // A revision-less reconciliation (initial GET / reconnect) carries no
    // source participant at all and must stay silent.
    act(() => {
      generatedStateListener?.({
        appInstanceId: "test-app:room",
        revision: 2,
        state: { count: 2 },
      })
    })
    expect(onEngaged).not.toHaveBeenCalled()

    // This Human's own update reached the Room authority, was persisted, and
    // was broadcast back with this participant as its source.
    act(() => {
      generatedStateListener?.({
        appInstanceId: "test-app:room",
        revision: 3,
        state: { count: 3 },
        sourceParticipantId: "human-a",
      })
    })
    expect(onEngaged).toHaveBeenCalledTimes(1)
    expect(onEngaged).toHaveBeenCalledWith("test-app")

    // Further local interactions never re-report for this resident App.
    act(() => {
      generatedStateListener?.({
        appInstanceId: "test-app:room",
        revision: 4,
        state: { count: 4 },
        sourceParticipantId: "human-a",
      })
      generatedStateListener?.({
        appInstanceId: "test-app:room",
        revision: 5,
        state: { count: 5 },
        sourceParticipantId: "human-a",
      })
    })
    expect(onEngaged).toHaveBeenCalledTimes(1)
  })

  it("never counts another App instance's update, and never replaces its iframe", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    let generatedStateListener:
      | ((message: {
          appInstanceId: string
          revision: number
          state: Record<string, unknown>
          sourceParticipantId?: string
        }) => void)
      | undefined
    const subscribeGeneratedState = vi.fn(
      (listener: typeof generatedStateListener) => {
        generatedStateListener = listener
        return () => undefined
      }
    )
    const onEngaged = vi.fn()
    render(
      <RoomAppHost
        app={app}
        appInstanceId="test-app:room"
        self={self}
        participants={participants}
        subscribe={() => () => undefined}
        send={() => true}
        subscribeUnicast={() => () => undefined}
        subscribeUnicastResults={() => () => undefined}
        sendUnicast={() => "sent" as const}
        subscribeGeneratedState={subscribeGeneratedState}
        onReady={() => undefined}
        onEngaged={onEngaged}
        onClose={() => undefined}
      />
    )
    const iframe = screen.getByTestId("room-app-iframe") as HTMLIFrameElement
    const frameWindow = { postMessage: vi.fn() }
    Object.defineProperty(iframe, "contentWindow", { value: frameWindow })
    fireEvent.load(iframe)
    const port = lastChannel!.port1
    const bootstrap = frameWindow.postMessage.mock.calls[0][0]
    act(() => {
      port.emit({
        type: "ready",
        appInstanceId: "test-app:room",
        handshakeToken: bootstrap.handshakeToken,
      })
    })

    act(() => {
      generatedStateListener?.({
        appInstanceId: "other-app:room",
        revision: 9,
        state: { count: 9 },
        sourceParticipantId: "human-a",
      })
    })
    expect(onEngaged).not.toHaveBeenCalled()
    expect(screen.getByTestId("room-app-iframe")).toBe(iframe)
    expect(lastChannel!.port1).toBe(port)
  })

  it("reconciles a higher shared-state revision without replacing the iframe", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    let generatedStateListener:
      | ((message: {
          appInstanceId: string
          revision: number
          state: Record<string, unknown>
        }) => void)
      | undefined
    const subscribeGeneratedState = vi.fn(
      (listener: typeof generatedStateListener) => {
        generatedStateListener = listener
        return () => undefined
      }
    )
    const props = {
      app,
      appInstanceId: "test-app:room",
      self,
      participants,
      subscribe: () => () => undefined,
      send: () => true,
      subscribeUnicast: () => () => undefined,
      subscribeUnicastResults: () => () => undefined,
      sendUnicast: () => "sent" as const,
      subscribeGeneratedState,
      onClose: () => undefined,
    }
    const rendered = render(
      <RoomAppHost
        {...props}
        sharedState={{ revision: 5, state: { items: ["old"] } }}
      />
    )
    const iframe = screen.getByTestId("room-app-iframe") as HTMLIFrameElement
    const frameWindow = { postMessage: vi.fn() }
    Object.defineProperty(iframe, "contentWindow", { value: frameWindow })
    fireEvent.load(iframe)
    const port = lastChannel!.port1
    const bootstrap = frameWindow.postMessage.mock.calls[0][0]
    act(() => {
      port.emit({
        type: "ready",
        appInstanceId: "test-app:room",
        handshakeToken: bootstrap.handshakeToken,
      })
    })
    const initialPostCount = port.postMessage.mock.calls.length

    act(() => {
      rendered.rerender(
        <RoomAppHost
          {...props}
          sharedState={{ revision: 6, state: { items: ["new"] } }}
        />
      )
    })
    expect(screen.getByTestId("room-app-iframe")).toBe(iframe)
    expect(lastChannel!.port1).toBe(port)
    expect(port.postMessage.mock.calls.length).toBeGreaterThan(initialPostCount)
    expect(port.postMessage).toHaveBeenLastCalledWith({
      type: "shared_state",
      appInstanceId: "test-app:room",
      revision: 6,
      state: { items: ["new"] },
    })

    act(() => {
      generatedStateListener?.({
        appInstanceId: "test-app:room",
        revision: 7,
        state: { items: ["latest"] },
      })
    })
    expect(port.postMessage).toHaveBeenLastCalledWith({
      type: "shared_state",
      appInstanceId: "test-app:room",
      revision: 7,
      state: { items: ["latest"] },
    })
  })

  it("forwards a generated App shared-state write with its current canonical revision", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    const sendGeneratedState = vi.fn(() => true)
    render(
      <RoomAppHost
        app={{
          ...app,
          source: "generated",
          srcDoc: "<main>generated app</main>",
        }}
        appInstanceId="generated:123e4567-e89b-12d3-a456-426614174000"
        self={self}
        participants={participants}
        subscribe={() => () => undefined}
        send={() => true}
        subscribeUnicast={() => () => undefined}
        subscribeUnicastResults={() => () => undefined}
        sendUnicast={() => "sent"}
        sharedState={{ revision: 3, state: { status: "old" } }}
        sendGeneratedState={sendGeneratedState}
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
      port.emit({
        type: "ready",
        appInstanceId: "generated:123e4567-e89b-12d3-a456-426614174000",
        handshakeToken: bootstrap.handshakeToken,
      })
      port.emit({
        type: "sendGeneratedState",
        appInstanceId: "generated:123e4567-e89b-12d3-a456-426614174000",
        expectedRevision: 3,
        state: { status: "Human A changed it" },
      })
    })
    expect(sendGeneratedState).toHaveBeenCalledWith(
      "generated:123e4567-e89b-12d3-a456-426614174000",
      3,
      { status: "Human A changed it" }
    )
  })

  it("rejects malformed or wrong-instance messages and forwards bounded lanes", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    const send = vi.fn(() => true)
    const sendUnicast = vi.fn(() => "sent" as const)
    render(
      <RoomAppHost
        app={app}
        appInstanceId="test-app:room"
        self={self}
        participants={participants}
        subscribe={() => () => undefined}
        send={send}
        subscribeUnicast={() => () => undefined}
        subscribeUnicastResults={() => () => undefined}
        sendUnicast={sendUnicast}
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
      port.emit({ type: "bogus", appInstanceId: "test-app:room" })
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
        appInstanceId: "test-app:room",
        handshakeToken: bootstrap.handshakeToken,
      })
      port.emit({
        type: "sendReliable",
        appInstanceId: "test-app:room",
        payload: { type: "update", points: [[1, 2]] },
      })
    })
    expect(send).toHaveBeenCalledWith("reliable", "test-app:room", {
      type: "update",
      points: [[1, 2]],
    })
    act(() => {
      port.emit({
        type: "sendReliableTo",
        appInstanceId: "test-app:room",
        requestId: "private_request_1",
        targetParticipantId: "human-b",
        payload: { type: "private", word: "otter" },
      })
      port.emit({
        type: "sendReliableTo",
        appInstanceId: "test-app:room",
        requestId: "private_request_1",
        targetParticipantId: "human-b",
        payload: { type: "private", word: "duplicate" },
      })
    })
    expect(sendUnicast).toHaveBeenCalledWith(
      "private_request_1",
      "human-b",
      "test-app:room",
      { type: "private", word: "otter" }
    )
    expect(sendUnicast).toHaveBeenCalledTimes(1)
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "error",
      appInstanceId: "test-app:room",
      requestId: "private_request_1",
      error: "duplicate_request_id",
    })
  })

  it("correlates host-local unicast rejection without changing broadcast errors", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    let resultListener: ((result: RoomAppUnicastResult) => void) | undefined
    const subscribeUnicastResults = vi.fn((next: typeof resultListener) => {
      resultListener = next
      return () => undefined
    })
    const send = vi.fn(() => false)
    const sendUnicast = vi
      .fn()
      .mockReturnValueOnce("sent" as const)
      .mockReturnValueOnce("rate_limited" as const)
    render(
      <RoomAppHost
        app={app}
        appInstanceId="test-app:room"
        self={self}
        participants={participants}
        subscribe={() => () => undefined}
        send={send}
        subscribeUnicast={() => () => undefined}
        subscribeUnicastResults={subscribeUnicastResults}
        sendUnicast={sendUnicast}
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
      port.emit({
        type: "ready",
        appInstanceId: "test-app:room",
        handshakeToken: bootstrap.handshakeToken,
      })
      port.emit({
        type: "sendReliableTo",
        appInstanceId: "test-app:room",
        requestId: "req-A",
        targetParticipantId: "human-b",
        payload: { type: "secret", word: "otter" },
      })
      port.emit({
        type: "sendReliableTo",
        appInstanceId: "test-app:room",
        requestId: "req-B",
        targetParticipantId: "human-c",
        payload: { type: "secret", word: "fox" },
      })
      port.emit({
        type: "sendReliable",
        appInstanceId: "test-app:room",
        payload: { type: "update" },
      })
    })

    expect(port.postMessage).toHaveBeenCalledWith({
      type: "error",
      appInstanceId: "test-app:room",
      requestId: "req-B",
      error: "rate_limited",
    })
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "error",
      appInstanceId: "test-app:room",
      error: "rate_limited",
    })
    expect(sendUnicast).toHaveBeenCalledTimes(2)

    act(() => {
      resultListener?.({
        requestId: "req-A",
        appInstanceId: "test-app:room",
        ok: true,
      })
    })
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "unicast_result",
      requestId: "req-A",
      appInstanceId: "test-app:room",
      ok: true,
    })
  })

  it("forwards remote lanes and emits participant lifecycle changes", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    let listener: ((message: RoomAppTransportEnvelope) => void) | undefined
    let unicastListener: ((message: RoomAppUnicastEnvelope) => void) | undefined
    let resultListener: ((result: RoomAppUnicastResult) => void) | undefined
    const subscribe = vi.fn((next: typeof listener) => {
      listener = next
      return () => undefined
    })
    const subscribeUnicast = vi.fn((next: typeof unicastListener) => {
      unicastListener = next
      return () => undefined
    })
    const subscribeUnicastResults = vi.fn((next: typeof resultListener) => {
      resultListener = next
      return () => undefined
    })
    const sendUnicast = vi.fn(
      (
        _requestId: string,
        _targetParticipantId: string,
        _appInstanceId: string,
        _payload: Record<string, unknown>
      ) => "sent" as const
    )
    const { rerender } = render(
      <RoomAppHost
        app={app}
        appInstanceId="test-app:room"
        self={self}
        participants={participants}
        subscribe={subscribe}
        send={() => true}
        subscribeUnicast={subscribeUnicast}
        subscribeUnicastResults={subscribeUnicastResults}
        sendUnicast={sendUnicast}
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
        appInstanceId: "test-app:room",
        handshakeToken: bootstrap.handshakeToken,
      })
      lastChannel!.port1.emit({
        type: "sendReliableTo",
        appInstanceId: "test-app:room",
        requestId: "secret_for_bob",
        targetParticipantId: "human-b",
        payload: { type: "secret", word: "otter" },
      })
      lastChannel!.port1.emit({
        type: "sendReliableTo",
        appInstanceId: "test-app:room",
        requestId: "secret_for_carol",
        targetParticipantId: "human-c",
        payload: { type: "secret", word: "fox" },
      })
      listener?.({
        protocolVersion: 1,
        appInstanceId: "test-app:room",
        lane: "realtime",
        sourceParticipantId: "human-b",
        payload: { type: "cursor", x: 2 },
      })
      unicastListener?.({
        protocolVersion: 1,
        appInstanceId: "test-app:room",
        sourceParticipantId: "human-b",
        payload: { type: "secret", word: "otter" },
      })
    })
    expect(sendUnicast).toHaveBeenNthCalledWith(
      1,
      "secret_for_bob",
      "human-b",
      "test-app:room",
      { type: "secret", word: "otter" }
    )
    expect(sendUnicast).toHaveBeenNthCalledWith(
      2,
      "secret_for_carol",
      "human-c",
      "test-app:room",
      { type: "secret", word: "fox" }
    )
    act(() => {
      resultListener?.({
        requestId: "another-request",
        appInstanceId: "test-app:room",
        ok: true,
      })
    })
    expect(lastChannel!.port1.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "unicast_result" })
    )
    act(() => {
      resultListener?.({
        requestId: "secret_for_carol",
        appInstanceId: "test-app:room",
        ok: false,
        error: "target_unavailable",
      })
      resultListener?.({
        requestId: "secret_for_bob",
        appInstanceId: "test-app:room",
        ok: true,
      })
    })
    expect(lastChannel!.port1.postMessage).toHaveBeenCalledWith({
      type: "realtime",
      appInstanceId: "test-app:room",
      sourceParticipantId: "human-b",
      payload: { type: "cursor", x: 2 },
    })
    expect(lastChannel!.port1.postMessage).toHaveBeenCalledWith({
      type: "unicast",
      appInstanceId: "test-app:room",
      sourceParticipantId: "human-b",
      payload: { type: "secret", word: "otter" },
    })
    expect(lastChannel!.port1.postMessage).toHaveBeenCalledWith({
      type: "unicast_result",
      requestId: "secret_for_carol",
      appInstanceId: "test-app:room",
      ok: false,
      error: "target_unavailable",
    })
    expect(lastChannel!.port1.postMessage).toHaveBeenCalledWith({
      type: "unicast_result",
      requestId: "secret_for_bob",
      appInstanceId: "test-app:room",
      ok: true,
    })
    rerender(
      <RoomAppHost
        app={app}
        appInstanceId="test-app:room"
        self={self}
        participants={[self]}
        subscribe={subscribe}
        send={() => true}
        subscribeUnicast={subscribeUnicast}
        subscribeUnicastResults={subscribeUnicastResults}
        sendUnicast={sendUnicast}
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

/**
 * #393 taught the browser Room to re-read the Lab catalog every
 * ROOM_APP_CATALOG_REFRESH_INTERVAL_MS. The browser loader parses that JSON
 * again on every refresh, so even a catalog that did not change hands every
 * mounted host brand-new `RoomAppDefinition` objects. The host bridge must
 * follow the mounted App instance, not the metadata object that describes it.
 */
describe("RoomAppHost App-instance transport lifetime", () => {
  const appInstanceId = "test-app:room"
  let deliverRemote: ((message: RoomAppTransportEnvelope) => void) | undefined
  let deliverAgentRequest:
    | ((request: RoomAppAgentRequestEnvelope) => void)
    | undefined

  beforeEach(() => {
    deliverRemote = undefined
    deliverAgentRequest = undefined
  })

  /**
   * Parse one Lab catalog revision exactly like the browser loader does, and
   * install it like the refresh path does before React sees the new objects.
   */
  function catalogRevision(label: string = app.label): RoomAppDefinition {
    const catalog = parseRoomAppCatalog({
      version: 1,
      apps: [{ id: app.id, label, path: `/${app.id}`, status: "active" }],
    })
    if (!catalog) throw new Error("the fixture catalog must parse")
    setProductionRoomAppCatalog(catalog)
    return catalog[0]
  }

  const baseProps = {
    appInstanceId,
    self,
    participants,
    subscribe: (listener: (message: RoomAppTransportEnvelope) => void) => {
      deliverRemote = listener
      return () => undefined
    },
    send: () => true,
    subscribeUnicast: () => () => undefined,
    subscribeUnicastResults: () => () => undefined,
    sendUnicast: () => "sent" as const,
    subscribeAgentRequests: (
      listener: (request: RoomAppAgentRequestEnvelope) => void
    ) => {
      deliverAgentRequest = listener
      return () => undefined
    },
    setAgentHostReady: () => undefined,
    respondAgentRequest: () => true,
    onClose: () => undefined,
  }

  /** Completes the iframe handshake and returns the live host-owned port. */
  function handshake(
    iframe: HTMLIFrameElement,
    frameWindow: { postMessage: ReturnType<typeof vi.fn> },
    instanceId: string = appInstanceId
  ) {
    fireEvent.load(iframe)
    const bootstrap = frameWindow.postMessage.mock.calls[0][0]
    act(() => {
      lastChannel!.port1.emit({
        type: "ready",
        appInstanceId: instanceId,
        handshakeToken: bootstrap.handshakeToken,
      })
    })
    return { port: lastChannel!.port1, bootstrap }
  }

  function mountApp(
    definition: RoomAppDefinition,
    overrides: Partial<ComponentProps<typeof RoomAppHost>> = {}
  ) {
    const rendered = render(
      <RoomAppHost {...baseProps} app={definition} {...overrides} />
    )
    const iframe = screen.getByTestId("room-app-iframe") as HTMLIFrameElement
    const frameWindow = { postMessage: vi.fn() }
    Object.defineProperty(iframe, "contentWindow", { value: frameWindow })
    return { rendered, iframe, frameWindow }
  }

  it("keeps the handshaken bridge when a catalog refresh returns an equal new definition", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    const send = vi.fn(() => true)
    const first = catalogRevision()
    const { rendered, iframe, frameWindow } = mountApp(first, { send })
    const { port } = handshake(iframe, frameWindow)
    expect(screen.getByText("ready")).toBeInTheDocument()

    // The refresh: same logical catalog, brand-new object identity.
    const refreshed = catalogRevision()
    expect(refreshed).not.toBe(first)
    expect(refreshed).toEqual(first)
    rendered.rerender(
      <RoomAppHost {...baseProps} app={refreshed} send={send} />
    )

    // The resident iframe and its port survive the refresh, and the host did
    // not secretly bootstrap a replacement bridge.
    expect(screen.getByTestId("room-app-iframe")).toBe(iframe)
    expect(frameWindow.postMessage).toHaveBeenCalledTimes(1)
    expect(lastChannel!.port1).toBe(port)
    expect(port.close).not.toHaveBeenCalled()
    expect(screen.getByText("ready")).toBeInTheDocument()

    // App → host still reaches the Room transport.
    act(() => {
      port.emit({
        type: "sendReliable",
        appInstanceId,
        payload: { type: "tick", at: 1 },
      })
    })
    expect(send).toHaveBeenCalledWith("reliable", appInstanceId, {
      type: "tick",
      at: 1,
    })

    // host → App still delivers a remote reliable message into the iframe.
    act(() => {
      deliverRemote?.({
        protocolVersion: 1,
        appInstanceId,
        lane: "reliable",
        sourceParticipantId: "human-b",
        payload: { type: "tick", at: 2 },
      })
    })
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "reliable",
      appInstanceId,
      sourceParticipantId: "human-b",
      payload: { type: "tick", at: 2 },
    })
    rendered.unmount()
  })

  it("forwards opaque Agent requests over MessagePort and returns one correlated response", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    const setAgentHostReady = vi.fn()
    const respondAgentRequest = vi.fn(() => true)
    const { rendered, iframe, frameWindow } = mountApp(catalogRevision(), {
      setAgentHostReady,
      respondAgentRequest,
    })
    const { port } = handshake(iframe, frameWindow)
    expect(setAgentHostReady).toHaveBeenCalledWith(appInstanceId, true)
    const payload = { arbitrary: [1, "two"], nested: { value: true } }
    act(() =>
      deliverAgentRequest?.({ requestId: "req_1", appInstanceId, payload })
    )
    expect(port.postMessage).toHaveBeenLastCalledWith({
      type: "agent_request",
      requestId: "req_1",
      appInstanceId,
      payload,
    })
    act(() =>
      port.emit({
        type: "agentResponse",
        appInstanceId,
        requestId: "req_1",
        ok: true,
        result: { echoed: payload },
      })
    )
    expect(respondAgentRequest).toHaveBeenCalledWith({
      requestId: "req_1",
      appInstanceId,
      ok: true,
      result: { echoed: payload },
    })
    act(() =>
      port.emit({
        type: "agentResponse",
        appInstanceId,
        requestId: "req_1",
        ok: true,
        result: { duplicate: true },
      })
    )
    expect(respondAgentRequest).toHaveBeenCalledTimes(1)
    rendered.unmount()
    expect(setAgentHostReady).toHaveBeenLastCalledWith(appInstanceId, false)
  })

  it("withdraws host readiness across an iframe re-bootstrap gap", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    const setAgentHostReady = vi.fn()
    const { rendered, iframe, frameWindow } = mountApp(catalogRevision(), {
      setAgentHostReady,
    })
    const { port: oldPort } = handshake(iframe, frameWindow)
    expect(setAgentHostReady.mock.calls.map(([, ready]) => ready)).toEqual([
      false,
      true,
    ])

    fireEvent.load(iframe)
    expect(setAgentHostReady.mock.calls.map(([, ready]) => ready)).toEqual([
      false,
      true,
      false,
    ])
    expect(oldPort.close).toHaveBeenCalled()
    const bootstrap = frameWindow.postMessage.mock.calls[1]![0]
    const newPort = lastChannel!.port1
    act(() =>
      deliverAgentRequest?.({
        requestId: "req_during_bootstrap",
        appInstanceId,
        payload: { opaque: true },
      })
    )
    expect(newPort.postMessage).not.toHaveBeenCalled()

    act(() =>
      newPort.emit({
        type: "ready",
        appInstanceId,
        handshakeToken: bootstrap.handshakeToken,
      })
    )
    expect(setAgentHostReady.mock.calls.map(([, ready]) => ready)).toEqual([
      false,
      true,
      false,
      true,
    ])
    rendered.unmount()
  })

  it("keeps the handshaken bridge when only App metadata changes", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    const send = vi.fn(() => true)
    const first = catalogRevision()
    const { rendered, iframe, frameWindow } = mountApp(first, { send })
    const { port } = handshake(iframe, frameWindow)

    const renamed = catalogRevision("Test App (renamed)")
    expect(renamed.label).toBe("Test App (renamed)")
    rendered.rerender(<RoomAppHost {...baseProps} app={renamed} send={send} />)

    // Metadata is allowed to reach the UI...
    expect(screen.getByText("Test App (renamed)")).toBeInTheDocument()
    expect(screen.getByTestId("room-app-host")).toHaveAttribute(
      "aria-label",
      "Test App (renamed)"
    )
    // ...but it never resets the resident transport.
    expect(screen.getByTestId("room-app-iframe")).toBe(iframe)
    expect(lastChannel!.port1).toBe(port)
    expect(port.close).not.toHaveBeenCalled()

    act(() => {
      port.emit({
        type: "sendReliable",
        appInstanceId,
        payload: { type: "renamed", at: 3 },
      })
    })
    expect(send).toHaveBeenCalledWith("reliable", appInstanceId, {
      type: "renamed",
      at: 3,
    })
    rendered.unmount()
  })

  it("re-bootstraps the resident iframe after a real navigation", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    const send = vi.fn(() => true)
    const { rendered, iframe, frameWindow } = mountApp(catalogRevision(), {
      send,
    })
    const { port, bootstrap } = handshake(iframe, frameWindow)

    // A real iframe navigation fires onLoad again without remounting the host.
    fireEvent.load(iframe)

    expect(screen.getByTestId("room-app-iframe")).toBe(iframe)
    expect(port.close).toHaveBeenCalledTimes(1)
    expect(lastChannel!.port1).not.toBe(port)
    const nextBootstrap = frameWindow.postMessage.mock.calls[1][0]
    expect(nextBootstrap.type).toBe("room-app-bootstrap")
    expect(nextBootstrap.handshakeToken).not.toBe(bootstrap.handshakeToken)
    // Truthful status: the old bridge is gone until the new one handshakes.
    expect(screen.getByText("connecting…")).toBeInTheDocument()

    act(() => {
      lastChannel!.port1.emit({
        type: "ready",
        appInstanceId,
        handshakeToken: nextBootstrap.handshakeToken,
      })
    })
    expect(screen.getByText("ready")).toBeInTheDocument()
    act(() => {
      lastChannel!.port1.emit({
        type: "sendRealtime",
        appInstanceId,
        payload: { type: "cursor", x: 1 },
      })
    })
    expect(send).toHaveBeenCalledWith("realtime", appInstanceId, {
      type: "cursor",
      x: 1,
    })
    rendered.unmount()
  })

  it("retires the bridge exactly once when the resident App is removed", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    const { rendered, iframe, frameWindow } = mountApp(catalogRevision())
    const { port } = handshake(iframe, frameWindow)

    rendered.unmount()

    expect(screen.queryByTestId("room-app-iframe")).toBeNull()
    expect(port.close).toHaveBeenCalledTimes(1)
  })

  it("never leaves a ready UI on a retired bridge when a definition becomes unusable", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    const definition = catalogRevision()
    const { rendered, iframe, frameWindow } = mountApp(definition)
    const { port } = handshake(iframe, frameWindow)
    expect(screen.getByText("ready")).toBeInTheDocument()

    // A hostile or stale definition can no longer be allowlisted; the iframe
    // is replaced by the unavailable state and its bridge must retire with it.
    setProductionRoomAppCatalog(EMPTY_ROOM_APP_CATALOG)
    rendered.rerender(<RoomAppHost {...baseProps} app={definition} />)

    expect(screen.queryByTestId("room-app-iframe")).toBeNull()
    expect(screen.getByRole("alert")).toBeInTheDocument()
    expect(screen.queryByText("ready")).toBeNull()
    expect(port.close).toHaveBeenCalledTimes(1)
  })

  it("restores and replaces an opaque snapshot through only the curated local bridge", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    const key = `free4chat:room-app-recovery:v1:${appInstanceId}`
    const initialSnapshot = '{"opaque":"saved"}'
    const nextSnapshot = '{"opaque":"latest"}'
    window.sessionStorage.removeItem(key)
    window.sessionStorage.setItem(key, initialSnapshot)
    const send = vi.fn(() => true)
    const sendUnicast = vi.fn(() => "sent" as const)
    const respondAgentRequest = vi.fn(() => true)
    const definition = catalogRevision()
    const { rendered, iframe, frameWindow } = mountApp(definition, {
      send,
      sendUnicast,
      respondAgentRequest,
    })
    const { port } = handshake(iframe, frameWindow)

    expect(port.postMessage).toHaveBeenLastCalledWith({
      type: "ready",
      protocolVersion: 1,
      appInstanceId,
      self,
      participants,
      localRecovery: initialSnapshot,
    })

    act(() => {
      port.emit({
        type: "setLocalRecovery",
        appInstanceId,
        snapshot: nextSnapshot,
      })
    })
    expect(window.sessionStorage.getItem(key)).toBe(nextSnapshot)
    expect(send).not.toHaveBeenCalled()
    expect(sendUnicast).not.toHaveBeenCalled()
    expect(respondAgentRequest).not.toHaveBeenCalled()
    rendered.unmount()
    window.sessionStorage.removeItem(key)
  })

  it("isolates snapshots by App instance and leaves a missing snapshot null", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    const instanceA = appInstanceId
    const instanceB = "test-app:other-room"
    const keyA = `free4chat:room-app-recovery:v1:${instanceA}`
    const keyB = `free4chat:room-app-recovery:v1:${instanceB}`
    window.sessionStorage.removeItem(keyA)
    window.sessionStorage.removeItem(keyB)
    window.sessionStorage.setItem(keyA, "only-a")
    const definition = catalogRevision()
    const first = mountApp(definition)
    const firstPort = handshake(first.iframe, first.frameWindow).port
    expect(firstPort.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ localRecovery: "only-a" })
    )
    first.rendered.unmount()

    const second = mountApp(definition, { appInstanceId: instanceB })
    const secondPort = handshake(
      second.iframe,
      second.frameWindow,
      instanceB
    ).port
    expect(secondPort.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ localRecovery: null })
    )
    act(() => {
      secondPort.emit({
        type: "setLocalRecovery",
        appInstanceId: instanceA,
        snapshot: "cannot-write-a",
      })
    })
    expect(window.sessionStorage.getItem(keyA)).toBe("only-a")
    expect(window.sessionStorage.getItem(keyB)).toBeNull()
    second.rendered.unmount()
    window.sessionStorage.removeItem(keyA)
    window.sessionStorage.removeItem(keyB)
  })

  it("keeps Generated Apps outside local recovery and tolerates storage errors", () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel)
    const generated = {
      id: "generated:task-1",
      label: "Task App",
      url: "https://room-apps.free4.chat/generated",
      origin: "https://room-apps.free4.chat",
      source: "generated" as const,
      srcDoc: "<main>Task</main>",
    }
    const generatedKey = `free4chat:room-app-recovery:v1:${generated.id}`
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("storage unavailable")
      })
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota exceeded")
      })
    const { rendered, iframe, frameWindow } = mountApp(generated, {
      appInstanceId: generated.id,
    })
    const { port } = handshake(iframe, frameWindow, generated.id)
    const generatedReadyMessage = port.postMessage.mock.lastCall?.[0]
    expect(generatedReadyMessage?.type).toBe("ready")
    expect("localRecovery" in generatedReadyMessage).toBe(false)
    act(() => {
      port.emit({
        type: "setLocalRecovery",
        appInstanceId: generated.id,
        snapshot: "generated-must-not-store",
      })
    })
    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(screen.getByText("ready")).toBeInTheDocument()
    rendered.unmount()
    getItem.mockRestore()
    setItem.mockRestore()
    expect(window.sessionStorage.getItem(generatedKey)).toBeNull()

    const failingRead = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("storage disabled")
      })
    const failure = mountApp(catalogRevision())
    const failurePort = handshake(failure.iframe, failure.frameWindow).port
    expect(failurePort.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ localRecovery: null })
    )
    const failingWrite = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("storage quota")
      })
    act(() => {
      failurePort.emit({
        type: "setLocalRecovery",
        appInstanceId,
        snapshot: "best-effort",
      })
    })
    expect(screen.getByText("ready")).toBeInTheDocument()
    failure.rendered.unmount()
    failingRead.mockRestore()
    failingWrite.mockRestore()
  })
})
