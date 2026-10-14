export default function ContributeLayout({ children }: LayoutProps<"/contribute">) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12">
      <article className="prose-docs max-w-3xl">{children}</article>
    </div>
  )
}
