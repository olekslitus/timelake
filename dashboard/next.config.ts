import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // The TypeScript client (with its WASM reader) is a workspace package consumed from source.
  transpilePackages: ["@timelake/client"],
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
