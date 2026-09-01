/** @type {import('next').NextConfig} */
const { initOpenNextCloudflareForDev } = require("@opennextjs/cloudflare")

initOpenNextCloudflareForDev()

const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      // The MCP reference moved into the Markdown docs library; the legacy
      // URL keeps its accumulated authority as a permanent redirect.
      {
        source: "/developers/mcp",
        destination: "/docs/reference/mcp",
        permanent: true,
      },
    ]
  },
}

module.exports = nextConfig
