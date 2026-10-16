"use client"

import { useEffect, useRef, useState } from "react"

/** Horizontal pixels per segment of the pulse. */
const SEG = 36
/** Vertical pixels between the parallel lines. */
const GAP = 14
/** Pixels the field moves per frame. */
const SPEED = 0.35

/** Mostly flat, with an occasional sharp rise or dip. */
const step = () => {
  const r = Math.random()
  return r < 0.7 ? 0 : r < 0.85 ? -(10 + Math.random() * 22) : 6 + Math.random() * 10
}

/** What one frame draws: the field's size, how far it has moved, and the pulse heights in view. */
type View = { w: number; h: number; offset: number; first: number; heights: number[] }

/**
 * The mark's idea as a field: parallel lines that turn together at sharp corners, like readings from one machine,
 * drifting slowly to the left. One line is in the accent.
 */
export function SeriesField({ children }: { children?: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ w: 0, h: 0, offset: 0, first: 0, heights: [] })

  useEffect(() => {
    const el = box.current
    if (!el) return
    const size = { w: el.clientWidth, h: el.clientHeight }
    const ro = new ResizeObserver(([e]) => {
      if (e) Object.assign(size, { w: e.contentRect.width, h: e.contentRect.height })
    })
    ro.observe(el)
    // The shared pulse: one height per segment boundary, extended as the field moves.
    const pulse: number[] = []
    let offset = 0
    let frame = 0
    const tick = () => {
      offset += SPEED
      const first = Math.floor(offset / SEG)
      const count = Math.ceil(size.w / SEG) + 2
      while (pulse.length < first + count) pulse.push(step())
      setView({ ...size, offset, first, heights: pulse.slice(first, first + count) })
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])

  const { w, h, offset, first, heights } = view
  const lines = Math.ceil(h / GAP) + 4
  const accent = Math.floor(lines / 2)
  const path = (base: number) =>
    heights
      .map((dy, i) => `${i ? "L" : "M"}${((first + i) * SEG - offset).toFixed(1)},${(base + dy).toFixed(1)}`)
      .join(" ")

  return (
    <div ref={box} className="relative h-[234px] overflow-hidden">
      <svg aria-hidden className="absolute inset-0" width={w} height={h}>
        {Array.from({ length: lines }, (_, i) => (
          <path
            key={i}
            d={path((i - 2) * GAP)}
            fill="none"
            stroke={i === accent ? "var(--primary)" : "var(--ascii)"}
            strokeOpacity={i === accent ? 0.8 : 1}
            strokeWidth={i === accent ? 1.5 : 1.25}
            strokeLinejoin="miter"
          />
        ))}
      </svg>
      {children}
    </div>
  )
}
