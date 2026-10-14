// Static file server with HTTP Range, HEAD and CORS, for testing Timelake's HTTPS read path
// locally (the way Vercel Blob or a CDN serves a warehouse).
//   bun scripts/serve-range.mjs <dir> [port]       (port 0 picks a free one)
import { createReadStream, statSync } from "node:fs"
import { createServer } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** An HTTP server for the files under `dir`; call `.listen(port, host)` on it. */
export function createRangeServer(dir) {
  const root = path.resolve(dir)
  return createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Headers", "Range")
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, ETag")
    if (req.method === "OPTIONS") return res.writeHead(204).end()
    const rel = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)
    const file = path.join(root, rel)
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end()
    let st
    try {
      st = statSync(file)
      if (!st.isFile()) throw new Error("not a file")
    } catch {
      return res.writeHead(404).end()
    }
    const headers = {
      "Accept-Ranges": "bytes",
      "Last-Modified": st.mtime.toUTCString(),
      ETag: `"${st.size}-${st.mtimeMs}"`,
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "")
    if (m) {
      const start = m[1] === "" ? st.size - Number(m[2]) : Number(m[1])
      const end = Math.min(m[1] !== "" && m[2] !== "" ? Number(m[2]) : st.size - 1, st.size - 1)
      if (start > end || start < 0) return res.writeHead(416, { "Content-Range": `bytes */${st.size}` }).end()
      res.writeHead(206, {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${st.size}`,
        "Content-Length": end - start + 1,
      })
      return req.method === "HEAD" ? res.end() : createReadStream(file, { start, end }).pipe(res)
    }
    res.writeHead(200, { ...headers, "Content-Length": st.size })
    return req.method === "HEAD" ? res.end() : createReadStream(file).pipe(res)
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? ".")
  const server = createRangeServer(root)
  server.listen(Number(process.argv[3] ?? 4100), "127.0.0.1", () => {
    console.log(`serving ${root} on http://127.0.0.1:${server.address().port}`)
  })
}
