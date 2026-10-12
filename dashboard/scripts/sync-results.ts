/**
 * Copies the benchmark results the site's pages read from ../bench/results into data/results, so
 * the app builds and runs where only this directory exists (e.g. a Vercel deploy rooted here).
 *
 *   bun run sync-results
 */
import { copyFile, mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const src = path.resolve(root, "../bench/results")
const dst = path.resolve(root, "data/results")
const WANTED = [/^tsbs_iot\.v0-.*\.jsonl$/, /^iot_point\.v0-.*\.jsonl$/, /^v0_ingest\.jsonl$/, /^tsdb_cloud\.jsonl$/]

const files = (await readdir(src)).filter((f) => WANTED.some((re) => re.test(f))).sort()
if (files.length === 0) {
  console.error(`no result files found in ${src}`)
  process.exit(1)
}
await rm(dst, { recursive: true, force: true })
await mkdir(dst, { recursive: true })
for (const f of files) await copyFile(path.join(src, f), path.join(dst, f))
console.log(`copied ${files.length} files to ${path.relative(root, dst)}: ${files.join(", ")}`)
