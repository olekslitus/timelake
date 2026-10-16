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
/** Points buffered in memory before a commit writes them as a file. */
const BATCH = 8
/** Files of one size that the writer merges into one four times bigger (size-tiered compaction). */
const TIER = 4
/** Commits in a day; then the day's files become one sorted file. */
const DAY = 32
/** Days kept; older ones are dropped by retention. */
const DAYS = ["today", "yesterday", "2 days"]

/** A file's size, in commits' worth of points; a day's single sorted file is `sorted`. */
type File = { size: number; sorted?: boolean }

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
      const chartCols = Math.max(1, cols - left)
      fit(chartCols)

      // The paper, and the edge between the writer and the chart.
      for (let x = 0; x < cols; x++) for (let y = 0; y < rows; y++) square(x, y, paper, 0.55)
      for (let y = 0; y < rows; y += 2) square(WRITER + 1, y, muted, 0.35)

      // The writer: the batch in memory, the last commit, then each day's files.
      const top = Math.max(4, Math.floor((rows - 40) / 2))
      label(`memory ${buffered}/${BATCH}`, INSET, top)
      for (let i = 0; i < BATCH; i++)
        for (const [dx, dy] of [
          [0, 1],
          [1, 1],
          [0, 2],
          [1, 2],
        ] as const)
          square(INSET + i * 3 + dx, top + dy, pen, i < buffered ? 1 : 0.15)
      label(`v${version} ${event}`, INSET, top + 8, pen)
      days.forEach((files, d) => {
        const y = top + 14 + d * 9
        label(DAYS[d] ?? "", INSET, y)
        let x = INSET
        for (const f of files) {
          const width = widthOf(f)
          if (x + width > WRITER) break
          const alpha = f === fresh ? 1 : f.sorted ? 0.4 : 0.7
          for (let dx = 0; dx < width; dx++) for (const dy of [1, 2, 3]) square(x + dx, y + dy, pen, alpha)
          x += width + 1
        }
      })

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

    /** What the writer does with one new point. */
    const write = () => {
      if (++buffered < BATCH) return
      buffered = 0
      version++
      fresh = { size: 1 }
      const today = [...(days[0] ?? []), fresh]
      const { files, merged } = compact(today)
      if (merged) fresh = files.find((f) => !today.includes(f)) ?? null
      event = merged ? "merge" : "commit"
      days = [files, ...days.slice(1)]
      if (++commitsToday === DAY) {
        // The day is over: its files become one sorted file, a new day starts, and the oldest is dropped.
        commitsToday = 0
        version++
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
  }, [])

  return <canvas ref={canvas} aria-hidden className="absolute inset-0 h-full w-full" />
}
