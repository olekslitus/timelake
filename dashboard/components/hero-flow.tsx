"use client"

import { useEffect, useRef } from "react"

import { BATCH, type File, Writer, widthOf } from "@/components/hero-writer"

const DOT = 3
const CELL = 4
/** Milliseconds per tick while hovered: one new point each. */
const TICK_MS = 55
/** How far each new point moves toward the cursor (0..1). */
const FOLLOW = 0.45
/** Rows kept clear above and below the chart, so the bounds' labels always fit. */
const PAD = 5
/** Columns of the object store, and the gaps around it. */
const STORE = 44
const GAP = 6
/** Below this many columns there is no room for readers. */
const MIN_COLS_FOR_READERS = 200
/** Ticks one reader's turn lasts (about 7 s), and the ticks its chart takes to draw in. */
const CYCLE = 130
const REVEAL = 20

/** A reader, its query, the files that query reads (days are today first), and the chart it draws. */
type Reader = {
  name: string
  query: string
  pick: (days: File[][]) => File[]
  chart: "avg" | "band" | "bars" | "peak"
  /** Points per bucket: the reader downsamples the series to this. */
  per: number
}
const READERS: Reader[] = [
  { name: "Dashboard", query: "avg per minute", pick: (d) => (d[0] ?? []).slice(-2), chart: "avg", per: 4 },
  { name: "Dashboard", query: "min–max per minute", pick: (d) => (d[0] ?? []).slice(-2), chart: "band", per: 4 },
  { name: "DuckDB", query: "avg per hour", pick: (d) => d[0] ?? [], chart: "bars", per: 10 },
  { name: "AI agent", query: "when was the peak?", pick: (d) => d[0] ?? [], chart: "peak", per: 4 },
]

/** The series' shape when nobody is hovering: height (0..1, 0 at the top) at column x of `cols`. */
const shape = (x: number, cols: number) => 0.5 + Math.sin((x / cols) * 6 + 1) * 0.3 + Math.sin((x / cols) * 23) * 0.06
/** A reading for a height: 0 at the bottom, 100 at the top. */
const reading = (v: number) => Math.round((1 - v) * 100)

/** The series in buckets of `per` points: each bucket's average, lowest and highest value (heights, 0 at the top). */
function downsample(values: number[], per: number): { avg: number; top: number; bottom: number }[] {
  const out = []
  for (let i = 0; i < values.length; i += per) {
    const b = values.slice(i, i + per)
    out.push({ avg: b.reduce((s, v) => s + v, 0) / b.length, top: Math.min(...b), bottom: Math.max(...b) })
  }
  return out
}

/**
 * The hero as a pipeline, left to right: you publish points with the cursor; they are written to the object store
 * (batched in memory, committed as files in day partitions, compacted); and readers take turns: the files a reader's
 * query needs light up, and the reader draws the series downsampled its own way. Everything moves only while the
 * cursor is over it.
 */
export function HeroFlow() {
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

    const writer = new Writer()
    let values: number[] = []
    let next = 0
    let cursorY: number | null = null
    // The current reader, and how far into its turn (a finished turn when idle).
    let reader = 0
    let phase = CYCLE
    let rows = 0

    const square = (x: number, y: number, fill: string, alpha: number) => {
      ctx.globalAlpha = alpha
      ctx.fillStyle = fill
      ctx.fillRect(x * CELL, y * CELL, DOT, DOT)
    }
    const label = (text: string, x: number, y: number, fill = muted) => {
      ctx.globalAlpha = 0.9
      ctx.fillStyle = fill
      ctx.font = `9px ${font}`
      ctx.fillText(text, x * CELL, y * CELL)
    }
    const rowOf = (v: number) => PAD + Math.round(Math.max(0, Math.min(1, v)) * (rows - 1 - 2 * PAD))
    /** The files a reader's query reads, or yesterday's if today has none yet. */
    const pickFiles = (r: Reader) => {
      const files = r.pick(writer.days)
      return files.length > 0 ? files : (writer.days[1] ?? [])
    }

    /** A reader's chart in x..x+width, rows top..bottom, drawn `done` (0..1) of the way. */
    const chart = (r: Reader, x: number, width: number, top: number, bottom: number, done: number) => {
      const buckets = downsample(values, r.per)
      const step = width / buckets.length
      const at = (v: number) => top + Math.round(Math.max(0, Math.min(1, v)) * (bottom - top))
      const shown = buckets.slice(0, Math.ceil(buckets.length * done))
      const peak = buckets.reduce((best, b, i) => ((buckets[best]?.avg ?? 1) > b.avg ? i : best), 0)
      let prev: number | null = null
      shown.forEach((b, i) => {
        const [x0, x1] = [x + Math.round(i * step), x + Math.round((i + 1) * step) - 1]
        const y = at(b.avg)
        if (r.chart === "bars") {
          for (let cx = x0; cx < x1; cx++) for (let cy = y; cy <= bottom; cy++) square(cx, cy, pen, 0.75)
          return
        }
        if (r.chart === "band")
          for (let cx = x0; cx < x1; cx++) for (let cy = at(b.top); cy <= at(b.bottom); cy++) square(cx, cy, pen, 0.25)
        // A step per bucket, joined to the one before.
        if (prev !== null) for (let cy = Math.min(prev, y); cy <= Math.max(prev, y); cy++) square(x0, cy, pen, 1)
        for (let cx = x0; cx <= x1; cx++) square(cx, y, pen, r.chart === "peak" && i !== peak ? 0.6 : 1)
        prev = y
      })
      if (r.chart === "peak" && done >= 1) {
        const b = buckets[peak]
        if (b) {
          const [x0, y] = [x + Math.round(peak * step), at(b.avg)]
          for (const [dx, dy] of [
            [-1, -1],
            [0, -2],
            [1, -1],
          ] as const)
            square(x0 + dx, y + dy, pen, 1)
          label(`peak ${reading(b.avg)}`, Math.min(x0 + 3, x + width - 10), Math.max(top + 2, y - 2), pen)
        }
      }
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
      rows = Math.floor(h / CELL)
      const readers = cols >= MIN_COLS_FOR_READERS
      const chartEnd = Math.floor(cols * (readers ? 0.4 : 0.5))
      const storeX = chartEnd + GAP
      const readersX = storeX + STORE + GAP
      const chartCols = chartEnd - 1
      if (values.length !== chartCols) {
        const kept = values.slice(-chartCols)
        next = chartCols
        values = [...Array.from({ length: chartCols - kept.length }, (_, x) => shape(x, chartCols)), ...kept]
      }

      for (let x = 0; x < cols; x++) for (let y = 0; y < rows; y++) square(x, y, paper, 0.55)
      for (const edge of readers ? [storeX - 3, readersX - 3] : [storeX - 3])
        for (let y = 0; y < rows; y += 2) square(edge, y, muted, 0.35)

      // The series you publish, and its bounds.
      const [hi, lo] = [Math.min(...values), Math.max(...values)]
      for (const [v, name] of [
        [hi, "max"],
        [lo, "min"],
      ] as const) {
        const y = rowOf(v)
        for (let x = 1; x < chartEnd; x += 2) square(x, y, muted, 0.6)
        label(`${name} ${reading(v)}`, chartEnd - 12, name === "max" ? y - 1 : y + 4)
      }
      let prev: number | null = null
      values.forEach((v, i) => {
        const y = rowOf(v)
        const [a, b] = prev === null ? [y, y] : [Math.min(prev, y), Math.max(prev, y)]
        for (let r = a; r <= b; r++) square(1 + i, r, pen, 1)
        prev = y
      })

      // The object store: path, memory, version, then the partitions and their files.
      const turn = readers ? READERS[reader] : undefined
      const read = new Set(turn ? pickFiles(turn) : [])
      label("s3://lake/iot/readings", storeX, 4, pen)
      label(`memory ${writer.buffered}/${BATCH}`, storeX, 8)
      for (let i = 0; i < BATCH; i++)
        for (const [dx, dy] of [
          [0, 1],
          [1, 1],
          [0, 2],
          [1, 2],
        ] as const)
          square(storeX + i * 3 + dx, 8 + dy, pen, i < writer.buffered ? 1 : 0.15)
      label(`v${writer.version} ${writer.event}`, storeX, 15, pen)
      writer.days.forEach((list, d) => {
        const y = 20 + d * 8
        label(writer.partition(d), storeX, y)
        let x = storeX
        for (const f of list) {
          const width = widthOf(f)
          if (x + width > storeX + STORE) break
          const lit = read.size === 0 ? (f === writer.fresh ? 1 : f.sorted ? 0.4 : 0.7) : read.has(f) ? 1 : 0.18
          for (let dx = 0; dx < width; dx++) for (const dy of [1, 2, 3]) square(x + dx, y + dy, pen, lit)
          x += width + 1
        }
      })

      // The reader: who, what it asked, what it read, and its chart.
      if (turn) {
        label(turn.name, readersX, 4, pen)
        label(turn.query, readersX + Math.ceil(turn.name.length * 1.5) + 2, 4)
        label(`reads ${read.size} of ${writer.days.flat().length} files`, readersX, rows - 2)
        chart(turn, readersX, cols - readersX - 2, 8, rows - 7, Math.min(1, phase / REVEAL))
      }
      ctx.globalAlpha = 1
    }

    /** One tick: a new point arrives at the cursor's height and is written, and the reader's turn moves on. */
    const tick = () => {
      const last = values.at(-1) ?? 0.5
      const value = cursorY === null ? shape(next, values.length) : last + (cursorY - last) * FOLLOW
      values = [...values.slice(1), value]
      next++
      writer.write()
      if (++phase > CYCLE) {
        phase = 0
        reader = (reader + 1) % READERS.length
      }
      draw()
    }

    draw()
    let timer: ReturnType<typeof setInterval> | null = null
    const move = (e: PointerEvent) => {
      const r = c.getBoundingClientRect()
      const height = Math.floor(r.height / CELL)
      cursorY = Math.max(0, Math.min(1, ((e.clientY - r.top) / CELL - PAD) / (height - 1 - 2 * PAD)))
      if (!timer) timer = setInterval(tick, TICK_MS)
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
      if (timer) clearInterval(timer)
      area.removeEventListener("pointermove", move)
      area.removeEventListener("pointerleave", leave)
      ro.disconnect()
    }
  }, [])

  return <canvas ref={canvas} aria-hidden className="absolute inset-0 h-full w-full" />
}
