import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const router = vi.hoisted(() => ({
  isReady: true,
  query: { app: "my-app" } as Record<string, unknown>,
  replace: vi.fn(),
}))
vi.mock("next/router", () => ({ useRouter: () => router }))

import {
  EMPTY_ROOM_APP_CATALOG,
  setProductionRoomAppCatalog,
} from "../../common/roomApp"
import {
  readRoomAppAcquisition,
  type RoomAppAcquisitionHandoff,
} from "../../common/roomAppAcquisition"
import OpenApp from "../../pages/open-app"

const ACQUISITION_STORAGE_KEY = "free4chat:room-app-acquisition"

const remoteCatalog = {
  version: 1,
  apps: [
    { id: "my-app", label: "My App", path: "/my-app", status: "active" },
    {
      id: "paused-app",
      label: "Paused App",
      path: "/paused-app",
      status: "disabled",
    },
  ],
}

/** The generated Room name this launch redirected to, as the browser sees it. */
function launchedRoomName(): string {
  const [url] = router.replace.mock.calls.at(-1) ?? []
  return new URL(String(url), "https://www.free4.chat").searchParams.get(
    "id"
  ) as string
}

function storedHandoff(): RoomAppAcquisitionHandoff | null {
  const raw = window.sessionStorage.getItem(ACQUISITION_STORAGE_KEY)
  return raw ? (JSON.parse(raw) as RoomAppAcquisitionHandoff) : null
}

describe("generic Room App launcher", () => {
  let discoveryCta: ReturnType<typeof vi.fn>

  beforeEach(() => {
    window.localStorage.removeItem("rooms")
    window.sessionStorage.clear()
    router.query = { app: "my-app" }
    router.replace.mockReset().mockResolvedValue(true)
    discoveryCta = vi.fn()
    // The real bridge forwards to Umami and the Cloudflare Zaraz/Mixpanel tag;
    // stubbing the sink observes exactly what would be sent to both.
    vi.stubGlobal("umami", { track: discoveryCta })
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(remoteCatalog), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
      )
    )
  })

  afterEach(() => {
    cleanup()
    window.localStorage.removeItem("rooms")
    window.sessionStorage.clear()
    setProductionRoomAppCatalog(EMPTY_ROOM_APP_CATALOG)
    vi.unstubAllGlobals()
  })

  it("creates one Room through the existing bootstrap path for an active App", async () => {
    render(<OpenApp />)

    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith(
        expect.stringMatching(/^\/room\?id=.+&app=my-app$/)
      )
    )
    const rooms = JSON.parse(
      window.localStorage.getItem("rooms") ?? "[]"
    ) as Array<{
      roomName: string
      nickName: string
    }>
    expect(rooms).toHaveLength(1)
    expect(rooms[0].roomName).toBeTruthy()
    expect(rooms[0].nickName).toBeTruthy()
  })

  it.each(["not-listed", "paused-app", "Bad Id", "../my-app"])(
    "does not create a Room for invalid or inactive App id %s",
    async (appId) => {
      router.query.app = appId
      render(<OpenApp />)

      expect(
        await screen.findByText("This App is unavailable")
      ).toBeInTheDocument()
      expect(router.replace).not.toHaveBeenCalled()
      expect(window.localStorage.getItem("rooms")).toBeNull()
    }
  )

  describe("#134 acquisition context", () => {
    it("emits the canonical discovery launch signal once for a validated slug", async () => {
      router.query = { app: "my-app", acquisitionPage: "live-poll" }
      const view = render(<OpenApp />)

      await waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1))
      expect(discoveryCta).toHaveBeenCalledTimes(1)
      expect(discoveryCta).toHaveBeenCalledWith("DiscoveryCtaClicked", {
        page: "live-poll",
        acquisitionPage: "live-poll",
      })

      // An effect re-run (StrictMode remount, router object identity) must not
      // duplicate the launch signal.
      router.query = { app: "my-app", acquisitionPage: "live-poll" }
      view.rerender(<OpenApp />)
      await waitFor(() => expect(discoveryCta).toHaveBeenCalledTimes(1))
    })

    it("binds the handoff to the generated Room and the launched App", async () => {
      router.query = { app: "my-app", acquisitionPage: "live-poll" }
      render(<OpenApp />)

      await waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1))
      const roomName = launchedRoomName()
      expect(storedHandoff()).toEqual({
        roomName,
        appId: "my-app",
        acquisitionPage: "live-poll",
      })
      // The launched Room is matched by its own handoff and nothing else.
      expect(readRoomAppAcquisition(roomName)).toEqual(storedHandoff())
      expect(readRoomAppAcquisition("another-room")).toBeNull()
      expect(readRoomAppAcquisition(roomName, "other-app")).toBeNull()

      // The Room URL stays Room identity: no acquisition context rides along,
      // so an invite link cannot transfer it to another browser.
      expect(String(router.replace.mock.calls[0][0])).not.toContain(
        "acquisitionPage"
      )
      expect(String(router.replace.mock.calls[0][0])).not.toContain("live-poll")
      // No Room name, Room content, or user identity reaches analytics.
      expect(discoveryCta).toHaveBeenCalledWith("DiscoveryCtaClicked", {
        page: "live-poll",
        acquisitionPage: "live-poll",
      })
    })

    it("launches the same App without a handoff or CTA when no context is given", async () => {
      router.query = { app: "my-app" }
      render(<OpenApp />)

      await waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1))
      expect(storedHandoff()).toBeNull()
      expect(discoveryCta).not.toHaveBeenCalled()
    })

    it.each([
      ["an unknown slug shape", "Live Poll"],
      ["an over-long slug", "a".repeat(33)],
      ["a URL-shaped value", "https://evil.example/apps/live-poll"],
      ["a path value", "/apps/live-poll"],
      ["a repeated parameter", ["live-poll", "typing-race"]],
      ["an empty value", ""],
      ["a non-string value", 7],
    ])(
      "ignores %s and still launches the App",
      async (_label, acquisitionPage) => {
        router.query = { app: "my-app", acquisitionPage }
        render(<OpenApp />)

        await waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1))
        expect(String(router.replace.mock.calls[0][0])).toMatch(
          /^\/room\?id=.+&app=my-app$/
        )
        expect(storedHandoff()).toBeNull()
        // A direct launch never fabricates a discovery CTA.
        expect(discoveryCta).not.toHaveBeenCalled()
      }
    )

    it("does not carry the previous launch's context into a later direct launch", async () => {
      router.query = { app: "my-app", acquisitionPage: "live-poll" }
      const first = render(<OpenApp />)
      await waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1))
      const firstRoom = launchedRoomName()
      expect(readRoomAppAcquisition(firstRoom)?.acquisitionPage).toBe(
        "live-poll"
      )
      first.unmount()

      // A later /open-app launch for the same App, without acquisition context,
      // must not read the earlier entry back.
      router.replace.mockClear()
      router.query = { app: "my-app" }
      render(<OpenApp />)
      await waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1))

      const secondRoom = launchedRoomName()
      expect(secondRoom).not.toBe(firstRoom)
      expect(readRoomAppAcquisition(secondRoom)).toBeNull()
      // The stale entry still belongs to its own launch only.
      expect(readRoomAppAcquisition(firstRoom)?.acquisitionPage).toBe(
        "live-poll"
      )
      expect(discoveryCta).toHaveBeenCalledTimes(1)
    })

    it("does not emit the discovery CTA for an App that is not launchable", async () => {
      router.query = { app: "paused-app", acquisitionPage: "live-poll" }
      render(<OpenApp />)

      expect(
        await screen.findByText("This App is unavailable")
      ).toBeInTheDocument()
      expect(router.replace).not.toHaveBeenCalled()
      expect(discoveryCta).not.toHaveBeenCalled()
      expect(storedHandoff()).toBeNull()
    })
  })
})
