"use client"

import { type CSSProperties, useEffect, useRef, useState } from "react"

/** One bar: its value, color, and the text beside it (`strong` in the foreground color). */
export type Bar = { value: number; color: string; text: string; strong?: boolean }
/** A labelled row of bars, drawn one under another. */
export type BarRow = { label: string; bars: Bar[] }

/** Milliseconds for a bar across the whole width, as fast as the card pictures draw in. */
const REVEAL_MS = 1100

/** A fill of 3 px squares on a 4 px grid in `color`: the card's background shows through the gaps. */
const dots = (color: string): CSSProperties => ({
  backgroundColor: color,
  backgroundImage:
    "linear-gradient(to right, transparent 3px, var(--card) 3px), linear-gradient(to bottom, transparent 3px, var(--card) 3px)",
  backgroundSize: "4px 4px",
})

/** A bar `share` (0..1) of the width on a dim track, two squares tall, in whole squares; it grows in when `shown`. */
function DotBar({ share, color, shown }: { share: number; color: string; shown: boolean }) {
  return (
    <div className="relative h-[7px]">
      <div className="absolute inset-0 opacity-50" style={dots("var(--border)")} />
      <div
        className="absolute inset-y-0 left-0"
        style={{
          ...dots(color),
          width: `max(4px, round(down, ${(share * 100).toFixed(2)}%, 4px))`,
          clipPath: shown ? "inset(0 0 0 0)" : "inset(0 100% 0 0)",
          transition: shown ? `clip-path ${Math.round(REVEAL_MS * share)}ms linear` : "none",
        }}
      />
    </div>
  )
}

/**
 * Bars in dot squares, a row per label, scaled to the longest bar. They grow in once, left to right, when the chart
 * comes into view, and again when its card is hovered, like the card pictures. `stacked` puts each row's label and
 * values on one line with its bars full width under them, for narrow cards.
 */
export function BarChart({
  rows,
  legend,
  caption,
  stacked = false,
}: {
  rows: BarRow[]
  legend?: { label: string; color: string }[]
  caption?: string
  stacked?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const el = box.current
    if (!el) return
    let frame = 0
    const play = () => {
      setShown(false)
      cancelAnimationFrame(frame)
      // Two frames: the bars collapse without a transition, then grow with one.
      frame = requestAnimationFrame(() => (frame = requestAnimationFrame(() => setShown(true))))
    }
    const seen = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting) {
        setShown(true)
        seen.disconnect()
      }
    })
    seen.observe(el)
    const card = el.closest("[data-use-case]")
    card?.addEventListener("pointerenter", play)
    return () => {
      cancelAnimationFrame(frame)
      seen.disconnect()
      card?.removeEventListener("pointerenter", play)
    }
  }, [])

  const longest = Math.max(...rows.flatMap((r) => r.bars.map((b) => b.value)))
  return (
    <div ref={box} className="flex flex-col gap-3 font-mono text-xs">
      {caption && <span className="text-muted-foreground">{caption}</span>}
      {stacked ? (
        <div className="flex flex-col gap-2.5">
          {rows.map((r) => (
            <div key={r.label} className="flex flex-col gap-1.5">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">{r.label}</span>
                <span className="tabular-nums">
                  {r.bars.map((b, i) => (
                    <span key={i} className={b.strong ? undefined : "text-muted-foreground"}>
                      {b.text}
                    </span>
                  ))}
                </span>
              </div>
              {r.bars.map((b, i) => (
                <DotBar key={i} share={b.value / longest} color={b.color} shown={shown} />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-3">
          {rows.map((r) => (
            <div key={r.label} className="contents">
              <span className="text-muted-foreground">{r.label}</span>
              <div className="flex flex-col gap-1.5">
                {r.bars.map((b, i) => (
                  <DotBar key={i} share={b.value / longest} color={b.color} shown={shown} />
                ))}
              </div>
              <div className="flex flex-col text-right tabular-nums">
                {r.bars.map((b, i) => (
                  <span key={i} className={b.strong ? undefined : "text-muted-foreground"}>
                    {b.text}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {legend && (
        <div className="flex flex-col gap-1 text-muted-foreground">
          {legend.map((l) => (
            <span key={l.label} className="flex items-center gap-1.5">
              <span className="size-[7px]" style={dots(l.color)} /> {l.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
