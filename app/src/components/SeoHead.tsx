import Head from "next/head"

const SITE_ORIGIN = "https://www.free4.chat"

export interface SeoHeadProps {
  title: string
  description: string
  /** Site-relative path, e.g. "/temporary-chat-room". Must start with "/". */
  path: string
  /** Disable canonical/index directives for transitional compatibility pages. */
  indexable?: boolean
}

/**
 * Per-page SEO tags for the small set of indexable discovery pages. Kept
 * separate from _document.tsx, which only owns site-wide fallbacks.
 */
export default function SeoHead({
  title,
  description,
  path,
  indexable = true,
}: SeoHeadProps) {
  const url = `${SITE_ORIGIN}${path}`
  return (
    <Head>
      <title>{title}</title>
      <meta name="description" content={description} />
      {indexable && <link rel="canonical" href={url} />}
      <meta
        name="robots"
        content={indexable ? "index, follow" : "noindex, follow"}
      />
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content="Free4Chat" />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      {indexable && <meta property="og:url" content={url} />}
      <meta name="twitter:card" content="summary" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
    </Head>
  )
}
