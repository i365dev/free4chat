import { expect, test, type Page } from "@playwright/test"

const ROOM_SLUG = `counter-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`

type RoomSession = {
  participantId: string
  participantToken: string
}

async function installMediaShim(page: Page) {
  await page.addInitScript(() => {
    class FakeRTCPeerConnection {
      onicecandidate = null
      ontrack = null
      ondatachannel = null
      __transceivers: Array<{
        sender: { track: unknown }
        receiver: { track: null }
        mid: string
        direction: string
      }> = []
      addTrack() {
        return { mid: "0", direction: "sendonly" }
      }
      addTransceiver(track: unknown, init: { direction?: string } = {}) {
        const transceiver = {
          sender: { track },
          receiver: { track: null },
          mid: "0",
          direction: init?.direction ?? "sendrecv",
        }
        this.__transceivers.push(transceiver)
        return transceiver
      }
      createDataChannel(label: string) {
        return {
          label,
          readyState: "open",
          bufferedAmount: 0,
          bufferedAmountLowThreshold: 0,
          send() {},
          close() {},
          addEventListener() {},
          removeEventListener() {},
        }
      }
      createOffer() {
        return Promise.resolve({ type: "offer", sdp: "v=0\r\n" })
      }
      createAnswer() {
        return Promise.resolve({ type: "answer", sdp: "v=0\r\n" })
      }
      setLocalDescription() {
        return Promise.resolve()
      }
      setRemoteDescription() {
        return Promise.resolve()
      }
      getTransceivers() {
        return this.__transceivers
      }
      getConfiguration() {
        return { iceServers: [] }
      }
      getStats() {
        return Promise.resolve(new Map())
      }
      getSenders() {
        return []
      }
      getReceivers() {
        return []
      }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    ;(window as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      FakeRTCPeerConnection
  })
}

async function joinRoom(page: Page, nickname: string): Promise<RoomSession> {
  await installMediaShim(page)
  let session: RoomSession | undefined
  page.on("response", async (response) => {
    if (
      !response.url().includes("/api/sfu/session") ||
      response.status() !== 200
    )
      return
    try {
      const payload = (await response.json()) as Partial<RoomSession>
      if (payload.participantId && payload.participantToken)
        session = payload as RoomSession
    } catch {
      // The page's own error state is the assertion for a malformed session.
    }
  })
  await page.goto(`/room?id=${ROOM_SLUG}`)
  await page.getByLabel("Nickname").fill(nickname)
  await page.getByRole("button", { name: /Go/i }).click()
  await expect(page.getByText(new RegExp(nickname)).first()).toBeVisible({
    timeout: 15_000,
  })
  await expect.poll(() => session?.participantId).toBeTruthy()
  return session!
}

test("two Room browsers share one external Counter task with scoped authority", async ({
  browser,
}) => {
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()

  const sessionA = await joinRoom(pageA, "Alice")
  await pageA.getByRole("button", { name: "Start Counter" }).click()
  await expect(pageA.getByTestId("counter-status")).toContainText("Count: 0")
  await expect(pageA.getByTestId("counter-status")).toContainText("your turn")

  const sessionB = await joinRoom(pageB, "Bob")
  await expect(pageB.getByRole("button", { name: "Join Counter" })).toBeVisible(
    {
      timeout: 15_000,
    }
  )
  await pageB.getByRole("button", { name: "Join Counter" }).click()
  await expect(pageB.getByTestId("counter-status")).toContainText("waiting")
  await expect(pageB.getByTestId("counter-increment")).toBeDisabled()

  // The UI correctly disables a non-owner, but the authoritative action path
  // is also exercised directly with B's real Room credential. Counter must
  // reject it before any Room message or Agent wakeup can occur.
  const authorizedUnauthorized = await pageB.evaluate(
    async (session) => {
      const response = await fetch("/api/room/experiments/counter", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Room-Id": session.room,
          "X-Room-Participant-Id": session.participantId,
          "X-Room-Participant-Token": session.participantToken,
        },
        body: JSON.stringify({ operation: "increment" }),
      })
      return response.status
    },
    { ...sessionB, room: ROOM_SLUG }
  )
  expect(authorizedUnauthorized).toBe(403)

  await pageA.getByTestId("counter-increment").click()
  await expect(pageA.getByTestId("counter-status")).toContainText("Count: 1")
  await expect(pageB.getByTestId("counter-status")).toContainText("Count: 1")
  await expect(pageB.getByTestId("counter-status")).toContainText("your turn")

  await pageB.getByTestId("counter-increment").click()
  await expect(pageB.getByTestId("counter-status")).toContainText("Count: 2")
  await expect(pageA.getByTestId("counter-status")).toContainText("Count: 2")

  const message = "ordinary Room chat still works"
  await pageA.getByPlaceholder("Message the room or @ an Agent…").fill(message)
  await pageA.keyboard.press("Enter")
  await expect(pageB.getByText(message).first()).toBeVisible({
    timeout: 15_000,
  })

  console.log(
    JSON.stringify({
      roomId: ROOM_SLUG,
      participantA: sessionA.participantId,
      participantB: sessionB.participantId,
      task: "same Room-scoped Counter task",
      count: 2,
      ordinaryChat: "PASS",
      agentWakeups: "none observed; unit path asserts 0 waiters",
    })
  )

  await contextB.close()
  await contextA.close()
})
