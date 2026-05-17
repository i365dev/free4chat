import { useEffect, useRef, useState } from "react"

import { useRouter } from "next/router"

const TURNSTILE_SITEKEY =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "1x00000000000000000000AA"

interface Props {
  children: React.ReactNode
}

export default function TurnstileGate({ children }: Props) {
  const [passed, setPassed] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const router = useRouter()

  useEffect(() => {
    const handleRouteChange = () => {
      if (!sessionStorage.getItem("ts_token")) setPassed(false)
    }
    router.events.on("routeChangeStart", handleRouteChange)
    return () => router.events.off("routeChangeStart", handleRouteChange)
  }, [router.events])

  useEffect(() => {
    if (typeof window === "undefined") return
    if (sessionStorage.getItem("ts_token")) {
      setPassed(true)
      return
    }

    const script = document.createElement("script")
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
    script.async = true
    script.onload = () => {
      const ts = (window as any).turnstile
      if (ts && containerRef.current) {
        ts.render(containerRef.current, {
          sitekey: TURNSTILE_SITEKEY,
          theme: "dark",
          callback: (token: string) => {
            sessionStorage.setItem("ts_token", token)
            setPassed(true)
          },
        })
      }
    }
    document.head.appendChild(script)
    return () => {
      if (document.head.contains(script)) document.head.removeChild(script)
    }
  }, [])

  if (passed) return <>{children}</>

  return (
    <div className="flex h-screen w-full flex-col items-center justify-center bg-gray-900">
      <p className="mb-6 text-sm text-gray-400">Verifying you&apos;re human…</p>
      <div ref={containerRef} />
    </div>
  )
}
