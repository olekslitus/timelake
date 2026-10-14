import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  cacheComponents: true,
  // The TypeScript client (with its WASM reader) is a workspace package consumed from source.
  transpilePackages: ["@timelake/client"],
  // Files read from disk at runtime: benchmark results (when /benchmarks revalidates) and the OG image fonts.
  outputFileTracingIncludes: {
    "/benchmarks": ["./data/results/**"],
    "/opengraph-image": ["./assets/fonts/**"],
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
}

export default nextConfig
