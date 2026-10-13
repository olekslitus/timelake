// Generates the Timelake mark: parallel lines with sharp (mitered) turns, clipped to a circle.
//   bun brand/marks.mjs            writes brand/logo/*.svg
// Coordinates are a 100×100 box; y grows downward.
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

// <geometry> Shared with the logo editor (brand/build-editor.mjs inlines this block); no imports.

// The pulse: flat, a sharp rise, a deeper fall, back to flat. v0 uses it as drawn; the parallel
// versions use a lower pulse, because offsetting grows the spike on the outer lines.
export const PULSE = [[-6, 0], [30, 0], [43, -14], [67, 12], [78, 0], [106, 0]]
export const PULSE_LOW = [[-6, 0], [32, 0], [42, -10], [60, 8], [68, 0], [106, 0]]

// Offsets a polyline along its normal by d (positive = down for a rightward line), with miter joins.
// Segments that would reverse direction on the inner side of a sharp turn are dropped, the way a
// real parallel curve loses detail inside a tight corner; `keepAll` skips that and keeps one point
// per input point (used for blending with copies).
export function offsetPolyline(pts, d, { keepAll = false } = {}) {
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
    if (keepAll) return out
    // A segment whose offset runs backwards has collapsed; drop it and retry.
    const bad = segs.findIndex((s, i) => (out[i + 1][0] - out[i][0]) * s.ux + (out[i + 1][1] - out[i][1]) * s.uy <= 0)
    if (bad < 0) return out
    segs = segs.filter((_, i) => i !== bad)
  }
}

// The lines of a mark, as point lists in the 100×100 box.
//   lines, gap, width   how many lines, their spacing, their stroke
//   pulse               the anchor line's shape: [[x, dy], …]
//   mode "translate"    identical copies (v0); otherwise parallel, mixed with copies by `blend`
//                       (0 = copies, 1 = truly parallel; default 1)
//   anchor              index of the line drawn exactly as `pulse` (default: the middle one)
//   center              vertical position of the middle of the stack
export function markLines(m) {
  const anchor = m.anchor ?? (m.lines - 1) / 2
  const pulse = m.pulse ?? PULSE
  const blend = m.mode === "translate" ? 0 : (m.blend ?? 1)
  return Array.from({ length: m.lines }, (_, i) => {
    const d = (i - anchor) * m.gap
    const copy = pulse.map(([x, y]) => [x, y + d])
    let pts
    if (blend === 0) pts = copy
    else if (blend === 1) pts = offsetPolyline(pulse, d)
    else {
      const exact = offsetPolyline(pulse, d)
      const par = exact.length === copy.length ? exact : offsetPolyline(pulse, d, { keepAll: true })
      pts = par.map(([x, y], k) => [copy[k][0] + (x - copy[k][0]) * blend, copy[k][1] + (y - copy[k][1]) * blend])
    }
    if (m.anchor != null) pts = pts.map(([x, y]) => [x, y + (anchor - (m.lines - 1) / 2) * m.gap])
    return pts.map(([x, y]) => [x, y + m.center])
  })
}

// SVG for a mark spec. Extra options: r (clip radius, default 47), ring (outline width, 0 = none),
// ringGap (space between outline and lines), disc (solid circle with the lines cut out),
// join ("miter" | "bevel" | "round").
export function markSvg(m, { color = "currentColor", size, id = "tl" } = {}) {
  const lines = markLines(m)
    .map(pts => `<polyline points="${pts.map(([x, y]) => `${+x.toFixed(2)},${+y.toFixed(2)}`).join(" ")}"/>`)
    .join("")
  const join = m.join ?? "miter"
  const strokeAttrs = `fill="none" stroke-width="${m.width}" stroke-linejoin="${join}" stroke-miterlimit="12" stroke-linecap="butt"`
  const dim = size ? ` width="${size}" height="${size}"` : ""
  const cid = `${id}-clip`.replace(/[^A-Za-z0-9_-]/g, "-")
  let body
  if (m.disc) {
    const r = m.r ?? 48
    body = `<defs><mask id="${cid}"><circle cx="50" cy="50" r="${r}" fill="#fff"/><g ${strokeAttrs} stroke="#000">${lines}</g></mask></defs>` +
      `<circle cx="50" cy="50" r="${r}" fill="${color}" mask="url(#${cid})"/>`
  } else {
    const ring = m.ring ?? 0
    const r = ring > 0 ? 49 - ring - (m.ringGap ?? 4) : (m.r ?? 47)
    body = `<defs><clipPath id="${cid}"><circle cx="50" cy="50" r="${r}"/></clipPath></defs>` +
      (ring > 0 ? `<circle cx="50" cy="50" r="${49 - ring / 2}" fill="none" stroke="${color}" stroke-width="${ring}"/>` : "") +
      `<g clip-path="url(#${cid})" ${strokeAttrs} stroke="${color}">${lines}</g>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"${dim}><title>Timelake</title>${body}</svg>\n`
}

// </geometry>

export const MARKS = {
  // v0: lines are vertical copies of one pulse. Spacing tightens on the slopes.
  "v0": { lines: 5, gap: 13, width: 4.8, mode: "translate", center: 52 },
  // v0.1: true parallel lines, so the gap measured across the lines is the same on the slopes and the flats.
  "v0.1": { lines: 5, gap: 12, width: 4.8, mode: "parallel", center: 51, pulse: PULSE_LOW },
  // v0.2: three bold parallel lines.
  "v0.2": { lines: 3, gap: 20, width: 8.6, mode: "parallel", center: 51, pulse: PULSE_LOW },
}

if (import.meta.main) {
  const dir = path.join(import.meta.dir, "logo")
  mkdirSync(dir, { recursive: true })
  for (const [name, spec] of Object.entries(MARKS)) {
    const id = `tl-${name.replace(".", "-")}`
    writeFileSync(path.join(dir, `timelake-mark-${name}.svg`), markSvg(spec, { color: "#000", id }))
    writeFileSync(path.join(dir, `timelake-mark-${name}-white.svg`), markSvg(spec, { color: "#fff", id }))
  }
  console.log(`wrote ${Object.keys(MARKS).length * 2} files to ${dir}`)
}
