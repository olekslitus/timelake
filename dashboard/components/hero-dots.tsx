"use client"

import { useEffect, useRef } from "react"

const DOT = 3
const CELL = 4
/** Milliseconds to draw the series in, left to right. */
const REVEAL_MS = 1600
/** Milliseconds per new column while hovered. */
const TICK_MS = 55
/** How far each new point of the cursor's series moves toward the cursor (0..1). */
const FOLLOW = 0.45

/** The series across the strip: height (0..1 of the strip) at column x of `cols`, a color and a strength. */
const SERIES: { at: (x: number, cols: number) => number; color: string; alpha: number; cursor?: boolean }[] = [
  {
    at: (x, cols) => 0.28 + Math.sin((x / cols) * 9) * 0.08 + Math.sin((x / cols) * 31) * 0.025,
    color: "--muted-foreground",
    alpha: 0.45,
  },
  {
    at: (x, cols) => 0.5 + Math.sin((x / cols) * 6 + 1) * 0.16 + Math.sin((x / cols) * 23) * 0.04,
    color: "--primary",
    alpha: 1,
    cursor: true,
  },
  {
    at: (x, cols) => 0.74 + Math.sin((x / cols) * 11 + 2.5) * 0.07 + Math.sin((x / cols) * 37) * 0.02,
    color: "--muted-foreground",
    alpha: 0.45,
  },
]

/**
 * The hero's background: a field of dim squares with three time series in lit squares, drawn in once when the page
 * loads. While the hero is hovered it becomes a live feed: the chart scrolls left, and the blue series publishes each
 * new point at the cursor's height. When the cursor leaves, the chart stops.
 */
export function HeroDots() {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const c = canvas.current
    const ctx = c?.getContext("2d")
    const area = c?.parentElement
    if (!c || !ctx || !area) return
    const css = getComputedStyle(c)
    const color = (name: string) => css.getPropertyValue(name).trim()
    const paper = color("--border")
    let progress = 0
    // Each series' values, one per column, newest last; `next` is the column the generated series continue from.
    let values: number[][] = []
    let next = 0
    let cursorY: number | null = null

    /** Keeps one value per column, filling a new strip (or a wider one) from the series' own shapes. */
    const fit = (cols: number) => {
      if (values.length === SERIES.length && values[0]?.length === cols) return
      const old = values
      next = cols
      values = SERIES.map((s, k) => {
        const kept = (old[k] ?? []).slice(-cols)
        const fresh = Array.from({ length: cols - kept.length }, (_, x) => s.at(x, cols))
        return [...fresh, ...kept]
      })
    }

    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const [w, h] = [c.clientWidth, c.clientHeight]
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr)
        c.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const cols = Math.floor(w / CELL)
      const rows = Math.floor(h / CELL)
      fit(cols)
      ctx.globalAlpha = 0.55
      ctx.fillStyle = paper
      for (let x = 0; x < cols; x++) for (let y = 0; y < rows; y++) ctx.fillRect(x * CELL, y * CELL, DOT, DOT)
      const upTo = progress * cols
      SERIES.forEach((s, k) => {
        ctx.globalAlpha = s.alpha
        ctx.fillStyle = color(s.color)
        let prev: number | null = null
        for (let x = 0; x < cols && x <= upTo; x++) {
          const v = values[k]?.[x] ?? 0.5
          const y = Math.max(0, Math.min(rows - 1, Math.round(v * (rows - 1))))
          // Join steep steps, so the line stays connected.
          const [top, bottom] = prev === null ? [y, y] : [Math.min(prev, y), Math.max(prev, y)]
          for (let r = top; r <= bottom; r++) ctx.fillRect(x * CELL, r * CELL, DOT, DOT)
          prev = y
        }
      })
      ctx.globalAlpha = 1
    }

    /** One new column: everything moves left, the blue series follows the cursor, the others go on as before. */
    const publish = () => {
      const cols = values[0]?.length ?? 0
      values = values.map((v, k) => {
        const s = SERIES[k]
        const last = v.at(-1) ?? 0.5
        const value = s?.cursor && cursorY !== null ? last + (cursorY - last) * FOLLOW : (s?.at(next, cols) ?? last)
        return [...v.slice(1), value]
      })
      next++
      draw()
    }

    // Draw in once on load.
    let frame = 0
    const start = performance.now()
    const reveal = (now: number) => {
      progress = Math.min(1, (now - start) / REVEAL_MS)
      draw()
      if (progress < 1) frame = requestAnimationFrame(reveal)
    }
    frame = requestAnimationFrame(reveal)

    // While hovered, publish a column every tick; stop when the cursor leaves.
    let timer: ReturnType<typeof setInterval> | null = null
    const move = (e: PointerEvent) => {
      const r = c.getBoundingClientRect()
      cursorY = Math.max(0.04, Math.min(0.96, (e.clientY - r.top) / r.height))
      if (!timer) {
        progress = 1
        timer = setInterval(publish, TICK_MS)
      }
    }
    const leave = () => {
      cursorY = null
      if (timer) clearInterval(timer)
      timer = null
    }
    area.addEventListener("pointermove", move)
    area.addEventListener("pointerleave", leave)
    const ro = new ResizeObserver(draw)
    ro.observe(c)
    return () => {
      cancelAnimationFrame(frame)
      if (timer) clearInterval(timer)
      area.removeEventListener("pointermove", move)
      area.removeEventListener("pointerleave", leave)
      ro.disconnect()
    }
  }, [])

  return <canvas ref={canvas} aria-hidden className="absolute inset-0 h-full w-full" />
}
