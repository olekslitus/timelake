import { markSvg, PULSE, PULSE_LOW } from "../marks.mjs"
import { writeFileSync } from "node:fs"

// Copies = identical lines stacked vertically (like v0). Parallel = equal gap measured across the lines (like v0.1).
const T = (lines, gap, width, extra = {}) => ({ lines, gap, width, mode: "translate", center: 52, pulse: PULSE, ...extra })
const P = (lines, gap, width, extra = {}) => ({ lines, gap, width, mode: "parallel", center: 51, pulse: PULSE_LOW, ...extra })
const LOW = PULSE_LOW
const MID = [[-6, 0], [29, 0], [43, -14], [65, 8], [73, 0], [106, 0]]
const TALL = [[-6, 0], [27, 0], [45, -18], [68, 5], [73, 0], [106, 0]]
const SHALLOW = [[-6, 0], [26, 0], [43, -12], [66, 4], [72, 0], [106, 0]]
const C = (gap, width, pulse, extra = {}) => ({ lines: 3, gap, width, mode: "parallel", center: 51, pulse, ...extra })
const CV = [
  ["C1", C(22, 11, LOW), "B2 as it was, for reference"],
  ["C2", C(27, 13, LOW), "B2 spread to fill the circle"],
  ["C3", C(26, 12.5, MID), "Fills the circle, taller spike"],
  ["C4", C(26, 12.5, TALL), "Fills the circle, tallest spike"],
  ["C5", C(26, 13, SHALLOW), "Lower-angle slopes, so the bottom rise keeps its height"],
  ["C6", C(26, 12.5, MID, { anchor: 2 }), "Bottom line keeps the full spike; the lines above grow"],
  ["C7", C(25, 12, TALL, { anchor: 2 }), "Bottom anchored, tallest spike"],
  ["C8", C(26, 12.5, TALL, { blend: 0.5 }), "Half parallel, half copies: the bottom rise stays sharp"],
  ["C9", C(27, 13, MID, { blend: 0.6 }), "Mostly parallel, taller spike"],
  ["C10", C(26, 12.5, TALL, { anchor: 2, blend: 0.7 }), "Bottom anchored and blended"],
  ["C11", C(28, 15, TALL), "Heaviest, tallest spike"],
  ["C12", C(28, 15, MID, { anchor: 2 }), "Heaviest, bottom anchored"],
]
const RISE = [[-6, 0], [28, 0], [44, -16], [64, 4], [68, 0], [106, 0]]
const DV = [
  ["F1", C(22, 11, LOW), "B2 as it was, for reference"],
  ["F2", C(25, 12.5, MID, { blend: 0.35, center: 51 }), "Fuller circle, clear bottom rise"],
  ["F3", C(25, 14, MID, { blend: 0.35, center: 51 }), "F2, bolder"],
  ["F4", C(25, 12.5, MID, { blend: 0.25, center: 51 }), "Bottom rise stronger, spacing a little less even"],
  ["F5", C(25, 12.5, MID, { blend: 0.5, center: 51 }), "Spacing more even, bottom rise softer"],
  ["F6", C(25, 12.5, RISE, { blend: 0.35, center: 52 }), "Taller rise, shallow fall"],
  ["F7", C(26, 13, RISE, { blend: 0.25, center: 52 }), "Taller rise, strongest bottom rise"],
  ["F8", C(24, 12, TALL, { blend: 0.35, center: 52 }), "Tall spike, lighter"],
  ["F9", C(25, 13, TALL, { blend: 0.25, center: 53 }), "Tall spike, strong bottom rise"],
  ["F10", C(27, 14, MID, { blend: 0.35, center: 51 }), "Widest spread, heaviest"],
  ["F11", C(23, 11, MID, { blend: 0.35, center: 51 }), "B2's weight with the clearer bottom rise"],
  ["F12", C(24, 12, RISE, { blend: 0.5, center: 52 }), "Taller rise, more even spacing"],
]
const V = [
  ["A1", T(3, 20, 8.5), "Three bold copies"],
  ["A2", T(4, 16, 6.5), "Four, medium-bold"],
  ["A3", T(4, 17, 4.4), "Four, light and airy"],
  ["A4", T(5, 13, 4.8), "Five: this is v0"],
  ["A5", T(5, 13, 3.4), "Five, light"],
  ["A6", T(5, 10.5, 5.6), "Five, tight and dark"],
  ["A7", T(6, 11, 3.8), "Six, fine"],
  ["A8", T(7, 9.5, 2.8), "Seven, hairline"],
  ["A9", T(3, 22, 11), "Three heavy copies"],
  ["B1", P(3, 20, 8.6), "Three bold parallel: this is v0.2"],
  ["B2", P(3, 22, 11), "Three heavy parallel"],
  ["B3", P(3, 19, 5.5), "Three light parallel"],
  ["B4", P(4, 15, 6.5), "Four parallel, medium-bold"],
  ["B5", P(4, 15, 4), "Four parallel, light"],
  ["B6", P(5, 12, 4.8), "Five parallel: this is v0.1"],
  ["B7", P(5, 12, 3.4), "Five parallel, light"],
  ["B8", P(5, 10, 5), "Five parallel, tight"],
  ["B9", P(6, 10, 3.6), "Six parallel, fine"],
]
const svg = (id, spec, opts) => markSvg(spec, { ...opts, id })
const PN = new Map([[PULSE, "v0 spike"], [LOW, "low spike"], [MID, "mid spike"], [TALL, "tall spike"], [SHALLOW, "shallow slopes"]])
const card = ([id, spec, note]) => {
  const params = [`${spec.lines} lines`, `stroke ${spec.width}`, `gap ${spec.gap}`, spec.mode === "translate" ? "copies" : "parallel", PN.get(spec.pulse),
    spec.anchor != null ? "bottom anchored" : null, spec.blend != null ? `blend ${spec.blend}` : null, spec.fit ? "fitted" : null].filter(Boolean).join(" · ")
  const side = (cls) => `<div class="sw ${cls}">${svg(id, spec).replace("<svg ", '<svg class="big" ')}
      <div class="sizes">${svg(id, spec, { size: 48 })}${svg(id, spec, { size: 32 })}${svg(id, spec, { size: 16 })}</div></div>`
  return `<article class="card" id="${id}">
    <div class="pair">${side("paper")}${side("ink")}</div>
    <div class="lock">${svg(id, spec, { size: 26 })}<b>timelake</b></div>
    <div class="meta"><div class="id">${id}</div><p>${note}</p><p class="params">${params}</p></div>
  </article>`
}

const html = `<title>Pulse Mark Variants</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500&family=Geist+Mono:wght@400;500&display=swap">
<style>
/* Layout: a contact sheet. Two families side by side in hairline cells; each card shows paper, ink, four sizes and the lockup. */
:root {
  --bg: #0B0D0E; --panel: #101315; --line: #23292C; --fg: #E6EBED; --muted: #8B969B; --accent: #67D4F0;
  --sans: "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { --bg: #F4F5F5; --panel: #FFFFFF; --line: #D9DEE0; --fg: #0D1113; --muted: #59656A; --accent: #0B7FA6; color-scheme: light; } }
:root[data-theme="light"] { --bg: #F4F5F5; --panel: #FFFFFF; --line: #D9DEE0; --fg: #0D1113; --muted: #59656A; --accent: #0B7FA6; color-scheme: light; }
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--fg); font: 15px/1.5 var(--sans); padding-inline: 20px; padding-block: 0 80px; }
.wrap { max-width: 1200px; margin: 0 auto; display: flex; flex-direction: column; gap: 40px; }
header { padding-block: 32px 8px; display: flex; flex-direction: column; gap: 12px; max-width: 760px; }
h1 { margin: 0; font-weight: 300; font-size: clamp(30px, 4.6vw, 46px); letter-spacing: -0.02em; line-height: 1.08; text-wrap: balance; }
h2 { margin: 0; font-weight: 300; font-size: 26px; letter-spacing: -0.02em; }
.label { font: 500 12px var(--mono); text-transform: uppercase; letter-spacing: .1em; color: var(--muted); }
.label b { color: var(--accent); font-weight: 500; }
p { margin: 0; }
.lead { color: var(--muted); font-size: 16px; }
section { display: flex; flex-direction: column; gap: 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.card { background: var(--panel); display: flex; flex-direction: column; min-width: 0; }
.pair { display: grid; grid-template-columns: 1fr 1fr; }
.sw { display: grid; place-items: center; gap: 14px; padding: 24px 8px 16px; }
.sw.paper { background: #FFFFFF; color: #0A0A0A; }
.sw.ink { background: #0A0A0A; color: #FFFFFF; }
.sw svg.big { width: 120px; height: 120px; display: block; }
.sizes { display: flex; align-items: center; gap: 10px; }
.sizes svg { display: block; }
.lock { display: flex; align-items: center; gap: 9px; padding: 14px 18px; border-top: 1px solid var(--line); }
.lock svg { flex: none; color: var(--fg); }
.lock b { font-weight: 500; font-size: 22px; letter-spacing: -0.045em; }
.meta { padding: 12px 18px 18px; display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--line); }
.id { font: 500 14px var(--mono); color: var(--accent); letter-spacing: .04em; }
.params { font: 12px var(--mono); color: var(--muted); }
</style>
<div class="wrap">
  <header>
    <div class="label">Timelake mark · <b>${V.length + CV.length + DV.length} variants</b></div>
    <h1>Pulse: B2 refined, plus the full set</h1>
    <p class="lead"><b>New at the top (F):</b> twelve B2 versions that fill the circle and give the bottom line a clear first rise. With three heavy lines that fill the circle, perfectly even spacing and a tall bottom rise can't both fit, so these blend part of the way from parallel (even gaps) toward identical copies (full rise on every line). "Blend" is how parallel it stays: 0.25 favors the bottom rise, 0.5 favors even gaps. <b>C</b> is the earlier B2 round. In a parallel design, each lower line has to rise less than the one above it; that is why B2's bottom line became a tiny bump. Taller spikes, lower-angle slopes, drawing the full spike on the bottom line (bottom anchored), and blending parallel with copies all keep the bottom rise strong. Below that, the original two families.</p>
    <p class="lead">Two families. <b>A</b> stacks identical copies of the pulse, like v0, so the gaps narrow on the slopes. <b>B</b> uses truly parallel lines, like v0.1, so the gap is the same everywhere and the outer lines become nested chevrons. Each card shows paper and ink at 120, 48, 32 and 16 px, plus the lockup. Tell me the IDs you like, or mix them ("B4 but with A2's stroke").</p>
  </header>
  <section>
    <div class="label"><b>F · B2, final round</b> · fills the circle, clear first rise on the bottom line</div>
    <div class="grid">${DV.map(card).join("")}</div>
  </section>
  <section>
    <div class="label"><b>C · B2 refined</b> · three heavy lines that fill the circle, with a stronger first rise on the bottom line</div>
    <div class="grid">${CV.map(card).join("")}</div>
  </section>
  <section>
    <div class="label">A · identical copies</div>
    <div class="grid">${V.filter(v => v[0].startsWith("A")).map(card).join("")}</div>
  </section>
  <section>
    <div class="label">B · parallel, equal spacing</div>
    <div class="grid">${V.filter(v => v[0].startsWith("B")).map(card).join("")}</div>
  </section>
</div>
`
writeFileSync(process.argv[2], html)
console.log("variants:", V.length)
