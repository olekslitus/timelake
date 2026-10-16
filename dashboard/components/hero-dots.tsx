"use client"

import { useEffect, useRef } from "react"

const DOT = 3
const CELL = 4
/** Milliseconds to draw the series in, left to right. */
const REVEAL_MS = 1600
/** Milliseconds per new point while hovered. */
const TICK_MS = 55
/** How far each new point moves toward the cursor (0..1). */
const FOLLOW = 0.45
/** Rows kept clear above and below the chart, so the bounds' labels always fit. */
const PAD = 5

/** The writer's area on the left, in columns, and the gap before the chart. */
const WRITER = 40
/** Columns between the strip's left edge and the writer's contents. */
const INSET = 3
const GAP = 3
/** The readers' area on the right, in columns (the "readers" variant). */
const READERS_W = 34
/** Points buffered in memory before a commit writes them as a file. */
const BATCH = 8
/** Files of one size that the writer merges into one four times bigger (size-tiered compaction). */
const TIER = 4
/** Commits in a day; then the day's files become one sorted file. */
const DAY = 32
/** Days kept; older ones are dropped by retention. */
const DAYS = ["today", "yesterday", "2 days"]
/** The first "today", for partition names. */
const FIRST_DAY = Date.UTC(2026, 9, 16)
/** Ticks between two readers' queries while hovered. */
const QUERY_TICKS = 40

/** A file's size, in commits' worth of points; a day's single sorted file is `sorted`. */
type File = { size: number; sorted?: boolean }

/** Who reads the table, and what each query reads: the files it picks from the days (today first). */
const READERS = ["DuckDB", "Spark", "Browser", "AI agent"]
const QUERIES: { reader: string; text: string; pick: (days: File[][]) => File[] }[] = [
  { reader: "Browser", text: "last 10 minutes", pick: (d) => (d[0] ?? []).slice(-1) },
  { reader: "DuckDB", text: "avg, last hour", pick: (d) => (d[0] ?? []).slice(-2) },
  { reader: "AI agent", text: "yesterday's peak", pick: (d) => d[1] ?? [] },
  { reader: "Spark", text: "daily max, 3 days", pick: (d) => d.flat() },
  { reader: "DuckDB", text: "today, by sensor", pick: (d) => d[0] ?? [] },
]

export type HeroVariant = "writer" | "readers" | "lake"

/** The series' shape when nobody is hovering: height (0..1, 0 at the top) at column x of `cols`. */
const shape = (x: number, cols: number) => 0.5 + Math.sin((x / cols) * 6 + 1) * 0.3 + Math.sin((x / cols) * 23) * 0.06

/** A reading for a height, for the bound labels: 0 at the bottom, 100 at the top. */
const reading = (v: number) => Math.round((1 - v) * 100)

/** Columns a file takes: bigger tiers are wider, a day's sorted file widest. */
const widthOf = (f: File) => (f.sorted ? 18 : f.size >= TIER * TIER ? 10 : f.size >= TIER ? 4 : 2)

/**
 * Merges TIER files of one size into one file TIER times bigger, from the smallest size up. A merge only makes a
 * bigger file, so one pass upward catches every cascade.
 */
function compact(files: File[]): { files: File[]; merged: boolean } {
  let merged = false
  for (let size = 1; files.some((f) => !f.sorted && f.size >= size); size *= TIER) {
    const group = files.filter((f) => !f.sorted && f.size === size).slice(0, TIER)
    if (group.length < TIER) continue
    const at = files.indexOf(group[0] as File)
    files = files.filter((f) => !group.includes(f))
    files.splice(at, 0, { size: size * TIER })
    merged = true
  }
  return { files, merged }
}

/**
 * The hero's chart in squares: one series, with dashed lines at the highest and lowest values on screen, and on the
 * left the writer that stores it. While hovered it is a live feed: the chart scrolls, each new point arrives at the
 * cursor's height and goes into an in-memory batch; a full batch is committed as a small file in today's partition;
 * four files of one size merge into one four times bigger; at the end of a day its files become one sorted file, and
 * the oldest day is dropped. When the cursor leaves, everything stops.
 *
 * `readers` adds the bucket path, partition names and readers on the right whose queries light up only the files they
 * read. `lake` draws the writer as water: new files sink from the surface into today's layer, older days lie deeper.
 */
export function HeroDots({ variant = "writer" }: { variant?: HeroVariant }) {
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
    // The writer: points in memory, the table version, the last thing it did, and each day's files (today first).
    let buffered = 3
    let version = 41
    let commitsToday = 9
    let event = "commit"
    let fresh: File | null = null
    let days: File[][] = [
      [{ size: 4 }, { size: 4 }, { size: 1 }],
      [{ size: DAY, sorted: true }],
      [{ size: DAY, sorted: true }],
    ]
    // Days rolled over so far (for partition names), the readers' current query, and how far a new file still sinks.
    let rolled = 0
    let query = 1
    let ticks = 0
    let sink = 0

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
    const label = (text: string, x: number, y: number, fill = muted) => {
      ctx.globalAlpha = 0.9
      ctx.fillStyle = fill
      ctx.font = `9px ${font}`
      ctx.fillText(text, x * CELL, y * CELL)
    }
    const partition = (d: number) =>
      `time_day=${new Date(FIRST_DAY + (rolled - d) * 86_400_000).toISOString().slice(5, 10)}`

    /** A row of files, left to right; `alphaOf` says how bright each is, `lift` how far the newest still floats. */
    const files = (list: File[], y: number, alphaOf: (f: File) => number, lift = () => 0) => {
      let x = INSET
      for (const f of list) {
        const width = widthOf(f)
        if (x + width > WRITER) break
        const up = f === fresh ? lift() : 0
        for (let dx = 0; dx < width; dx++) for (const dy of [1, 2, 3]) square(x + dx, y + dy - up, pen, alphaOf(f))
        x += width + 1
      }
    }
    const batch = (y: number) => {
      label(`memory ${buffered}/${BATCH}`, INSET, y)
      for (let i = 0; i < BATCH; i++)
        for (const [dx, dy] of [
          [0, 1],
          [1, 1],
          [0, 2],
          [1, 2],
        ] as const)
          square(INSET + i * 3 + dx, y + dy, pen, i < buffered ? 1 : 0.15)
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
      const left = WRITER + GAP
      const right = variant === "readers" ? cols - READERS_W - GAP : cols
      const chartCols = Math.max(1, right - left)
      fit(chartCols)

      // The paper, and the edges around the chart.
      for (let x = 0; x < cols; x++) for (let y = 0; y < rows; y++) square(x, y, paper, 0.55)
      for (let y = 0; y < rows; y += 2) square(WRITER + 1, y, muted, 0.35)
      if (variant === "readers") for (let y = 0; y < rows; y += 2) square(right + 1, y, muted, 0.35)

      if (variant === "writer") {
        const top = Math.max(4, Math.floor((rows - 40) / 2))
        batch(top)
        label(`v${version} ${event}`, INSET, top + 8, pen)
        days.forEach((list, d) => {
          const y = top + 14 + d * 9
          label(DAYS[d] ?? "", INSET, y)
          files(list, y, (f) => (f === fresh ? 1 : f.sorted ? 0.4 : 0.7))
        })
      } else if (variant === "readers") {
        // The bucket, its partitions, and which files the current query reads.
        const q = QUERIES[query % QUERIES.length]
        const read = new Set(q?.pick(days) ?? [])
        label("s3://lake/iot/readings", INSET, 4, pen)
        batch(8)
        label(`v${version} ${event}`, INSET, 15, pen)
        days.forEach((list, d) => {
          const y = 20 + d * 8
          label(partition(d), INSET, y)
          files(list, y, (f) => (read.has(f) ? 1 : 0.18))
        })
        // The readers, the query, and how much of the table it read.
        const x0 = right + 4
        label("readers", x0, 4)
        READERS.forEach((name, i) => {
          const y = 9 + i * 4
          const active = q?.reader === name
          for (const [dx, dy] of [
            [0, -2],
            [1, -2],
            [0, -1],
            [1, -1],
          ] as const)
            square(x0 + dx, y + dy, pen, active ? 1 : 0.25)
          label(name, x0 + 4, y, active ? pen : muted)
        })
        const total = days.flat().length
        label(q?.text ?? "", x0, 29, pen)
        label(`reads ${read.size} of ${total} files`, x0, 33)
      } else {
        // The lake: points in memory above the surface, then water that deepens, with each day a layer.
        batch(3)
        const surface = 8
        for (let y = surface + 1; y < rows; y++)
          for (let x = 0; x <= WRITER; x++) square(x, y, pen, 0.03 + (0.1 * (y - surface)) / (rows - surface))
        for (let x = 0; x <= WRITER; x += 2) square(x, surface, pen, 0.7)
        label(`v${version} ${event}`, INSET, 12, pen)
        days.forEach((list, d) => {
          const y = 17 + d * 8
          label(DAYS[d] ?? "", INSET, y)
          files(
            list,
            y,
            (f) => (f === fresh ? 1 : f.sorted ? 0.45 + d * 0.15 : 0.7),
            () => Math.min(sink, y - surface),
          )
        })
      }

      // The series and its bounds, inside the padding.
      const upTo = progress * chartCols
      const shown = values.slice(0, Math.max(1, Math.ceil(upTo)))
      const rowOf = (v: number) => PAD + Math.round(Math.max(0, Math.min(1, v)) * (rows - 1 - 2 * PAD))
      const [hi, lo] = [Math.min(...shown), Math.max(...shown)]
      for (const [v, name] of [
        [hi, "max"],
        [lo, "min"],
      ] as const) {
        const y = rowOf(v)
        for (let x = left; x < right; x += 2) square(x, y, muted, 0.6)
        label(`${name} ${reading(v)}`, right - 12, name === "max" ? y - 1 : y + 4)
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

    /** What the writer does with one new point. */
    const write = () => {
      if (++buffered < BATCH) return
      buffered = 0
      version++
      fresh = { size: 1 }
      sink = 20
      const today = [...(days[0] ?? []), fresh]
      const { files: compacted, merged } = compact(today)
      if (merged) fresh = compacted.find((f) => !today.includes(f)) ?? null
      event = merged ? "merge" : "commit"
      days = [compacted, ...days.slice(1)]
      if (++commitsToday === DAY) {
        // The day is over: its files become one sorted file, a new day starts, and the oldest is dropped.
        commitsToday = 0
        version++
        rolled++
        event = "sorted"
        fresh = { size: DAY, sorted: true }
        days = [[], [fresh], ...days.slice(1)].slice(0, DAYS.length)
      }
    }

    /** One new point: the chart moves left, the point arrives at the cursor's height, and the writer takes it. */
    const publish = () => {
      const last = values.at(-1) ?? 0.5
      const value = cursorY === null ? shape(next, values.length) : last + (cursorY - last) * FOLLOW
      values = [...values.slice(1), value]
      next++
      sink = Math.max(0, sink - 3)
      if (++ticks % QUERY_TICKS === 0) query++
      write()
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

    // While hovered, publish a point every tick; stop when the cursor leaves.
    let timer: ReturnType<typeof setInterval> | null = null
    const move = (e: PointerEvent) => {
      const r = c.getBoundingClientRect()
      const rows = Math.floor(r.height / CELL)
      // The cursor's height within the chart's padded area, 0..1.
      cursorY = Math.max(0, Math.min(1, ((e.clientY - r.top) / CELL - PAD) / (rows - 1 - 2 * PAD)))
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
  }, [variant])

  return <canvas ref={canvas} aria-hidden className="absolute inset-0 h-full w-full" />
}
