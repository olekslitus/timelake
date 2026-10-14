// The mark editor, served locally, saving designs into the repo.
//   bun brand/editor.mjs [port]      then open the printed URL
// Each saved design is brand/designs/<id>.json (mark spec + wordmark) plus <id>.svg (black mark).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import { buildEditor } from "./build-editor.mjs"
import { MARKS, markSvg } from "./marks.mjs"

const designsDir = path.join(import.meta.dir, "designs")
mkdirSync(designsDir, { recursive: true })
const ID = /^[a-z0-9][a-z0-9-]{0,59}$/
const json = (body, status = 200) => Response.json(body, { status })

function list() {
  return readdirSync(designsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ id: f.slice(0, -5), ...JSON.parse(readFileSync(path.join(designsDir, f), "utf8")) }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.argv[2] ?? 4321),
  async fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname === "/")
      return new Response(buildEditor(), { headers: { "content-type": "text/html; charset=utf-8" } })
    if (pathname === "/favicon.ico")
      return new Response(markSvg(MARKS.v1, { color: "#000" }), { headers: { "content-type": "image/svg+xml" } })
    if (pathname === "/api/designs" && req.method === "GET") return json(list())
    const m = pathname.match(/^\/api\/designs\/([^/]+)$/)
    if (m) {
      const id = decodeURIComponent(m[1])
      if (!ID.test(id)) return json({ error: "ids are lowercase letters, digits and dashes" }, 400)
      const file = path.join(designsDir, `${id}.json`)
      if (req.method === "PUT") {
        const { name, spec, wordmark, createdAt } = await req.json()
        if (!spec || typeof spec.lines !== "number") return json({ error: "missing mark spec" }, 400)
        writeFileSync(file, JSON.stringify({ name, spec, wordmark, createdAt }, null, 2) + "\n")
        writeFileSync(path.join(designsDir, `${id}.svg`), markSvg(spec, { color: "#000", id: `tl-${id}` }))
        return json({ id })
      }
      if (req.method === "DELETE") {
        if (!existsSync(file)) return json({ error: "not found" }, 404)
        rmSync(file)
        rmSync(path.join(designsDir, `${id}.svg`), { force: true })
        return new Response(null, { status: 204 })
      }
    }
    return new Response("not found", { status: 404 })
  },
})
console.log(
  `Timelake mark editor: http://${server.hostname}:${server.port}  (designs in ${path.relative(process.cwd(), designsDir) || designsDir})`,
)
