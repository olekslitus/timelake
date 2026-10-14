import type { MDXComponents } from "mdx/types"
import Link from "next/link"

/** Elements in MDX pages. Styles come from `.prose-docs` (app/globals.css); internal links use next/link. */
const components: MDXComponents = {
  a: ({ href = "", ...props }) =>
    href.startsWith("/") ? <Link href={href} {...props} /> : <a href={href} {...props} />,
}

export function useMDXComponents(): MDXComponents {
  return components
}
