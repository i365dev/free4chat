import React from "react"

import { AppProps } from "next/app"
import Script from "next/script"

import "../styles/tailwind.scss"

function MyApp({ Component, pageProps }: AppProps): JSX.Element {
  return (
    <>
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/webrtc-adapter/8.1.2/adapter.js" />
      <Component {...pageProps} />
    </>
  )
}

export default MyApp
