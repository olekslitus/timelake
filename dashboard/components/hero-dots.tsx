"use client"

import { useEffect, useRef } from "react"

const DOT = 3
const CELL = 4
/** Milliseconds to draw the series in, left to right. */
const REVEAL_MS = 1600

/** The series across the strip: height (0..1 of the strip) at column x of `cols`, a color and a strength. */
const SERIES: { at: (x: number, cols: number) => number; color: string; alpha: number }[] = [
  {
    at: (x, cols) => 0.28 + Math.sin((x / cols) * 9) * 0.08 + Math.sin((x / cols) * 31) * 0.025,
    color: "--muted-foreground",
    alpha: 0.45,
  },
  {
    at: (x, cols) => 0.5 + Math.sin((x / cols) * 6 + 1) * 0.16 + Math.sin((x / cols) * 23) * 0.04,
    color: "--primary",
    alpha: 1,
  },
  {
    at: (x, cols) => 0.74 + Math.sin((x / cols) * 11 + 2.5) * 0.07 + Math.sin((x / cols) * 37) * 0.02,
    color: "--muted-foreground",
    alpha: 0.45,
  },
]

/**
 * The hero's background: a field of dim squares with three time series in lit squares. The series draw in once, left
 * to right, when the page loads; after that the field stays still.
 */
export function HeroDots() {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const c = canvas.current
    const ctx = c?.getContext("2d")
    if (!c || !ctx) return
    const css = getComputedStyle(c)
    const color = (name: string) => css.getPropertyValue(name).trim()
    const paper = color("--border")
    let progress = 0

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
      ctx.globalAlpha = 0.55
      ctx.fillStyle = paper
      for (let x = 0; x < cols; x++) for (let y = 0; y < rows; y++) ctx.fillRect(x * CELL, y * CELL, DOT, DOT)
      const upTo = progress * cols
      for (const s of SERIES) {
        ctx.globalAlpha = s.alpha
        ctx.fillStyle = color(s.color)
        let prev: number | null = null
        for (let x = 0; x < cols && x <= upTo; x++) {
          const y = Math.round(s.at(x, cols) * (rows - 1))
          // Join steep steps, so the line stays connected.
          const [top, bottom] = prev === null ? [y, y] : [Math.min(prev, y), Math.max(prev, y)]
          for (let r = top; r <= bottom; r++) ctx.fillRect(x * CELL, r * CELL, DOT, DOT)
          prev = y
        }
      }
      ctx.globalAlpha = 1
    }

    let frame = 0
    const start = performance.now()
    const tick = (now: number) => {
      progress = Math.min(1, (now - start) / REVEAL_MS)
      draw()
      if (progress < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    const ro = new ResizeObserver(draw)
    ro.observe(c)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
  }, [])

  return <canvas ref={canvas} aria-hidden className="absolute inset-0 h-full w-full" />
}
