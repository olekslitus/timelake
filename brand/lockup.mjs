// Generates the Timelake lockup (mark + "timelake" in Geist Medium, outlined) as SVG.
//   bun install && bun brand/lockup.mjs     writes brand/logo/timelake-lockup-*.svg
// Proportions follow WORDMARK in marks.mjs and match the editor: text size and gap are fractions of
// the mark's height, and the text box is centered on the mark the way CSS centers a line-height: 1 box.
import { mkdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

import { loadSync } from "opentype.js"

import { MARKS, WORDMARK, markLines } from "./marks.mjs"

const require = createRequire(import.meta.url)
const fontFile = path.join(
  path.dirname(require.resolve("geist/package.json")),
  "dist/fonts/geist-sans/Geist-Medium.ttf",
)
const font = loadSync(fontFile)

export function lockupSvg(name, { color }) {
  const m = MARKS[name]
  const fs = 100 * WORDMARK.sizeOfMark
  const gap = 100 * WORDMARK.gapOfMark
  const upm = font.unitsPerEm
  const asc = font.ascender / upm,
    desc = -font.descender / upm
  const baseline = 50 - fs / 2 + (fs - (asc + desc) * fs) / 2 + asc * fs
  const x0 = 100 + gap
  const textPath = font.getPath(WORDMARK.text, x0, baseline, fs, {
    kerning: true,
    letterSpacing: WORDMARK.letterSpacingEm,
  })
  const bb = textPath.getBoundingBox()
  const width = Math.ceil(bb.x2 + 1)
  // The mark, inlined (same geometry as markSvg) so the lockup is one self-contained file.
  const lines = markLines(m)
    .map((pts) => `<polyline points="${pts.map(([x, y]) => `${+x.toFixed(2)},${+y.toFixed(2)}`).join(" ")}"/>`)
    .join("")
  const cid = `tl-lockup-${name.replace(/[^A-Za-z0-9]/g, "-")}`
  const r = m.r ?? 47
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 100"><title>Timelake</title>` +
    `<defs><clipPath id="${cid}"><circle cx="50" cy="50" r="${r}"/></clipPath></defs>` +
    `<g clip-path="url(#${cid})" fill="none" stroke="${color}" stroke-width="${m.width}" stroke-linejoin="${m.join ?? "miter"}" stroke-miterlimit="12" stroke-linecap="butt">${lines}</g>` +
    `<path fill="${color}" d="${textPath.toPathData(2)}"/></svg>\n`
  )
}

if (import.meta.main) {
  const dir = path.join(import.meta.dir, "logo")
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "timelake-lockup-v1.svg"), lockupSvg("v1", { color: "#000" }))
  writeFileSync(path.join(dir, "timelake-lockup-v1-white.svg"), lockupSvg("v1", { color: "#fff" }))
  console.log(`wrote 2 lockup files to ${dir}`)
}
