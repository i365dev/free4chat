import type { GetStaticPaths, GetStaticProps } from "next"

import {
  buildDocsStaticPaths,
  buildDocsStaticProps,
} from "../../common/docsContent.server"
import type { DocsPageProps } from "../../common/docsNav"
import DocsLayout from "../../components/DocsLayout"

/**
 * Public docs renderer for https://www.free4.chat/docs. Markdown lives in
 * ../docs/en; every route is enumerated at build time with fallback: false,
 * so production requests render prerendered content and never read the
 * repository filesystem.
 */
export default function DocsPage(props: DocsPageProps) {
  return <DocsLayout {...props} />
}

export const getStaticPaths: GetStaticPaths = () => buildDocsStaticPaths()

export const getStaticProps: GetStaticProps<DocsPageProps> = ({ params }) =>
  buildDocsStaticProps(params?.slug)
