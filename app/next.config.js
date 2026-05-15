/** @type {import('next').NextConfig} */
const { initOpenNextCloudflareForDev } = require("@opennextjs/cloudflare")

initOpenNextCloudflareForDev()

const nextConfig = {
  reactStrictMode: true,
}

module.exports = nextConfig
