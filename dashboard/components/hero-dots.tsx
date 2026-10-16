"use client"

import { useEffect, useRef } from "react"

const DOT = 3
const CELL = 4
/** Milliseconds to draw the series in, left to right. */
const REVEAL_MS = 1600
/** Milliseconds per new column while hovered. */
const TICK_MS = 55
/** How far each new point moves toward the cursor (0..1). */
const FOLLOW = 0.45

/** The files area on the left, in columns, and the chart's gap after it. */
const FILES = 22
const GAP = 3
/** A small file holds SMALL×SMALL points; MERGE small files compact into one big file of BIG×BIG squares. */
const SMALL = 4
const MERGE = 4
const BIG = 8
/** Big files kept on screen. */
const KEEP = 3

/** The series' shape when nobody is hovering: height (0..1 of the strip, 0 at the top) at column x of `cols`. */
const shape = (x: number, cols: number) => 0.5 + Math.sin((x / cols) * 6 + 1) * 0.2 + Math.sin((x / cols) * 23) * 0.05

/** A reading for a height, for the bound labels: 0 at the bottom, 100 at the top. */
const reading = (v: number) => Math.round((1 - v) * 100)

/**
 * The hero's chart in squares: one series, with dashed lines at the highest and lowest values on screen, and on the
 * left the files its points are written to. It draws in once when the page loads. While hovered it is a live feed:
 * the chart scrolls left, each new point is published at the cursor's height, each point leaving the chart fills the
 * current file, full files are committed, and every four small files are compacted into one big file. When the cursor
 * leaves, everything stops.
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
    const [paper, pen, muted] = [color("--border"), color("--primary"), color("--muted-foreground")]
    const font = getComputedStyle(document.body).getPropertyValue("--font-mono") || "monospace"

    let progress = 0
    // The series, one value per chart column, newest last; `next` is where its shape continues from.
    let values: number[] = []
    let next = 0
    let cursorY: number | null = null
    // The files: points in the one being written, small files committed, big files compacted so far.
    let filling = Math.round(SMALL * SMALL * 0.45)
    let small = 2
    let big = 2

    const fit = (cols: number) => {
      if (values.length === cols) return
      const kept = values.slice(-cols)
      next = cols
      values = [...Array.from({ length: cols - kept.length }, (_, x) => shape(x, cols)), ...kept]
    }

    const square = (x: number, y: number, fill: string, alpha: number) => {
      ctx.globalAlpha = alpha
      ctx.fillStyle = fill
      ctx.fillRect(x * CELL, y * CELL, DOT, DOT)
    }
    const label = (text: string, x: number, y: number) => {
      ctx.globalAlpha = 0.9
      ctx.fillStyle = muted
      ctx.font = `10px ${font}`
      ctx.fillText(text, x * CELL, y * CELL)
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
      const left = FILES + GAP
      const chartCols = Math.max(1, cols - left)
      fit(chartCols)

      // The paper.
      for (let x = 0; x < cols; x++) for (let y = 0; y < rows; y++) square(x, y, paper, 0.55)
      // The edge between the files and the chart.
      for (let y = 0; y < rows; y += 2) square(FILES + 1, y, muted, 0.35)

      // The files: big ones compacted at the top, then the small ones, the last of them being written.
      const top = Math.max(3, Math.floor((rows - (BIG + 1) * 2 - SMALL - 8) / 2))
      label("compacted", 1, top - 1)
      for (let j = 0; j < Math.min(big, KEEP); j++)
        for (let x = 0; x < BIG; x++)
          for (let y = 0; y < BIG; y++)
            square(1 + x + (j % 2) * (BIG + 2), top + y + Math.floor(j / 2) * (BIG + 1), pen, 0.4)
      const smallTop = top + Math.ceil(Math.min(big, KEEP) / 2) * (BIG + 1) + 4
      label("written", 1, smallTop - 1)
      for (let i = 0; i < MERGE; i++) {
        const [fx, fy] = [1 + i * (SMALL + 1), smallTop]
        for (let n = 0; n < SMALL * SMALL; n++) {
          const [x, y] = [fx + (n % SMALL), fy + Math.floor(n / SMALL)]
          if (i < small) square(x, y, pen, 0.6)
          else if (i === small && n < filling) square(x, y, pen, 1)
        }
      }

      // The series and its bounds.
      const upTo = progress * chartCols
      const shown = values.slice(0, Math.max(1, Math.ceil(upTo)))
      const rowOf = (v: number) => Math.max(0, Math.min(rows - 1, Math.round(v * (rows - 1))))
      const [hi, lo] = [Math.min(...shown), Math.max(...shown)]
      for (const [v, name] of [
        [hi, "max"],
        [lo, "min"],
      ] as const) {
        const y = rowOf(v)
        for (let x = left; x < cols; x += 2) square(x, y, muted, 0.6)
        label(`${name} ${reading(v)}`, cols - 12, name === "max" ? y - 1 : y + 4)
      }
      let prev: number | null = null
      for (let i = 0; i < chartCols && i <= upTo; i++) {
        const y = rowOf(values[i] ?? 0.5)
        // Join steep steps, so the line stays connected.
        const [a, b] = prev === null ? [y, y] : [Math.min(prev, y), Math.max(prev, y)]
        for (let r = a; r <= b; r++) square(left + i, r, pen, 1)
        prev = y
      }
      ctx.globalAlpha = 1
    }

    /** One new column: the oldest point goes into the current file, and a new one arrives at the cursor's height. */
    const publish = () => {
      const last = values.at(-1) ?? 0.5
      const value = cursorY === null ? shape(next, values.length) : last + (cursorY - last) * FOLLOW
      values = [...values.slice(1), value]
      next++
      if (++filling === SMALL * SMALL) {
        filling = 0
        if (++small === MERGE) {
          small = 0
          big++
        }
      }
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
