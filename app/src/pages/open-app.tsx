import { useEffect, useState } from "react"

import Head from "next/head"
import Link from "next/link"
import { useRouter } from "next/router"

import {
  generateParticipantName,
  generateRoomName,
} from "../common/cosmicNames"
import {
  isRoomAppAllowlisted,
  isValidRoomAppId,
  loadProductionRoomAppCatalog,
  setProductionRoomAppCatalog,
  validateRoomAppDefinition,
} from "../common/roomApp"
import { saveRoomToLocalStorage } from "../common/utils"

type LaunchState = "loading" | "opening" | "unavailable"

export default function OpenApp() {
  const router = useRouter()
  const [state, setState] = useState<LaunchState>("loading")

  useEffect(() => {
    if (!router.isReady) return
    let active = true
    const requestedId = router.query.app
    if (!isValidRoomAppId(requestedId)) {
      setState("unavailable")
      return
    }

    void loadProductionRoomAppCatalog()
      .then((catalog) => {
        if (!active) return
        setProductionRoomAppCatalog(catalog)
        const app = catalog.find((candidate) => candidate.id === requestedId)
        if (
          !app ||
          !validateRoomAppDefinition(app) ||
          !isRoomAppAllowlisted(app)
        ) {
          setState("unavailable")
          return
        }

        const roomName = generateRoomName()
        const nickName = generateParticipantName()
        saveRoomToLocalStorage(roomName, nickName)
        setState("opening")
        void router.replace(
          `/room?id=${encodeURIComponent(roomName)}&app=${encodeURIComponent(
            app.id
          )}`
        )
      })
      .catch(() => {
        if (active) setState("unavailable")
      })

    return () => {
      active = false
    }
  }, [router, router.isReady, router.query.app])

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-950 p-6 text-emerald-100">
      <Head>
        <title>Open Room App - Free4Chat</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <section className="max-w-lg text-center">
        {state === "unavailable" ? (
          <>
            <h1 className="text-xl font-semibold">This App is unavailable</h1>
            <p className="mt-3 text-emerald-200/70">
              The App may have been retired or the link may be invalid.
            </p>
            <Link
              className="mt-6 inline-block text-emerald-300 underline"
              href="/"
            >
              Return to Free4Chat
            </Link>
          </>
        ) : (
          <p role="status">
            {state === "opening"
              ? "Opening your Room…"
              : "Checking App availability…"}
          </p>
        )}
      </section>
    </main>
  )
}
