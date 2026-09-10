import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"
import tsconfigPaths from "vite-tsconfig-paths"

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  // Vitest 4 resolves Vite 8/Rolldown, where the React plugin's legacy
  // esbuild JSX option is ignored. Keep the existing plugin for React
  // behavior, but configure the native transformer explicitly for TSX.
  oxc: {
    jsx: {
      runtime: "automatic",
    },
  },
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
