"use client"

import { useEffect, useRef } from "react"

import { BATCH, type File, Writer, widthOf } from "@/components/hero-writer"

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
/** Day labels for the plain variant, today first. */
const DAYS = ["today", "yesterday", "2 days"]
/** Ticks between two readers' queries while hovered. */
const QUERY_TICKS = 40

/** Who reads the table, and what each query reads: the files it picks from the days (today first). */
const READERS = ["DuckDB", "Spark", "Browser", "AI agent"]
const QUERIES: { reader: string; text: string; pick: (days: File[][]) => File[] }[] = [
  { reader: "Browser", text: "last 10 minutes", pick: (d) => (d[0] ?? []).slice(-1) },
  { reader: "DuckDB", text: "avg, last hour", pick: (d) => (d[0] ?? []).slice(-2) },
  { reader: "AI agent", text: "yesterday's peak", pick: (d) => d[1] ?? [] },
  { reader: "Spark", text: "daily max, 3 days", pick: (d) => d.flat() },
  { reader: "DuckDB", text: "today, by sensor", pick: (d) => d[0] ?? [] },
]

export type HeroVariant = "writer" | "readers"

/** The series' shape when nobody is hovering: height (0..1, 0 at the top) at column x of `cols`. */
const shape = (x: number, cols: number) => 0.5 + Math.sin((x / cols) * 6 + 1) * 0.3 + Math.sin((x / cols) * 23) * 0.06

/** A reading for a height, for the bound labels: 0 at the bottom, 100 at the top. */
const reading = (v: number) => Math.round((1 - v) * 100)

/**
 * The hero's chart in squares: one series, with dashed lines at the highest and lowest values on screen, and on the
 * left the writer that stores it. While hovered it is a live feed: the chart scrolls, each new point arrives at the
 * cursor's height and goes to the writer (see hero-writer). When the cursor leaves, everything stops.
 *
 * `readers` adds the bucket path, partition names and readers on the right whose queries light up only the files they
 * read.
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

    const writer = new Writer()
    let progress = 0
    // The series, one value per chart column, newest last; `next` is where its shape continues from.
    let values: number[] = []
    let next = 0
    let cursorY: number | null = null
    // The readers' current query.
    let query = 1
    let ticks = 0

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

    /** A row of files, left to right; `alphaOf` says how bright each is. */
    const files = (list: File[], y: number, alphaOf: (f: File) => number) => {
      let x = INSET
      for (const f of list) {
        const width = widthOf(f)
        if (x + width > WRITER) break
        for (let dx = 0; dx < width; dx++) for (const dy of [1, 2, 3]) square(x + dx, y + dy, pen, alphaOf(f))
        x += width + 1
      }
    }
    const batch = (y: number) => {
      label(`memory ${writer.buffered}/${BATCH}`, INSET, y)
      for (let i = 0; i < BATCH; i++)
        for (const [dx, dy] of [
          [0, 1],
          [1, 1],
          [0, 2],
          [1, 2],
        ] as const)
          square(INSET + i * 3 + dx, y + dy, pen, i < writer.buffered ? 1 : 0.15)
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
        label(`v${writer.version} ${writer.event}`, INSET, top + 8, pen)
        writer.days.forEach((list, d) => {
          const y = top + 14 + d * 9
          label(DAYS[d] ?? "", INSET, y)
          files(list, y, (f) => (f === writer.fresh ? 1 : f.sorted ? 0.4 : 0.7))
        })
      } else {
        // The bucket, its partitions, and which files the current query reads.
        const q = QUERIES[query % QUERIES.length]
        const read = new Set(q?.pick(writer.days) ?? [])
        label("s3://lake/iot/readings", INSET, 4, pen)
        batch(8)
        label(`v${writer.version} ${writer.event}`, INSET, 15, pen)
        writer.days.forEach((list, d) => {
          const y = 20 + d * 8
          label(writer.partition(d), INSET, y)
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
        label(q?.text ?? "", x0, 29, pen)
        label(`reads ${read.size} of ${writer.days.flat().length} files`, x0, 33)
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

    /** One new point: the chart moves left, the point arrives at the cursor's height, and the writer takes it. */
    const publish = () => {
      const last = values.at(-1) ?? 0.5
      const value = cursorY === null ? shape(next, values.length) : last + (cursorY - last) * FOLLOW
      values = [...values.slice(1), value]
      next++
      if (++ticks % QUERY_TICKS === 0) query++
      writer.write()
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
