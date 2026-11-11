import Head from "next/head"

const TITLE = "Free4Chat — 人与 Agent 的临时协作房间"
const DESCRIPTION =
  "即时创建语音、文字和屏幕共享房间，邀请独立运行的 Agent 参与，并从任意设备监督专注任务。无需账号、共享工作区或托管式大模型。"
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
