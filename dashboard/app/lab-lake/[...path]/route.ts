import { readFile } from "node:fs/promises"
import path from "node:path"

/** The lab's demo table (dashboard/lab-lake), written with the CLI. */
const ROOT = path.resolve(/*turbopackIgnore: true*/ process.cwd(), "lab-lake")

/**
 * Serves the demo table to the lab page's browser reader, with the byte ranges it asks for. Local development only:
 * the lab and its data aren't part of the public site.
 */
export async function GET(request: Request, { params }: RouteContext<"/lab-lake/[...path]">) {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 })
  const file = path.resolve(ROOT, ...(await params).path)
  if (!file.startsWith(ROOT + path.sep)) return new Response(null, { status: 404 })
  let bytes: Buffer
  try {
    bytes = await readFile(file)
  } catch {
    return new Response(null, { status: 404 })
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "")
  if (!range) return new Response(new Uint8Array(bytes), { headers: { "accept-ranges": "bytes" } })
  const start = Number(range[1])
  const end = Math.min(range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1)
  if (start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${bytes.length}` } })
  return new Response(new Uint8Array(bytes.subarray(start, end + 1)), {
    status: 206,
    headers: { "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${bytes.length}` },
  })
}
