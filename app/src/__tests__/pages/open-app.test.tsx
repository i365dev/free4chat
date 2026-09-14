import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const router = vi.hoisted(() => ({
  isReady: true,
  query: { app: "my-app" as unknown },
  replace: vi.fn(),
}))
vi.mock("next/router", () => ({ useRouter: () => router }))

import {
  EMPTY_ROOM_APP_CATALOG,
  setProductionRoomAppCatalog,
} from "../../common/roomApp"
import OpenApp from "../../pages/open-app"

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

describe("generic Room App launcher", () => {
  beforeEach(() => {
    window.localStorage.removeItem("rooms")
    router.query.app = "my-app"
    router.replace.mockReset().mockResolvedValue(true)
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
})
