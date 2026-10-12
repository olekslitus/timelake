export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ["KB", "MB", "GB", "TB"]
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n)
}

export function formatCompact(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n)
}

export function formatAgo(ms: number | null, now: number): string {
  if (ms == null) return "never"
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—"
  if (typeof v === "number") return Number.isInteger(v) ? formatNumber(v) : v.toFixed(4).replace(/\.?0+$/, "")
  return String(v)
}

export function tableHref(name: string): string {
  return `/explore/tables/${encodeURIComponent(name)}`
}
