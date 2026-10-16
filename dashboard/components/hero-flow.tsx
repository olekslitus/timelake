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
/** Ticks a reader takes to load a snapshot (the loading bar), and between reloads when readers take turns. */
const LOAD = 8
const RELOAD = 45
/** Columns of the readers' list when you pick one by hovering. */
const LIST = 18

/** A reader, its query, the files that query reads (days are today first), and the chart it draws. */
type Reader = {
  name: string
  query: string
  pick: (days: File[][]) => File[]
  chart: "line" | "band" | "bars" | "candles" | "peak" | "parallel" | "latest" | "heatmap" | "alerts" | "histogram"
  /** Points per bucket: the reader downsamples the series to this. */
  per: number
}
const READERS: Reader[] = [
  { name: "Dashboard", query: "avg per minute", pick: (d) => (d[0] ?? []).slice(-2), chart: "line", per: 3 },
  { name: "Grafana", query: "min–max per minute", pick: (d) => (d[0] ?? []).slice(-2), chart: "band", per: 4 },
  { name: "DuckDB", query: "avg per hour", pick: (d) => d[0] ?? [], chart: "bars", per: 10 },
  { name: "Trading app", query: "OHLC per minute", pick: (d) => d[0] ?? [], chart: "candles", per: 8 },
  { name: "AI agent", query: "when was the peak?", pick: (d) => d[0] ?? [], chart: "peak", per: 4 },
  { name: "Many readers", query: "queries at once", pick: (d) => d.flat(), chart: "parallel", per: 1 },
]

/** Candidates for the Grafana slot, shown as their own set to compare. */
const OPTIONS: Reader[] = [
  { name: "Mobile app", query: "latest value", pick: () => [], chart: "latest", per: 1 },
  { name: "Notebook", query: "heatmap by time", pick: (d) => d[0] ?? [], chart: "heatmap", per: 1 },
  { name: "Alerting", query: "above threshold", pick: (d) => d[0] ?? [], chart: "alerts", per: 1 },
  { name: "Notebook", query: "distribution", pick: (d) => d.flat(), chart: "histogram", per: 1 },
]
const SETS = { main: READERS, options: OPTIONS }

/** 5×7 dot-matrix digits for the latest value, top row first. */
const DIGITS: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
}

/** One color per parallel reader, spread around the color wheel. */
const hue = (i: number, n: number) => `hsl(${Math.round((i * 360) / n + 30) % 360} 70% 62%)`
/** Columns and rows of one parallel reader's tile, gaps included. */
const TILE = [15, 8] as const

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
export function HeroFlow({ pick = false, set = "main" }: { pick?: boolean; set?: keyof typeof SETS }) {
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
    const lineup = SETS[set]
    let values: number[] = []
    // What readers see: the series as of the last commit (points still in memory aren't readable yet).
    let committed: number[] = []
    let committedVersion = 0
    // What the reader shows: a snapshot of the committed data, its version, the load in progress (ticks left, and
    // whether it brings a new chart that draws in), ticks since the last load, and how far the chart has drawn in.
    let snapshot: number[] = []
    let snapshotVersion = 0
    let loading = 0
    let fresh = false
    let sinceLoad = 0
    let reveal = REVEAL
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
      const buckets = downsample(snapshot, r.per)
      // Scaled to the buckets' own range, so the shape fills the chart.
      const [lo, hi] = [Math.min(...buckets.map((b) => b.top)), Math.max(...buckets.map((b) => b.bottom))]
      const at = (v: number) => top + Math.round(((v - lo) / (hi - lo || 1)) * (bottom - top))
      const upTo = Math.ceil(width * done)
      // Each bucket's columns, for the charts drawn a bucket at a time.
      const step = width / buckets.length
      const span = (i: number) => [x + Math.round(i * step), x + Math.round((i + 1) * step) - 1] as const
      const shown = buckets.filter((_, i) => span(i)[0] - x <= upTo)
      if (r.chart === "latest") {
        // The newest value in big digits (each dot 2×2 squares), and whether it rose or fell.
        const last = snapshot.at(-1) ?? 0.5
        const before = snapshot.at(-6) ?? last
        const text = String(reading(last))
        const scale = 2
        const shownDigits = Math.ceil(text.length * done)
        ;[...text].slice(0, shownDigits).forEach((ch, k) =>
          (DIGITS[ch] ?? []).forEach((rowBits, ry) =>
            [...rowBits].forEach((bit, rx) => {
              if (bit !== "1") return
              for (let dx = 0; dx < scale; dx++)
                for (let dy = 0; dy < scale; dy++)
                  square(x + k * 6 * scale + rx * scale + dx, top + 4 + ry * scale + dy, reads, 1)
            }),
          ),
        )
        if (done >= 1) {
          const ax = x + text.length * 6 * scale + 3
          const up = last < before
          ;[
            [2, 0],
            [1, 1],
            [2, 1],
            [3, 1],
            [0, 2],
            [1, 2],
            [2, 2],
            [3, 2],
            [4, 2],
          ].forEach(([dx = 0, dy = 0]) => square(ax + dx, top + (up ? 8 + dy : 12 - dy), reads, 1))
          label(up ? "rising" : "falling", ax + 7, top + 12)
        }
        return
      }
      if (r.chart === "heatmap") {
        // Time across, then down a row: a cell per stretch of the series, brighter for higher values.
        const [across, down] = [Math.floor(width / 3), Math.floor((bottom - top) / 3)]
        const cells = stretch(snapshot, across * down)
        cells.slice(0, Math.ceil(cells.length * done)).forEach((v, i) => {
          const [cx, cy] = [x + (i % across) * 3, top + Math.floor(i / across) * 3]
          const strength = 1 - (v - lo) / (hi - lo || 1)
          for (const [dx, dy] of [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
          ] as const)
            square(cx + dx, cy + dy, reads, 0.1 + 0.9 * strength)
        })
        return
      }
      if (r.chart === "alerts") {
        // A threshold at the top quarter of the values; the line above it lit, each stretch an alert.
        const line = stretch(snapshot, width)
        const sorted = [...snapshot].toSorted((a, b) => a - b)
        const threshold = sorted[Math.floor(sorted.length * 0.25)] ?? 0.3
        for (let i = 0; i < width; i += 2) square(x + i, at(threshold), muted, 0.7)
        let [prev, alerts, above] = [null as number | null, 0, false]
        for (let i = 0; i < upTo; i++) {
          const v = line[i] ?? 0
          const y = at(v)
          const over = v < threshold
          if (over && !above) alerts++
          above = over
          const [a, b] = prev === null ? [y, y] : [Math.min(prev, y), Math.max(prev, y)]
          for (let cy = a; cy <= b; cy++) square(x + i, cy, reads, over ? 1 : 0.35)
          prev = y
        }
        label(`threshold ${reading(threshold)}`, x + width - 18, at(threshold) - 1)
        if (done >= 1) label(`${alerts} alert${alerts === 1 ? "" : "s"}`, x, top + 1, reads)
        return
      }
      if (r.chart === "histogram") {
        // How the values spread: a bar per range of readings, highest first, as long as its count.
        const bins = 8
        const counts = Array.from({ length: bins }, (_, b) => {
          const [from, to] = [lo + ((hi - lo) * b) / bins, lo + ((hi - lo) * (b + 1)) / bins]
          return snapshot.filter((v) => v >= from && (v < to || b === bins - 1)).length
        })
        const largest = Math.max(...counts)
        counts.forEach((n, b) => {
          const y = top + b * 3
          const length = Math.round(((width - 12) * n * done) / (largest || 1))
          label(String(reading(lo + ((hi - lo) * b) / bins)), x, y + 2)
          for (let i = 0; i < length; i++) for (const dy of [0, 1]) square(x + 6 + i, y + dy, reads, 0.85)
        })
        return
      }
      if (r.chart === "parallel") {
        // As many readers as fit, each in its own color, each reading its own stretch of the series.
        const [across, down] = [Math.floor(width / TILE[0]), Math.floor((bottom - top) / TILE[1])]
        const count = across * down
        const shownTiles = Math.ceil(count * done)
        label(`${count} readers`, x, top - 1)
        for (let t = 0; t < shownTiles; t++) {
          const [x0, y0] = [x + (t % across) * TILE[0], top + 1 + Math.floor(t / across) * TILE[1]]
          const [w, h] = [TILE[0] - 3, TILE[1] - 3]
          const from = (t * 7) % Math.max(1, snapshot.length - w)
          const slice = snapshot.slice(from, from + w)
          const [least, most] = [Math.min(...slice), Math.max(...slice)]
          slice.forEach((v, i) =>
            square(x0 + i, y0 + Math.round(((v - least) / (most - least || 1)) * h), hue(t, count), 1),
          )
        }
        return
      }
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
        committedVersion = writer.version
        if (snapshot.length === 0) [snapshot, snapshotVersion] = [committed, committedVersion]
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
      const turn = readers ? lineup[reader] : undefined
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
      // The options set keeps a last-value index beside memory, which the latest-value reader reads.
      if (set === "options") {
        const index = turn?.chart === "latest"
        label("index", storeX + 30, 8, index ? reads : muted)
        for (let dx = 0; dx < 6; dx++)
          for (const dy of [1, 2]) square(storeX + 30 + dx, 8 + dy, index ? reads : pen, index ? 1 : 0.35)
      }
      writer.days.forEach((list, d) => {
        const y = 20 + d * 8
        label(writer.partition(d), storeX, y)
        let x = storeX
        for (const f of list) {
          const width = widthOf(f)
          if (x + width > storeX + STORE) break
          // Many readers color each file with one of theirs; any other reader in the reading color.
          const many = turn?.chart === "parallel"
          const n = writer.days.flat().indexOf(f)
          const [fill, alpha] = read.has(f)
            ? [many ? hue(n * 5, 24) : reads, 1]
            : [pen, f === writer.fresh ? 0.9 : 0.35]
          for (let dx = 0; dx < width; dx++) for (const dy of [1, 2, 3]) square(x + dx, y + dy, fill, alpha)
          x += width + 1
        }
      })

      // The reader: who, what it asked, what it read, and its chart.
      if (turn) {
        const done = Math.min(1, reveal / REVEAL)
        // While a new chart loads there is nothing to show yet; a reload keeps the old one up.
        const show = !(loading > 0 && fresh)
        const files =
          turn.chart === "latest"
            ? `as of v${snapshotVersion} · reads the last-value index, 0 files`
            : `as of v${snapshotVersion} · reads ${read.size} of ${writer.days.flat().length} files`
        const bar = (x0: number, width: number, y: number) => {
          if (loading === 0) return
          const filled = Math.round(width * (1 - loading / LOAD))
          for (let i = 0; i < width; i++) square(x0 + i, y, reads, i < filled ? 1 : 0.15)
        }
        if (pick) {
          lineup.forEach((r, i) => {
            const y = listRow(i)
            const active = i === reader
            label(r.name, readersX, y, active ? reads : muted)
            if (active) for (let dx = 0; dx < LIST - 2; dx++) square(readersX + dx, y + 2, reads, 0.6)
          })
          label(`${turn.query} · ${files}`, readersX + LIST, rows - 2)
          bar(readersX + LIST, cols - readersX - LIST - 2, 2)
          if (show) chart(turn, readersX + LIST, cols - readersX - LIST - 2, 5, rows - 7, done)
        } else {
          label(turn.name, readersX, 4, reads)
          label(turn.query, readersX + Math.ceil(turn.name.length * 1.5) + 2, 4)
          label(files, readersX, rows - 2)
          bar(readersX, cols - readersX - 2, 6)
          if (show) chart(turn, readersX, cols - readersX - 2, 8, rows - 7, done)
        }
      }
      ctx.globalAlpha = 1
    }

    /** Starts loading a snapshot; `isFresh` when it is for another reader, whose chart then draws in. */
    const load = (isFresh: boolean) => {
      loading = LOAD
      fresh = isFresh
    }

    /** One tick: publish a point (it is written), and move the readers' loads and charts along. */
    const tick = () => {
      if (mode === "publish") {
        const last = values.at(-1) ?? 0.5
        const value = cursorY === null ? shape(next, values.length) : last + (cursorY - last) * FOLLOW
        values = [...values.slice(1), value]
        next++
        if (writer.write()) [committed, committedVersion] = [[...values], writer.version]
      }
      if (!pick) {
        // Readers take turns, and the one on screen reloads every few seconds.
        if (++phase > CYCLE) {
          phase = 0
          reader = (reader + 1) % lineup.length
          load(true)
        } else if (++sinceLoad >= RELOAD && loading === 0) load(false)
      }
      if (loading > 0 && --loading === 0) {
        ;[snapshot, snapshotVersion, sinceLoad] = [[...committed], committedVersion, 0]
        if (fresh) reveal = 0
      } else if (loading === 0 && reveal < REVEAL) reveal++
      draw()
      // With `pick`, nothing needs ticks once the chart is loaded and drawn, until the cursor does something.
      if (pick && mode !== "publish" && loading === 0 && reveal >= REVEAL) stop()
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
        const i = lineup.findIndex((_, k) => Math.abs(y - (listRow(k) - 1)) <= 3)
        if (i >= 0) {
          // Another reader, or new data since the last load: load a snapshot, then draw it in.
          mode = "read"
          if (i !== reader || (loading === 0 && committedVersion !== snapshotVersion)) {
            reader = i
            load(true)
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
  }, [pick, set])

  return <canvas ref={canvas} aria-hidden className="absolute inset-0 h-full w-full" />
}
