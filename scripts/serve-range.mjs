// Static file server with HTTP Range, HEAD and CORS, for testing Timelake's HTTPS read path
// locally (the way Vercel Blob or a CDN serves a warehouse).
//   bun scripts/serve-range.mjs <dir> [port]
import { createReadStream, statSync } from "node:fs"
import { createServer } from "node:http"
import path from "node:path"

const root = path.resolve(process.argv[2] ?? ".")
const port = Number(process.argv[3] ?? 4100)

createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Headers", "Range")
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, ETag")
  if (req.method === "OPTIONS") return res.writeHead(204).end()
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname)
  const file = path.join(root, rel)
  if (!file.startsWith(root)) return res.writeHead(403).end()
  let st
  try {
    st = statSync(file)
    if (!st.isFile()) throw new Error()
  } catch {
    return res.writeHead(404).end()
  }
  const headers = { "Accept-Ranges": "bytes", "Last-Modified": st.mtime.toUTCString(), ETag: `"${st.size}-${st.mtimeMs}"` }
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "")
  if (m) {
    let start = m[1] === "" ? st.size - Number(m[2]) : Number(m[1])
    let end = m[1] !== "" && m[2] !== "" ? Number(m[2]) : st.size - 1
    end = Math.min(end, st.size - 1)
    if (start > end || start < 0) return res.writeHead(416, { "Content-Range": `bytes */${st.size}` }).end()
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 })
    return req.method === "HEAD" ? res.end() : createReadStream(file, { start, end }).pipe(res)
  }
  res.writeHead(200, { ...headers, "Content-Length": st.size })
  req.method === "HEAD" ? res.end() : createReadStream(file).pipe(res)
}).listen(port, "127.0.0.1", () => console.log(`serving ${root} on http://127.0.0.1:${port}`))
