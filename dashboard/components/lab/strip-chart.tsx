"use client"

import { useEffect, useId, useRef, useState } from "react"

/** Pixels between two samples of the trace. */
const STEP = 3
/** Milliseconds per new sample. */
const TICK = 60

/** Slow waves with a little noise, for the recorder when it has no data; stays within -1..1. */
function* generated(): Generator<number> {
  let noise = 0
  for (let i = 0; ; i++) {
    noise = 0.9 * noise + (Math.random() - 0.5) * 0.08
    yield 0.5 * Math.sin(i / 70) + 0.25 * Math.sin(i / 23 + 1) + 0.1 * Math.sin(i / 7) + noise
  }
}

/** The values in a loop. */
function* looped(values: number[]): Generator<number> {
  for (;;) yield* values
}

/**
 * A strip-chart recorder: chart paper with a pen trace that the paper carries to the left. Without `data` the pen
 * draws a random walk; with it, the pen plays the values in a loop.
 */
export function StripChart({
  data,
  children,
  className,
}: {
  data?: number[] | null
  children?: React.ReactNode
  className?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const id = useId().replace(/[^a-zA-Z0-9]/g, "")
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [trace, setTrace] = useState<number[]>([])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (data === null) return
    const source = data && data.length > 0 ? looped(data) : generated()
    const keep = Math.ceil((size.w || 1600) / STEP) + 2
    // Start with a full strip, so the paper is never empty; the first tick shows it.
    let strip = Array.from({ length: keep }, () => source.next().value as number)
    const timer = setInterval(() => {
      strip = [...strip.slice(-keep + 1), source.next().value as number]
      setTrace(strip)
    }, TICK)
    return () => clearInterval(timer)
  }, [data, size.w])

  const { w, h } = size
  // A fixed scale: the data's range, or the random walk's (tanh keeps it in -1..1).
  const [lo, hi] = data && data.length > 0 ? [Math.min(...data), Math.max(...data)] : [-1, 1]
  const y = (v: number) => (hi === lo ? h / 2 : h * 0.82 - ((v - lo) / (hi - lo)) * h * 0.64)
  // The pen sits a little in from the right edge; the trace runs from it to the left.
  const penX = w - 40
  const points = trace.map((v, i) => `${(penX - (trace.length - 1 - i) * STEP).toFixed(1)},${y(v).toFixed(1)}`)
  const last = trace.at(-1)

  return (
    <div ref={box} className={className ?? "relative h-[234px] overflow-hidden"}>
      <svg aria-hidden className="absolute inset-0" width={w} height={h}>
        <defs>
          <pattern id={`${id}-minor`} width="12" height="12" patternUnits="userSpaceOnUse">
            <path d="M12 0H0V12" fill="none" stroke="var(--border)" strokeWidth="0.5" />
          </pattern>
          <pattern id={`${id}-major`} width="60" height="60" patternUnits="userSpaceOnUse">
            <rect width="60" height="60" fill={`url(#${id}-minor)`} />
            <path d="M60 0H0V60" fill="none" stroke="var(--border)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width={w} height={h} fill={`url(#${id}-major)`} />
        {points.length > 1 ? (
          <polyline points={points.join(" ")} fill="none" stroke="var(--primary)" strokeWidth="1.5" />
        ) : null}
        {last !== undefined ? (
          <>
            <line x1={penX} x2={penX} y1={0} y2={h} stroke="var(--muted-foreground)" strokeOpacity="0.35" />
            <circle cx={penX} cy={y(last)} r="3.5" fill="var(--primary)" />
          </>
        ) : null}
      </svg>
      {children}
    </div>
  )
}
