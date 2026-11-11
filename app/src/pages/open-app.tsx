import { useEffect, useRef, useState } from "react"

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
import {
  isValidAcquisitionPage,
  saveRoomAppAcquisition,
} from "../common/roomAppAcquisition"
import { saveRoomToLocalStorage, trackAnalyticsEvent } from "../common/utils"

type LaunchState = "loading" | "opening" | "unavailable"

export default function OpenApp() {
  const router = useRouter()
  const [state, setState] = useState<LaunchState>("loading")
  // The canonical discovery launch signal belongs to the launch, not to a
  // render or an effect re-run; a StrictMode remount must not double-count it.
  const discoveryCtaTrackedRef = useRef(false)

  useEffect(() => {
    if (!router.isReady) return
    let active = true
    const requestedId = router.query.app
    if (!isValidRoomAppId(requestedId)) {
      setState("unavailable")
      return
    }
    // Acquisition context is analytics-only and independently bounded. An
    // invalid or absent value is ignored: it can never fail a valid launch.
    const acquisitionPage = isValidAcquisitionPage(router.query.acquisitionPage)
      ? router.query.acquisitionPage
      : null

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
        // Bind the acquisition context to this exact launch before navigating.
        // It intentionally does NOT ride along in the Room URL: an invite link
        // is Room identity, not another browser's acquisition intent.
        if (acquisitionPage) {
          saveRoomAppAcquisition({
            roomName,
            appId: app.id,
            acquisitionPage,
          })
        }
        // The Lab renders plain /open-app links, so this is the one observable
        // completion of a discovery CTA. Direct launches without valid
        // acquisition context stay silent.
        if (acquisitionPage && !discoveryCtaTrackedRef.current) {
          discoveryCtaTrackedRef.current = true
          trackAnalyticsEvent("DiscoveryCtaClicked", {
            page: acquisitionPage,
            acquisitionPage,
          })
        }
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
  }, [router, router.isReady, router.query.app, router.query.acquisitionPage])

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
