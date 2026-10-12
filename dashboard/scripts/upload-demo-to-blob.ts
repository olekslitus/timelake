// Uploads the demo warehouse (built by ../scripts/build-demo-warehouse.sh) to Vercel Blob, keeping
// object paths so the URLs recorded in the Iceberg metadata resolve.
//
//   1. Create a public Blob store (Vercel dashboard → Storage → Blob), note its base URL
//      https://<store-id>.public.blob.vercel-storage.com
//   2. ../scripts/build-demo-warehouse.sh https://<store-id>.public.blob.vercel-storage.com/demo
//   3. BLOB_READ_WRITE_TOKEN=... bun scripts/upload-demo-to-blob.ts
//   4. Set TIMELAKE_URL=https://<store-id>.public.blob.vercel-storage.com/demo on the Vercel project.
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

import { put } from "@vercel/blob"

const DIR = path.resolve(process.cwd(), "../bench/data/demo-site") // run from dashboard/

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
const files = await walk(DIR)
let bytes = 0
for (const f of files) {
  const pathname = path.relative(DIR, f).split(path.sep).join("/")
  const body = await readFile(f)
  // Pointers change on every commit; data, manifests and indexes are immutable.
  const mutable = pathname.endsWith("version-hint.text") || pathname.endsWith("timelake-tables.json")
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
