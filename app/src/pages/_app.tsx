import React, { useEffect } from "react"

import { AppProps } from "next/app"
import Script from "next/script"

import TurnstileGate from "../components/TurnstileGate"
import "../styles/tailwind.css"

function MyApp({ Component, pageProps }: AppProps): React.JSX.Element {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
    }
  }, [])

  return (
    <>
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/webrtc-adapter/8.1.2/adapter.js" />
      <TurnstileGate>
        <Component {...pageProps} />
      </TurnstileGate>
    </>
  )
}

export default MyApp
