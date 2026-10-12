export function CodeBlock({ title, children }: { title?: string; children: string }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-muted/40">
      {title && <div className="border-b px-4 py-2 font-mono text-xs text-muted-foreground">{title}</div>}
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-6">
        <code>{children}</code>
      </pre>
    </div>
  )
}
