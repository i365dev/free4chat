import Link from "next/link"

import { ROOM_APP_CATALOG } from "../../common/roomApp"
import DiscoveryFooter from "../../components/DiscoveryFooter"
import SeoHead from "../../components/SeoHead"

const TITLE = "Free4Chat Apps — Shared Activities for Temporary Rooms"
const DESCRIPTION =
  "Explore shared tools and lightweight activities that open inside temporary Free4Chat Rooms. Start without an account, share one Room link, and collaborate or play."

export default function AppsPage() {
  const whiteboard = ROOM_APP_CATALOG.find((app) => app.id === "whiteboard")

  return (
    <div className="flex min-h-screen flex-col font-mono text-emerald-100">
      <SeoHead title={TITLE} description={DESCRIPTION} path="/apps" />
      <main className="flex-1 px-4 py-16">
        <div className="mx-auto max-w-3xl">
          <Link
            href="/"
            className="text-sm text-emerald-500 hover:text-emerald-300"
          >
            ← Free4Chat
          </Link>
          <p className="mt-10 font-mono text-xs tracking-widest text-emerald-500">
            FREE4CHAT://ROOM_APPS
          </p>
          <h1 className="mt-4 text-3xl font-extrabold uppercase tracking-tight text-emerald-200 sm:text-4xl">
            Apps for temporary Free4Chat Rooms
          </h1>
          <p className="mt-5 max-w-2xl text-sm leading-relaxed text-emerald-300/80">
            Shared tools and lightweight activities that open inside a temporary
            Room. No account. Open an App, share the Room link, and collaborate
            or play.
          </p>

          {whiteboard && (
            <section aria-label="Production Room Apps" className="mt-10">
              <article className="border border-emerald-900/70 bg-black/30 p-5 sm:p-6">
                <p className="text-xs tracking-widest text-emerald-600">
                  ROOM APP · {whiteboard.id.toUpperCase()}
                </p>
                <h2 className="mt-3 text-xl font-bold text-emerald-200">
                  Online {whiteboard.label}
                </h2>
                <p className="mt-3 text-sm leading-relaxed text-emerald-300/80">
                  A free collaborative whiteboard powered by Excalidraw. Draw
                  and edit together in a temporary Room, then share one link to
                  bring other people in.
                </p>
                <Link
                  href={`/apps/${whiteboard.id}`}
                  className="mt-5 inline-flex text-sm text-emerald-400 underline-offset-4 transition hover:text-white hover:underline focus:outline-none focus:ring focus:ring-emerald-500/40"
                >
                  Explore {whiteboard.label} →
                </Link>
              </article>
            </section>
          )}
        </div>
      </main>
      <DiscoveryFooter />
    </div>
  )
}
