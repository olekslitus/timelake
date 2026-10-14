import createMDX from "@next/mdx"
import type { NextConfig } from "next"
import { createCssVariablesTheme } from "shiki"

const nextConfig: NextConfig = {
  cacheComponents: true,
  // Docs pages are MDX (app/(site)/docs/**/page.mdx).
  pageExtensions: ["ts", "tsx", "mdx"],
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

// Turbopack takes plugins by name with JSON options. Code is highlighted at build time; the colors are CSS
// variables (--shiki-*, in globals.css), so one render follows the light and dark themes.
const withMDX = createMDX({
  options: {
    remarkPlugins: ["remark-gfm"],
    rehypePlugins: [
      "rehype-slug",
      ["rehype-autolink-headings", { behavior: "wrap" }],
      ["rehype-pretty-code", { theme: createCssVariablesTheme({ name: "site" }), keepBackground: false }],
    ],
  },
})

export default withMDX(nextConfig)
