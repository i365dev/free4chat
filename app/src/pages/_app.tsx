import React, { useEffect } from "react"

import { AppProps } from "next/app"
import { useRouter } from "next/router"
import Script from "next/script"

import "../styles/tailwind.css"

function MyApp({ Component, pageProps }: AppProps): React.JSX.Element {
  const router = useRouter()
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
    }
  }, [])

  // The Room is a working media surface: never draw the CRT scanline and
  // vignette overlays over video, screen share, or image previews.
  const isRoomSurface = router.pathname.startsWith("/room")

  return (
    <>
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/webrtc-adapter/8.1.2/adapter.js" />
      <div
        className={isRoomSurface ? "min-h-screen" : "retro-scope min-h-screen"}
      >
        <Component {...pageProps} />
      </div>
    </>
  )
}

export default MyApp
