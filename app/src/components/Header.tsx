import Head from "next/head"

const TITLE = "Free4Chat — Temporary Rooms for Humans & Agents"
const DESCRIPTION =
  "Open an instant temporary room for voice, text, and screen sharing, and bring independently running Agents in as participants. No account, no shared workspace, no hosted LLM."
const URL = "https://www.free4.chat/"

export default function Header() {
  return (
    <div>
      <Head>
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <link rel="canonical" href={URL} />
        <meta name="robots" content="index, follow" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Free4Chat" />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <meta property="og:url" content={URL} />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content={TITLE} />
        <meta name="twitter:description" content={DESCRIPTION} />
      </Head>
    </div>
  )
}
