import type { MetadataRoute } from "next"

import { BENCHMARKS } from "@/lib/benchmark-catalog"
import { hasResults } from "@/lib/benchmarks"
import { DOCS_NAV } from "@/lib/docs-nav"
import { SITE_URL } from "@/lib/site"

// The site's pages, so search engines index timelake.dev rather than the domains that redirect to it.
// The explorer is left out: it shows the lake configured on the deployment.
export default function sitemap(): MetadataRoute.Sitemap {
  const paths = [
    "/",
    ...DOCS_NAV.flatMap((s) => s.items.map((i) => i.href)),
    "/benchmarks",
    "/benchmarks/timebench",
    ...BENCHMARKS.filter(hasResults).map((b) => `/benchmarks/${b.id}`),
    ...BENCHMARKS.filter((b) => b.methodology).map((b) => `/benchmarks/${b.id}/methodology`),
    "/roadmap",
    "/contribute",
  ]
  return paths.map((p) => ({ url: `${SITE_URL}${p}` }))
}
