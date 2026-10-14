// Uploads the demo warehouse (built by ../scripts/build-demo-warehouse.sh) to Vercel Blob, keeping
// object paths so the URLs recorded in the Iceberg metadata resolve.
//
//   1. Create a public Blob store (Vercel dashboard → Storage → Blob), note its base URL
//      https://<store-id>.public.blob.vercel-storage.com
//   2. ../scripts/build-demo-warehouse.sh https://<store-id>.public.blob.vercel-storage.com/demo
//   3. BLOB_READ_WRITE_TOKEN=... bun run upload-demo https://<store-id>.public.blob.vercel-storage.com/demo
//   4. Set TIMELAKE_URL=https://<store-id>.public.blob.vercel-storage.com/demo on the Vercel project.
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

import { put } from "@vercel/blob"

const url = process.argv[2]
if (!url) {
  console.error("Usage: bun run upload-demo <warehouse URL>, the URL the demo was built for")
  process.exit(1)
}
// The folder build-demo-warehouse.sh wrote for this URL: scheme dropped, other separators replaced by "_".
const slug = url
  .replace(/^[a-z]+:\/\//, "")
  .replace(/\/+$/, "")
  .replace(/[^A-Za-z0-9.-]+/g, "_")
const DIR = path.resolve(import.meta.dirname, "../../bench/data/demo-site", slug)

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else out.push(p)
  }
  return out
}

const TYPES: Record<string, string> = {
  ".json": "application/json",
  ".text": "text/plain",
  ".parquet": "application/vnd.apache.parquet",
  ".avro": "application/avro",
}

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("Set BLOB_READ_WRITE_TOKEN (Vercel → Storage → your Blob store → .env.local).")
  process.exit(1)
}
// Pointers change on every commit; data, manifests, indexes and vN.metadata.json are immutable.
const MUTABLE = ["version-hint.text", "timelake-head", "timelake-tables.json"]
const isMutable = (f: string) => MUTABLE.some((name) => f.endsWith(name))
// Pointers last, so a reader never finds one before the files it points to.
const files = (await walk(DIR)).sort((a, b) => Number(isMutable(a)) - Number(isMutable(b)))
let bytes = 0
for (const f of files) {
  const pathname = path.relative(DIR, f).split(path.sep).join("/")
  const body = await readFile(f)
  const mutable = isMutable(pathname)
  const blob = await put(pathname, body, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: TYPES[path.extname(f)] ?? "application/octet-stream",
    cacheControlMaxAge: mutable ? 60 : 60 * 60 * 24 * 365,
  })
  bytes += body.length
  console.log(blob.url)
}
console.log(`uploaded ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB`)
console.log("Check range support: curl -sI -H 'Range: bytes=0-99' <a .parquet URL above>   (expect HTTP 206)")
