"use client"

import { useEffect, useRef } from "react"

import { BATCH, type File, Writer, widthOf } from "@/components/hero-writer"

const DOT = 3
const CELL = 4
/** Milliseconds per tick while hovered: one new point, and every animation moves one step. */
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
/** Ticks one reader takes: files light up, data streams across, then its result is drawn. */
const CYCLE = 60
const STREAM = [6, 30] as const
const RESULT = 30

/** A reader, its query, the files that query reads (days are today first), and what it shows. */
type Reader = {
  name: string
  query: string
  pick: (days: File[][]) => File[]
  result: "chart" | "avg" | "bars" | "answer"
}
const READERS: Reader[] = [
  { name: "Browser", query: "last 10 minutes", pick: (d) => (d[0] ?? []).slice(-1), result: "chart" },
  { name: "DuckDB", query: "avg, last hour", pick: (d) => (d[0] ?? []).slice(-2), result: "avg" },
  { name: "Spark", query: "daily max, 3 days", pick: (d) => d.flat(), result: "bars" },
  { name: "AI agent", query: "when was the peak?", pick: (d) => d[0] ?? [], result: "answer" },
]

/** The series' shape when nobody is hovering: height (0..1, 0 at the top) at column x of `cols`. */
const shape = (x: number, cols: number) => 0.5 + Math.sin((x / cols) * 6 + 1) * 0.3 + Math.sin((x / cols) * 23) * 0.06
/** A reading for a height: 0 at the bottom, 100 at the top. */
const reading = (v: number) => Math.round((1 - v) * 100)

type Point = { x: number; y: number }
/** A square on its way from one place to another; `t` goes from 0 to 1. */
type Flight = { from: Point; to: Point; t: number; speed: number }

/**
 * The hero as a pipeline, left to right: you publish points with the cursor, they are written to the object store
 * (batched in memory, committed as files in day partitions, compacted), and readers take turns: the files a reader's
 * query needs light up, their data streams across, and the reader shows its result. Everything moves only while the
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
    // Squares in flight: points into the store, and data out to the reader.
    let flights: Flight[] = []
    // The current reader, and how far into its turn (a finished turn when idle).
    let reader = 0
    let phase = CYCLE
    // Where things are on screen, from the last draw.
    let layout = { chartEnd: 0, storeX: 0, readersX: 0, rows: 0, readers: false }
    const filePos = new Map<File, Point>()

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
      layout = { chartEnd, storeX, readersX: storeX + STORE + GAP, rows, readers }
      const chartCols = chartEnd - 1
      if (values.length !== chartCols) {
        const kept = values.slice(-chartCols)
        next = chartCols
        values = [...Array.from({ length: chartCols - kept.length }, (_, x) => shape(x, chartCols)), ...kept]
      }

      for (let x = 0; x < cols; x++) for (let y = 0; y < rows; y++) square(x, y, paper, 0.55)
      for (const edge of readers ? [storeX - 3, layout.readersX - 3] : [storeX - 3])
        for (let y = 0; y < rows; y += 2) square(edge, y, muted, 0.35)

      // The chart and its bounds.
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
      const turn = READERS[reader]
      const read = new Set(layout.readers && turn ? pickFiles(turn) : [])
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
      filePos.clear()
      writer.days.forEach((list, d) => {
        const y = 20 + d * 8
        label(writer.partition(d), storeX, y)
        let x = storeX
        for (const f of list) {
          const width = widthOf(f)
          if (x + width > storeX + STORE) break
          const lit = read.size === 0 ? (f === writer.fresh ? 1 : f.sorted ? 0.4 : 0.7) : read.has(f) ? 1 : 0.18
          for (let dx = 0; dx < width; dx++) for (const dy of [1, 2, 3]) square(x + dx, y + dy, pen, lit)
          filePos.set(f, { x: x + width / 2, y: y + 2 })
          x += width + 1
        }
      })

      // The reader: who, what, and its result once the data has arrived.
      if (readers && turn) {
        const rx = layout.readersX
        const width = cols - rx - 2
        label("readers", rx, 4)
        label(turn.name, rx, 9, pen)
        label(turn.query, rx, 13)
        const done = Math.max(0, Math.min(1, (phase - RESULT) / 15))
        if (done > 0) result(turn, rx, width, done)
      }

      // Squares in flight.
      for (const f of flights)
        square(
          Math.round(f.from.x + (f.to.x - f.from.x) * f.t),
          Math.round(f.from.y + (f.to.y - f.from.y) * f.t),
          pen,
          1,
        )
      ctx.globalAlpha = 1
    }

    /** The files a reader's query reads, or yesterday's if today has none yet. */
    const pickFiles = (r: Reader) => {
      const files = r.pick(writer.days)
      return files.length > 0 ? files : (writer.days[1] ?? [])
    }

    /** A reader's result, drawn `done` (0..1) of the way. */
    const result = (r: Reader, x: number, width: number, done: number) => {
      const [top, bottom] = [18, layout.rows - 5]
      if (r.result === "chart") {
        const recent = values.slice(-width)
        const [lo, hi] = [Math.min(...recent), Math.max(...recent)]
        recent.slice(0, Math.ceil(recent.length * done)).forEach((v, i) => {
          const y = top + Math.round(((v - lo) / (hi - lo || 1)) * (bottom - top))
          square(x + i, y, pen, 1)
        })
      } else if (r.result === "avg") {
        const recent = values.slice(-60)
        const avg = recent.reduce((s, v) => s + v, 0) / recent.length
        label(`avg ${reading(avg)}`, x, top + 4, pen)
        label(`over ${recent.length} points`, x, top + 8)
        for (let i = 0; i < Math.round(20 * done); i++) square(x + i, top + 11, pen, 0.8)
      } else if (r.result === "bars") {
        const maxima = [reading(Math.min(...values)), 71, 66]
        maxima.forEach((m, i) => {
          const height = Math.round(((bottom - top) * m * done) / 100)
          for (let dx = 0; dx < 4; dx++)
            for (let dy = 0; dy < height; dy++) square(x + i * 7 + dx, bottom - dy, pen, 0.8)
          label(writer.partition(i).slice(-2), x + i * 7, bottom + 4)
        })
      } else {
        const at = values.indexOf(Math.min(...values))
        const ago = Math.max(1, Math.round(((values.length - 1 - at) * TICK_MS) / 1000))
        label(`peak ${reading(Math.min(...values))}`, x, top + 4, pen)
        if (done > 0.5) label(`${ago} s ago`, x, top + 8)
      }
    }

    /** One tick: a new point arrives at the cursor's height and flies to the store, and the reader moves on. */
    const tick = () => {
      const last = values.at(-1) ?? 0.5
      const value = cursorY === null ? shape(next, values.length) : last + (cursorY - last) * FOLLOW
      values = [...values.slice(1), value]
      next++
      flights.push({
        from: { x: layout.chartEnd, y: rowOf(value) },
        to: { x: layout.storeX + writer.buffered * 3, y: 9 },
        t: 0,
        speed: 0.25,
      })
      writer.write()

      if (layout.readers) {
        if (++phase > CYCLE) {
          phase = 0
          reader = (reader + 1) % READERS.length
        }
        const turn = READERS[reader]
        const sources = turn ? pickFiles(turn).flatMap((f) => filePos.get(f) ?? []) : []
        if (phase >= STREAM[0] && phase <= STREAM[1] && sources.length > 0) {
          const from = sources[phase % sources.length] as Point
          flights.push({ from, to: { x: layout.readersX, y: 12 }, t: 0, speed: 0.18 })
        }
      }
      flights = flights.map((f) => ({ ...f, t: f.t + f.speed })).filter((f) => f.t < 1)
      draw()
    }

    draw()
    let timer: ReturnType<typeof setInterval> | null = null
    const move = (e: PointerEvent) => {
      const r = c.getBoundingClientRect()
      const rows = Math.floor(r.height / CELL)
      cursorY = Math.max(0, Math.min(1, ((e.clientY - r.top) / CELL - PAD) / (rows - 1 - 2 * PAD)))
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
