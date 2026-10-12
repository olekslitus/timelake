export const DOCS_NAV: { title: string; items: { href: string; label: string }[] }[] = [
  {
    title: "Getting started",
    items: [
      { href: "/docs", label: "Introduction" },
      { href: "/docs/quick-start", label: "Quick start" },
      { href: "/docs/concepts", label: "Concepts" },
    ],
  },
  {
    title: "Using Timelake",
    items: [
      { href: "/docs/cli", label: "CLI reference" },
      { href: "/docs/python", label: "Python API" },
      { href: "/docs/querying", label: "Querying" },
      { href: "/docs/table-properties", label: "Table properties" },
      { href: "/docs/storage", label: "Storage & configuration" },
    ],
  },
  {
    title: "Internals",
    items: [
      { href: "/docs/architecture", label: "Architecture" },
      { href: "/docs/benchmarks", label: "Benchmarks" },
      { href: "/docs/roadmap", label: "Roadmap & limitations" },
    ],
  },
]
