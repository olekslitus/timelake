// Builds the logo editor page: brand/editor.template.html with the geometry block of marks.mjs
// inlined, so the editor draws exactly what `bun brand/marks.mjs` writes.
//   bun brand/build-editor.mjs <out.html>
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const dir = import.meta.dir
const marks = readFileSync(path.join(dir, "marks.mjs"), "utf8")
const start = marks.indexOf("// <geometry>")
const end = marks.indexOf("// </geometry>")
if (start < 0 || end < 0) throw new Error("geometry markers not found in marks.mjs")
const geometry = marks.slice(start, end).replace(/^export /gm, "")
const html = readFileSync(path.join(dir, "editor.template.html"), "utf8").replace("/*__GEOMETRY__*/", geometry)
const out = process.argv[2] ?? path.join(dir, "editor.html")
writeFileSync(out, html)
console.log(`wrote ${out}`)
