export type DocsLink = { href: string; label: string; items?: DocsLink[] }

export const DOCS_NAV: { title: string; items: DocsLink[] }[] = [
  {
    title: "Getting started",
    items: [
      { href: "/docs", label: "Introduction" },
      {
        href: "/docs/quick-start",
        label: "Quick start",
        items: [
          { href: "/docs/quick-start/local", label: "Local" },
          { href: "/docs/quick-start/aws", label: "AWS" },
          { href: "/docs/quick-start/azure", label: "Azure" },
          { href: "/docs/quick-start/gcp", label: "Google Cloud" },
          { href: "/docs/quick-start/cloudflare", label: "Cloudflare" },
          { href: "/docs/quick-start/fly", label: "Fly.io" },
          { href: "/docs/quick-start/vercel", label: "Vercel" },
          { href: "/docs/quick-start/tigris", label: "Tigris" },
        ],
      },
      { href: "/docs/how-it-works", label: "How it works" },
      { href: "/docs/concepts", label: "Concepts" },
      { href: "/docs/glossary", label: "Glossary" },
    ],
  },
  {
    title: "Using Timelake",
    items: [
      { href: "/docs/cli", label: "CLI reference" },
      { href: "/docs/python", label: "Python API" },
      { href: "/docs/typescript", label: "TypeScript client" },
      { href: "/docs/querying", label: "Querying" },
      { href: "/docs/rollups", label: "Rollups" },
      { href: "/docs/settings", label: "Settings" },
      { href: "/docs/storage", label: "Storage & configuration" },
      { href: "/docs/upgrading", label: "Upgrading" },
    ],
  },
  {
    title: "Internals",
    items: [
      { href: "/docs/architecture", label: "Architecture" },
      { href: "/docs/codebase", label: "Codebase tour" },
      { href: "/docs/development", label: "Development" },
      { href: "/docs/benchmarks", label: "Benchmarks" },
      { href: "/docs/performance", label: "Performance history" },
      { href: "/docs/limitations", label: "Limitations" },
      { href: "/docs/changelog", label: "Changelog" },
      { href: "/docs/credits", label: "Credits" },
    ],
  },
]

/** Every docs page in sidebar order, sub-pages right after their parent. */
export const DOCS_PAGES: DocsLink[] = DOCS_NAV.flatMap((g) => g.items.flatMap((i) => [i, ...(i.items ?? [])]))
