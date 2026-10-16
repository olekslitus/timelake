"use client"

import { useEffect, useRef } from "react"

/** The picture each use case draws, in squares. */
export type ArtKind = "sensors" | "fleet" | "robot" | "market" | "metrics" | "ml" | "functions" | "agents"

const COLS = 64
const ROWS = 14
const DOT = 3
const CELL = 4
/** Milliseconds to draw the picture in, left to right. */
const REVEAL_MS = 1100

type Cell = { x: number; y: number; color: string; alpha: number }

/** A small seeded random generator (mulberry32), so every visit draws the same picture. */
function seeded(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const row = (v: number) => Math.max(0, Math.min(ROWS - 1, Math.round(v)))

/** A line through one value per column, joined vertically so steep steps stay connected. */
function line(values: number[], color: string, alpha = 1): Cell[] {
  const cells: Cell[] = []
  values.forEach((v, x) => {
    const y = row(v)
    const prev = x > 0 ? row(values[x - 1] ?? v) : y
    for (let r = Math.min(prev, y); r <= Math.max(prev, y); r++) cells.push({ x, y: r, color, alpha })
  })
  return cells
}

const PICTURES: Record<ArtKind, () => Cell[]> = {
  sensors: () => {
    const rnd = seeded(1)
    return [0, 1, 2].flatMap((k) =>
      line(
        Array.from({ length: COLS }, (_, x) => 3 + k * 4 + Math.sin(x / 7 + k * 1.7) * 1.6 + (rnd() - 0.5)),
        k === 1 ? "var(--primary)" : "var(--muted-foreground)",
        k === 1 ? 1 : 0.6,
      ),
    )
  },
  fleet: () => {
    const rnd = seeded(2)
    let y = 7
    const route = Array.from(
      { length: COLS },
      () => (y = Math.max(2, Math.min(11, y + (rnd() < 0.3 ? (rnd() < 0.5 ? -1 : 1) : 0)))),
    )
    const stops = route.flatMap((v, x) =>
      x % 12 === 6
        ? [-1, 0, 1].flatMap((dx) =>
            [-1, 0, 1].map((dy) => ({ x: x + dx, y: row(v + dy), color: "var(--primary)", alpha: 1 })),
          )
        : [],
    )
    return [...line(route, "var(--muted-foreground)", 0.6), ...stops]
  },
  robot: () => [
    ...line(
      Array.from({ length: COLS }, (_, x) => 6.5 + Math.sin(x / 5) * 4.5),
      "var(--primary)",
    ),
    ...line(
      Array.from({ length: COLS }, (_, x) => 6.5 + Math.sin(x / 5 + 2.2) * 3),
      "var(--chart-4)",
      0.8,
    ),
  ],
  market: () => {
    const rnd = seeded(4)
    let price = 7
    const cells: Cell[] = []
    for (let x = 1; x < COLS - 2; x += 4) {
      const open = price
      price = Math.max(2, Math.min(11, price + (rnd() - 0.48) * 4))
      const [top, bottom] = [Math.min(open, price), Math.max(open, price)]
      const color = price <= open ? "var(--chart-3)" : "var(--chart-5)"
      for (let r = row(top - 1 - rnd() * 1.5); r <= row(bottom + 1 + rnd() * 1.5); r++)
        cells.push({ x: x + 1, y: r, color, alpha: 0.6 })
      for (let r = row(top); r <= row(bottom); r++)
        for (const dx of [0, 1, 2]) cells.push({ x: x + dx, y: r, color, alpha: 1 })
    }
    return cells
  },
  metrics: () => {
    const rnd = seeded(5)
    const cells: Cell[] = []
    for (let y = 1; y < ROWS - 1; y++) {
      let load = rnd()
      for (let x = 0; x < COLS; x++) {
        load = Math.max(0, Math.min(1, load + (rnd() - 0.5) * 0.25))
        if (load > 0.35) cells.push({ x, y, color: "var(--primary)", alpha: (load - 0.35) * 1.5 })
      }
    }
    return cells
  },
  ml: () => {
    const rnd = seeded(6)
    const gauss = () => (rnd() + rnd() + rnd() - 1.5) * 2
    return [
      [14, 4, "var(--primary)"],
      [34, 9, "var(--chart-3)"],
      [52, 5, "var(--chart-4)"],
    ].flatMap(([cx, cy, color]) =>
      Array.from({ length: 34 }, () => ({
        x: Math.round(Number(cx) + gauss() * 3),
        y: row(Number(cy) + gauss()),
        color: String(color),
        alpha: 0.9,
      })),
    )
  },
  functions: () => {
    const rnd = seeded(7)
    const cells: Cell[] = []
    for (let y = 1; y < ROWS - 1; y += 2) {
      for (let x = Math.floor(rnd() * 6); x < COLS;) {
        const length = 2 + Math.floor(rnd() * 7)
        for (let dx = 0; dx < length && x + dx < COLS; dx++)
          cells.push({ x: x + dx, y, color: "var(--primary)", alpha: 0.85 })
        x += length + 2 + Math.floor(rnd() * 10)
      }
    }
    return cells
  },
  agents: () => {
    const rnd = seeded(8)
    const cells: Cell[] = []
    for (let y = 0; y < ROWS; y++)
      for (let x = 0; x < COLS; x++)
        if (rnd() < 0.14) cells.push({ x, y, color: "var(--primary)", alpha: 0.4 + rnd() * 0.6 })
    return cells
  },
}

/** "var(--chart-3)" → its color here. */
function resolve(el: Element, color: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(color)
  return m?.[1] ? getComputedStyle(el).getPropertyValue(m[1]).trim() : color
}

/**
 * A use case's picture in squares on a dim grid. It draws itself in once, left to right, when it comes into view,
 * and again when the card is hovered; otherwise it stays still.
 */
export function UseCaseArt({ kind }: { kind: ArtKind }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const c = canvas.current
    const ctx = c?.getContext("2d")
    if (!c || !ctx) return
    const dpr = window.devicePixelRatio || 1
    c.width = COLS * CELL * dpr
    c.height = ROWS * CELL * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const cells = PICTURES[kind]().filter((p) => p.x >= 0 && p.x < COLS && p.y >= 0 && p.y < ROWS)
    const colors = new Map(cells.map((p) => [p.color, resolve(c, p.color)]))
    const paper = resolve(c, "var(--border)")

    const draw = (upTo: number) => {
      ctx.clearRect(0, 0, COLS * CELL, ROWS * CELL)
      ctx.globalAlpha = 0.6
      ctx.fillStyle = paper
      for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) ctx.fillRect(x * CELL, y * CELL, DOT, DOT)
      for (const p of cells) {
        if (p.x > upTo) continue
        ctx.globalAlpha = p.alpha
        ctx.fillStyle = colors.get(p.color) ?? paper
        ctx.fillRect(p.x * CELL, p.y * CELL, DOT, DOT)
      }
      ctx.globalAlpha = 1
    }

    let frame = 0
    const play = () => {
      cancelAnimationFrame(frame)
      const start = performance.now()
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / REVEAL_MS)
        draw(t * COLS)
        if (t < 1) frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
    }

    draw(-1)
    const seen = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting) {
        play()
        seen.disconnect()
      }
    })
    seen.observe(c)
    const card = c.closest("[data-use-case]")
    card?.addEventListener("pointerenter", play)
    return () => {
      cancelAnimationFrame(frame)
      seen.disconnect()
      card?.removeEventListener("pointerenter", play)
    }
  }, [kind])

  return <canvas ref={canvas} aria-hidden className="block h-auto w-full max-w-[256px]" />
}
