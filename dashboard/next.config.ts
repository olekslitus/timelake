import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // The TypeScript client (with its WASM reader) is a workspace package consumed from source.
  transpilePackages: ["@timelake/client"],
  // Benchmark results are read from disk; ship them with the server too (cached at build normally).
  outputFileTracingIncludes: {
    "/benchmarks": ["./data/results/**"],
    "/": ["./data/results/**"],
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
};

export default nextConfig;
