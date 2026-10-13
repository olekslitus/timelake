// Generates the Timelake mark: parallel lines with sharp (mitered) turns, clipped to a circle.
//   bun brand/marks.mjs            writes brand/logo/*.svg
// Coordinates are a 100×100 box; y grows downward.
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

// The pulse: flat, a sharp rise, a deeper fall, back to flat. v0 uses it as drawn; the parallel
// versions use a lower pulse, because offsetting grows the spike on the outer lines.
const PULSE = [[-6, 0], [30, 0], [43, -14], [67, 12], [78, 0], [106, 0]]
const PULSE_LOW = [[-6, 0], [32, 0], [42, -10], [60, 8], [68, 0], [106, 0]]

// Offsets a polyline along its normal by d (positive = down for a rightward line), with miter joins.
// Segments that would reverse direction on the inner side of a sharp turn are dropped, the way a
// real parallel curve loses detail inside a tight corner.
export function offsetPolyline(pts, d) {
  let segs = []
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1]
    const len = Math.hypot(x2 - x1, y2 - y1)
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len
    const nx = -uy, ny = ux
    segs.push({ ux, uy, a: [x1 + nx * d, y1 + ny * d], b: [x2 + nx * d, y2 + ny * d] })
  }
  const meet = (s, t) => {
    // Intersection of the infinite lines through s and t.
    const det = s.ux * t.uy - s.uy * t.ux
    if (Math.abs(det) < 1e-9) return s.b
    const k = ((t.a[0] - s.a[0]) * t.uy - (t.a[1] - s.a[1]) * t.ux) / det
    return [s.a[0] + s.ux * k, s.a[1] + s.uy * k]
  }
  for (;;) {
    const out = [segs[0].a]
    for (let i = 0; i + 1 < segs.length; i++) out.push(meet(segs[i], segs[i + 1]))
    out.push(segs.at(-1).b)
    // A segment whose offset runs backwards has collapsed; drop it and retry.
    const bad = segs.findIndex((s, i) => (out[i + 1][0] - out[i][0]) * s.ux + (out[i + 1][1] - out[i][1]) * s.uy <= 0)
    if (bad < 0) return out
    segs = segs.filter((_, i) => i !== bad)
  }
}

export const MARKS = {
  // v0: lines are vertical copies of one pulse. Spacing tightens on the slopes.
  "v0": { lines: 5, gap: 13, width: 4.8, mode: "translate", center: 52 },
  // v0.1: true parallel lines, so the gap measured across the lines is the same on the slopes and the flats.
  "v0.1": { lines: 5, gap: 12, width: 4.8, mode: "parallel", center: 51, pulse: PULSE_LOW },
  // v0.2: three bold parallel lines.
  "v0.2": { lines: 3, gap: 20, width: 8.6, mode: "parallel", center: 51, pulse: PULSE_LOW },
}

export function markSvg(name, { color = "currentColor", size } = {}) {
  const m = MARKS[name]
  const lines = Array.from({ length: m.lines }, (_, i) => {
    const d = (i - (m.lines - 1) / 2) * m.gap
    const pulse = m.pulse ?? PULSE
    const pts = m.mode === "translate" ? pulse.map(([x, y]) => [x, y + d]) : offsetPolyline(pulse, d)
    return `<polyline points="${pts.map(([x, y]) => `${+x.toFixed(2)},${+(y + m.center).toFixed(2)}`).join(" ")}"/>`
  }).join("")
  const dim = size ? ` width="${size}" height="${size}"` : ""
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"${dim}><title>Timelake</title><defs><clipPath id="tl-${name.replace(".", "-")}"><circle cx="50" cy="50" r="47"/></clipPath></defs><g clip-path="url(#tl-${name.replace(".", "-")})" fill="none" stroke="${color}" stroke-width="${m.width}" stroke-linejoin="miter" stroke-miterlimit="12" stroke-linecap="butt">${lines}</g></svg>\n`
}

if (import.meta.main) {
  const dir = path.join(import.meta.dir, "logo")
  mkdirSync(dir, { recursive: true })
  for (const name of Object.keys(MARKS)) {
    writeFileSync(path.join(dir, `timelake-mark-${name}.svg`), markSvg(name, { color: "#000" }))
    writeFileSync(path.join(dir, `timelake-mark-${name}-white.svg`), markSvg(name, { color: "#fff" }))
  }
  console.log(`wrote ${Object.keys(MARKS).length * 2} files to ${dir}`)
}
