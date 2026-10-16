"use client"

import { RotateCcw } from "lucide-react"
import { useEffect, useRef, useState } from "react"

/** One system in a race: how much it ends up with (`value`, drawn as `dots`), and how long that took. */
export type Racer = {
  label: string
  value: number
  dots: number
  seconds: number
  timelake: boolean
}

/** The slowest racer finishes after this many milliseconds of animation; the others keep their proportions. */
const PLAY_MS = 7000
const DOT = 3
const GAP = 1

/**
 * Systems side by side, each a lane of dots that fill at the pace the run measured (sped up so the slowest finishes
 * in a few seconds). What a dot stands for is in `unit` and the caption.
 */
export function Race({
  racers,
  unit,
  decimals = 0,
  caption,
}: {
  racers: Racer[]
  unit: string
  decimals?: number
  caption: string
}) {
  // A replay mounts the lanes afresh, which restarts the clock.
  const [run, setRun] = useState(0)
  return (
    <div className="flex flex-col gap-5 rounded-md border bg-card p-6">
      <Lanes key={run} racers={racers} unit={unit} decimals={decimals} />
      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-xs text-muted-foreground">
        <span className="max-w-3xl">{caption}</span>
        <button
          type="button"
          onClick={() => setRun((n) => n + 1)}
          className="flex items-center gap-1.5 font-mono tracking-[0.06em] uppercase hover:text-foreground"
        >
          <RotateCcw className="size-3.5" /> Replay
        </button>
      </div>
    </div>
  )
}

/** Every racer against one clock, from mount until the slowest is done. */
function Lanes({ racers, unit, decimals }: { racers: Racer[]; unit: string; decimals: number }) {
  const [elapsed, setElapsed] = useState(0)
  const slowest = Math.max(...racers.map((r) => r.seconds))
  const scale = PLAY_MS / 1000 / slowest

  useEffect(() => {
    let frame = 0
    const start = performance.now()
    const tick = (now: number) => {
      const t = (now - start) / 1000 / scale
      setElapsed(Math.min(t, slowest))
      if (t < slowest) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [scale, slowest])

  return racers.map((r) => <Lane key={r.label} racer={r} elapsed={elapsed} unit={unit} decimals={decimals} />)
}

function Lane({ racer, elapsed, unit, decimals }: { racer: Racer; elapsed: number; unit: string; decimals: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const frac = Math.min(1, elapsed / racer.seconds)
  const shown = Math.round(racer.dots * frac)
  const done = frac >= 1
  const fmt = (v: number) =>
    v.toLocaleString("en", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const width = c.clientWidth
    const perRow = Math.max(1, Math.floor(width / (DOT + GAP)))
    const rows = Math.ceil(racer.dots / perRow)
    const dpr = window.devicePixelRatio || 1
    c.width = width * dpr
    c.height = rows * (DOT + GAP) * dpr
    c.style.height = `${rows * (DOT + GAP)}px`
    const ctx = c.getContext("2d")
    if (!ctx) return
    ctx.scale(dpr, dpr)
    const css = getComputedStyle(c)
    const on = css.getPropertyValue(racer.timelake ? "--primary" : "--muted-foreground").trim()
    const off = css.getPropertyValue("--border").trim()
    for (let i = 0; i < racer.dots; i++) {
      ctx.fillStyle = i < shown ? on : off
      ctx.fillRect((i % perRow) * (DOT + GAP), Math.floor(i / perRow) * (DOT + GAP), DOT, DOT)
    }
  }, [racer, shown])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
        <span className={racer.timelake ? "font-medium" : "text-muted-foreground"}>{racer.label}</span>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          <span className={racer.timelake ? "text-primary" : "text-foreground"}>{fmt(racer.value * frac)}</span>
          {` / ${fmt(racer.value)} ${unit} · `}
          {(done ? racer.seconds : elapsed).toFixed(2)} s{done ? " ✓" : ""}
        </span>
      </div>
      <canvas ref={canvas} className="w-full" />
    </div>
  )
}
