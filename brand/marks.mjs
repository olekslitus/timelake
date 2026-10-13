// Generates the Timelake mark: parallel lines with sharp (mitered) turns, clipped to a circle.
//   bun brand/marks.mjs            writes brand/logo/*.svg
// Coordinates are a 100×100 box; y grows downward.
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

// The pulse: flat, a sharp rise, a deeper fall, back to flat. v0 uses it as drawn; the parallel
// versions use a lower pulse, because offsetting grows the spike on the outer lines.
export const PULSE = [[-6, 0], [30, 0], [43, -14], [67, 12], [78, 0], [106, 0]]
export const PULSE_LOW = [[-6, 0], [32, 0], [42, -10], [60, 8], [68, 0], [106, 0]]

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

// `name` is a key of MARKS, or a spec object { lines, gap, width, mode, center, pulse, id }.
export function markSvg(name, { color = "currentColor", size } = {}) {
  const m = typeof name === "string" ? MARKS[name] : name
  if (typeof name !== "string") name = m.id
  const polys = Array.from({ length: m.lines }, (_, i) => {
    // `anchor` is the line that keeps the pulse exactly as drawn (default: the middle one); the
    // others are offset from it. `blend` mixes parallel (1) with identical copies (0).
    const anchor = m.anchor ?? (m.lines - 1) / 2
    const d = (i - anchor) * m.gap
    const pulse = m.pulse ?? PULSE
    const copy = pulse.map(([x, y]) => [x, y + d])
    let pts = m.mode === "translate" ? copy : offsetPolyline(pulse, d)
    if (m.mode !== "translate" && m.blend != null && pts.length === copy.length)
      pts = pts.map(([x, y], k) => [copy[k][0] + (x - copy[k][0]) * m.blend, copy[k][1] + (y - copy[k][1]) * m.blend])
    if (m.anchor != null) pts = pts.map(([x, y]) => [x, y + (anchor - (m.lines - 1) / 2) * m.gap])
    return pts.map(([x, y]) => [x, y + m.center])
  })
  const lines = polys.map(pts => `<polyline points="${pts.map(([x, y]) => `${+x.toFixed(2)},${+y.toFixed(2)}`).join(" ")}"/>`).join("")
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
