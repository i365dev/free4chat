import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"
import tsconfigPaths from "vite-tsconfig-paths"

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  resolve: {
    alias: {
      // Workers-runtime module: real one exists only inside wrangler/opennext
      // builds; tests get a minimal DurableObject base stub.
      "cloudflare:workers": new URL(
        "./vitest.cloudflare-workers-stub.ts",
        import.meta.url
      ).pathname,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
})
