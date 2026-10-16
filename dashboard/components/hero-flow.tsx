"use client"

import { useEffect, useRef } from "react"

import { BATCH, type File, Writer, widthOf } from "@/components/hero-writer"

const DOT = 3
const CELL = 4
/** Milliseconds per tick while hovered: one new point, or one step of a reader's chart. */
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
/** Ticks one reader's turn lasts when they take turns (about 7 s), and the ticks its chart takes to draw in. */
const CYCLE = 130
const REVEAL = 20
/** Columns of the readers' list when you pick one by hovering. */
const LIST = 18

/** A reader, its query, the files that query reads (days are today first), and the chart it draws. */
type Reader = {
  name: string
  query: string
  pick: (days: File[][]) => File[]
  chart: "line" | "band" | "bars" | "candles" | "peak"
  /** Points per bucket: the reader downsamples the series to this. */
  per: number
}
const READERS: Reader[] = [
  { name: "Dashboard", query: "avg per minute", pick: (d) => (d[0] ?? []).slice(-2), chart: "line", per: 3 },
  { name: "Grafana", query: "min–max per minute", pick: (d) => (d[0] ?? []).slice(-2), chart: "band", per: 4 },
  { name: "DuckDB", query: "avg per hour", pick: (d) => d[0] ?? [], chart: "bars", per: 10 },
  { name: "Trading app", query: "OHLC per minute", pick: (d) => d[0] ?? [], chart: "candles", per: 8 },
  { name: "AI agent", query: "when was the peak?", pick: (d) => d[0] ?? [], chart: "peak", per: 4 },
]

/** The series' shape when nobody is hovering: height (0..1, 0 at the top) at column x of `cols`. */
const shape = (x: number, cols: number) => 0.5 + Math.sin((x / cols) * 6 + 1) * 0.3 + Math.sin((x / cols) * 23) * 0.06
/** A reading for a height: 0 at the bottom, 100 at the top. */
const reading = (v: number) => Math.round((1 - v) * 100)

/** A bucket of points: average, highest and lowest (`top`/`bottom`, as heights with 0 at the top), first and last. */
type Bucket = { avg: number; top: number; bottom: number; open: number; close: number }

/** The series in buckets of `per` points. */
function downsample(values: number[], per: number): Bucket[] {
  const out: Bucket[] = []
  for (let i = 0; i < values.length; i += per) {
    const b = values.slice(i, i + per)
    out.push({
      avg: b.reduce((s, v) => s + v, 0) / b.length,
      top: Math.min(...b),
      bottom: Math.max(...b),
      open: b[0] ?? 0,
      close: b.at(-1) ?? 0,
    })
  }
  return out
}

/** `values` stretched to `n` points, straight between neighbours. */
function stretch(values: number[], n: number): number[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / Math.max(1, n - 1)) * (values.length - 1)
    const [a, b] = [values[Math.floor(t)] ?? 0, values[Math.ceil(t)] ?? 0]
    return a + (b - a) * (t - Math.floor(t))
  })
}

/**
 * The hero as a pipeline, left to right: you publish points with the cursor; they are written to the object store
 * (batched in memory, committed as files in day partitions, compacted); and readers query the table: the files a query
 * needs light up in the reading color, and the reader draws the series downsampled its own way. Readers see the table
 * as of the last commit, so their chart lags the live one and moves a commit at a time.
 *
 * Without `pick`, hovering anywhere publishes and the readers take turns. With `pick`, hovering the chart publishes,
 * and hovering the readers stops publishing and runs the reader under the cursor.
 */
export function HeroFlow({ pick = false }: { pick?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const c = canvas.current
    const ctx = c?.getContext("2d")
    const area = c?.parentElement
    if (!c || !ctx || !area) return
    const css = getComputedStyle(c)
    const color = (name: string) => css.getPropertyValue(name).trim()
    const [paper, pen, muted, reads] = [
      color("--border"),
      color("--primary"),
      color("--muted-foreground"),
      color("--chart-4"),
    ]
    const font = getComputedStyle(document.body).getPropertyValue("--font-mono") || "monospace"

    const writer = new Writer()
    let values: number[] = []
    // What readers see: the series as of the last commit (points still in memory aren't readable yet).
    let committed: number[] = []
    let next = 0
    let cursorY: number | null = null
    // The current reader, and how far into its turn (a finished turn when idle).
    let reader = 0
    let phase = CYCLE
    // What the cursor is doing: publishing, reading, or nothing.
    let mode: "publish" | "read" | null = null
    let layout = { storeX: 0, readersX: 0, rows: 0, readers: false }

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
    const rowOf = (v: number) => PAD + Math.round(Math.max(0, Math.min(1, v)) * (layout.rows - 1 - 2 * PAD))
    /** The files a reader's query reads, or yesterday's if today has none yet. */
    const pickFiles = (r: Reader) => {
      const files = r.pick(writer.days)
      return files.length > 0 ? files : (writer.days[1] ?? [])
    }
    /** The rows of the readers' list, one per reader. */
    const listRow = (i: number) => 8 + i * 6

    /** A reader's chart in x..x+width, rows top..bottom, drawn `done` (0..1) of the way, in the reading color. */
    const chart = (r: Reader, x: number, width: number, top: number, bottom: number, done: number) => {
      const buckets = downsample(committed, r.per)
      // Scaled to the buckets' own range, so the shape fills the chart.
      const [lo, hi] = [Math.min(...buckets.map((b) => b.top)), Math.max(...buckets.map((b) => b.bottom))]
      const at = (v: number) => top + Math.round(((v - lo) / (hi - lo || 1)) * (bottom - top))
      const upTo = Math.ceil(width * done)
      // Each bucket's columns, for the charts drawn a bucket at a time.
      const step = width / buckets.length
      const span = (i: number) => [x + Math.round(i * step), x + Math.round((i + 1) * step) - 1] as const
      const shown = buckets.filter((_, i) => span(i)[0] - x <= upTo)
      if (r.chart === "bars") {
        shown.forEach((b, i) => {
          const [x0, x1] = span(i)
          for (let cx = x0; cx < x1; cx++) for (let cy = at(b.avg); cy <= bottom; cy++) square(cx, cy, reads, 0.8)
        })
        return
      }
      if (r.chart === "candles") {
        // A wick from high to low, and a body from open to close: solid when it rose, hollow when it fell.
        shown.forEach((b, i) => {
          const [x0, x1] = span(i)
          const mid = Math.floor((x0 + x1) / 2)
          const [left, right] = step >= 6 ? [mid - 1, mid + 2] : [mid - 1, mid + 1]
          for (let cy = at(b.top); cy <= at(b.bottom); cy++) square(mid, cy, reads, 0.7)
          const [y0, y1] = [Math.min(at(b.open), at(b.close)), Math.max(at(b.open), at(b.close))]
          const rose = b.close < b.open
          for (let cx = left; cx <= right; cx++)
            for (let cy = y0; cy <= y1; cy++) {
              const edge = cx === left || cx === right || cy === y0 || cy === y1
              if (rose || edge) square(cx, cy, reads, 1)
            }
        })
        return
      }
      if (r.chart === "peak") {
        // A step per bucket, joined to the one before; the peak's step full strength and marked.
        const peak = buckets.reduce((best, b, i) => ((buckets[best]?.avg ?? 1) > b.avg ? i : best), 0)
        let prev: number | null = null
        shown.forEach((b, i) => {
          const [x0, x1] = span(i)
          const y = at(b.avg)
          if (prev !== null) for (let cy = Math.min(prev, y); cy <= Math.max(prev, y); cy++) square(x0, cy, reads, 0.6)
          for (let cx = x0; cx <= x1; cx++) square(cx, y, reads, i === peak ? 1 : 0.6)
          prev = y
        })
        const b = buckets[peak]
        if (b && done >= 1) {
          const [x0, y] = [span(peak)[0], at(b.avg)]
          for (const [dx, dy] of [
            [-1, -2],
            [0, -3],
            [1, -2],
          ] as const)
            square(x0 + dx, y + dy, reads, 1)
          label(`peak ${reading(b.avg)}`, Math.min(x0 + 6, x + width - 10), Math.max(top + 2, y - 2), reads)
        }
        return
      }
      const line = stretch(
        buckets.map((b) => b.avg),
        width,
      )
      if (r.chart === "band") {
        const [tops, bottoms] = [
          stretch(
            buckets.map((b) => b.top),
            width,
          ),
          stretch(
            buckets.map((b) => b.bottom),
            width,
          ),
        ]
        for (let i = 0; i < upTo; i++)
          for (let cy = at(tops[i] ?? 0); cy <= at(bottoms[i] ?? 0); cy++) square(x + i, cy, reads, 0.25)
      }
      let prev: number | null = null
      for (let i = 0; i < upTo; i++) {
        const y = at(line[i] ?? 0)
        const [a, b] = prev === null ? [y, y] : [Math.min(prev, y), Math.max(prev, y)]
        for (let cy = a; cy <= b; cy++) square(x + i, cy, reads, 1)
        prev = y
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
      const rows = Math.floor(h / CELL)
      const readers = cols >= MIN_COLS_FOR_READERS
      const chartEnd = Math.floor(cols * (readers ? 0.4 : 0.5))
      const storeX = chartEnd + GAP
      const readersX = storeX + STORE + GAP
      layout = { storeX, readersX, rows, readers }
      const chartCols = chartEnd - 1
      if (values.length !== chartCols) {
        const kept = values.slice(-chartCols)
        next = chartCols
        values = [...Array.from({ length: chartCols - kept.length }, (_, x) => shape(x, chartCols)), ...kept]
        committed = values.slice(0, values.length - writer.buffered)
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

      // The object store: path, memory, version, then the partitions; the files being read in the reading color.
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
          const [fill, alpha] = read.has(f) ? [reads, 1] : [pen, f === writer.fresh ? 0.9 : 0.35]
          for (let dx = 0; dx < width; dx++) for (const dy of [1, 2, 3]) square(x + dx, y + dy, fill, alpha)
          x += width + 1
        }
      })

      // The reader: who, what it asked, what it read, and its chart.
      if (turn) {
        const done = Math.min(1, phase / REVEAL)
        const files = `as of v${writer.version} · reads ${read.size} of ${writer.days.flat().length} files`
        if (pick) {
          READERS.forEach((r, i) => {
            const y = listRow(i)
            const active = i === reader
            label(r.name, readersX, y, active ? reads : muted)
            if (active) for (let dx = 0; dx < LIST - 2; dx++) square(readersX + dx, y + 2, reads, 0.6)
          })
          label(`${turn.query} · ${files}`, readersX + LIST, rows - 2)
          chart(turn, readersX + LIST, cols - readersX - LIST - 2, 5, rows - 7, done)
        } else {
          label(turn.name, readersX, 4, reads)
          label(turn.query, readersX + Math.ceil(turn.name.length * 1.5) + 2, 4)
          label(files, readersX, rows - 2)
          chart(turn, readersX, cols - readersX - 2, 8, rows - 7, done)
        }
      }
      ctx.globalAlpha = 1
    }

    /** One tick: publish a point (it is written), or move the reader's chart along. */
    const tick = () => {
      if (mode === "publish") {
        const last = values.at(-1) ?? 0.5
        const value = cursorY === null ? shape(next, values.length) : last + (cursorY - last) * FOLLOW
        values = [...values.slice(1), value]
        next++
        if (writer.write()) committed = [...values]
      }
      if (!pick && ++phase > CYCLE) {
        phase = 0
        reader = (reader + 1) % READERS.length
      }
      if (pick && mode === "read") phase++
      draw()
      // With `pick`, a finished chart doesn't need ticks until something changes.
      if (pick && mode === "read" && phase > REVEAL) stop()
    }

    let timer: ReturnType<typeof setInterval> | null = null
    const run = () => {
      if (!timer) timer = setInterval(tick, TICK_MS)
    }
    const stop = () => {
      if (timer) clearInterval(timer)
      timer = null
    }

    draw()
    const move = (e: PointerEvent) => {
      const r = c.getBoundingClientRect()
      const [x, y] = [(e.clientX - r.left) / CELL, (e.clientY - r.top) / CELL]
      const height = Math.floor(r.height / CELL)
      if (!pick || x < layout.storeX - 3) {
        // Publishing: the cursor's height within the chart's padded area, 0..1.
        cursorY = Math.max(0, Math.min(1, (y - PAD) / (height - 1 - 2 * PAD)))
        mode = "publish"
        run()
        return
      }
      cursorY = null
      mode = null
      if (layout.readers && x >= layout.readersX - 3) {
        // Reading: the reader in the list row nearest the cursor.
        const i = READERS.findIndex((_, k) => Math.abs(y - (listRow(k) - 1)) <= 3)
        if (i >= 0) {
          mode = "read"
          if (i !== reader) {
            reader = i
            phase = 0
          }
          run()
          return
        }
      }
      stop()
    }
    const leave = () => {
      cursorY = null
      mode = null
      stop()
    }
    area.addEventListener("pointermove", move)
    area.addEventListener("pointerleave", leave)
    const ro = new ResizeObserver(draw)
    ro.observe(c)
    return () => {
      stop()
      area.removeEventListener("pointermove", move)
      area.removeEventListener("pointerleave", leave)
      ro.disconnect()
    }
  }, [pick])

  return <canvas ref={canvas} aria-hidden className="absolute inset-0 h-full w-full" />
}
