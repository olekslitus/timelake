// Measures TableWriter in workerd (Cloudflare's runtime, through Miniflare) on a table in a local
// R2 bucket: appends of 1k, 10k and 100k rows, a steady stream of small appends with inline
// maintenance, and compaction of a day of 24 files. Each measurement runs in a fresh isolate, so
// its WebAssembly memory peak is its own. Then the table is copied out of R2 and checked with the
// Rust CLI.
//
//   cargo build --release -p timelake-cli   # at the repo root
//   cd bench/workers && bun install && bun bench.ts
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { Miniflare } from "miniflare"

const CLI = process.env.TIMELAKE_CLI ?? path.resolve(import.meta.dir, "../../target/release/timelake")
const WAREHOUSE = "http://bench.invalid/lake"
const DAY = 86_400_000
const T0 = Date.parse("2026-01-01T00:00:00Z")

const work = mkdtempSync(path.join(tmpdir(), "timelake-workers-"))
const local = path.join(work, "local")
const cli = (...args: string[]) => {
  const r = spawnSync(CLI, ["-w", WAREHOUSE, "-o", `timelake_local_root=${local}`, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`timelake ${args.join(" ")}: ${r.stderr}`)
  return r.stdout
}

const built = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "worker.ts")],
  target: "browser",
  external: ["./timelake.wasm"],
})
if (!built.success) throw new Error(built.logs.join("\n"))
const script = await built.outputs[0]!.text()
// The module Workers import (`import wasm from "./timelake.wasm"`), from the client's embedded copy.
const inline = readFileSync(path.join(import.meta.dir, "../../packages/timelake-client/src/wasm/inline.js"), "utf8")
const wasm = Buffer.from(/wasmBase64 = "([^"]+)"/.exec(inline)![1]!, "base64")

const persist = path.join(work, "r2")
function isolate(): Miniflare {
  return new Miniflare({
    modules: [
      { type: "ESModule", path: "worker.js", contents: script },
      { type: "CompiledWasm", path: "timelake.wasm", contents: wasm },
    ],
    compatibilityDate: "2026-08-01",
    r2Buckets: ["LAKE"],
    r2Persist: persist,
    bindings: { WAREHOUSE },
  })
}

interface Result {
  report: Record<string, unknown>
  ms: number
  wasmMemory: number
  heapPeak: number
}

async function call(mf: Miniflare, pathAndQuery: string): Promise<Result & { wallMs: number }> {
  const started = performance.now()
  const res = await mf.dispatchFetch(`http://worker${pathAndQuery}`)
  const text = await res.text()
  if (!res.ok) throw new Error(`${pathAndQuery}: ${res.status} ${text}`)
  return { ...(JSON.parse(text) as Result), wallMs: Math.round(performance.now() - started) }
}

const mb = (n: number) => `${(n / 2 ** 20).toFixed(0)} MiB`
const log = (s: string) => console.log(s)

// The table, created by the CLI and copied into the bucket.
mkdirSync(local, { recursive: true })
cli(
  "create",
  "tsbs.readings",
  "--schema",
  "time:timestamptz,tags_id:int,latitude:double,longitude:double,elevation:double,velocity:double,heading:double,grade:double,fuel_consumption:double",
  "--time-column",
  "time",
  "--series-key",
  "tags_id",
)
{
  const mf = isolate()
  const bucket = await mf.getR2Bucket("LAKE")
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    )
  for (const f of walk(local)) await bucket.put(path.relative(local, f), readFileSync(f))
  await mf.dispose()
}

log("| Run | Rows | Time in workerd | WASM memory (heap peak) | Result |")
log("|---|---:|---:|---:|---|")
let start = T0
for (const n of [1_000, 10_000, 100_000]) {
  const mf = isolate()
  const r = await call(mf, `/append?rows=${n}&devices=100&start=${start}&maintain=false`)
  log(`| append, fresh isolate | ${n} | ${r.wallMs} ms | ${mb(r.wasmMemory)} (${mb(r.heapPeak)}) | ${r.report.files} file(s) |`)
  start += Math.ceil(n / 100) * 10_000
  await mf.dispose()
}

// A steady writer: 60 appends of 1,000 rows with inline maintenance, in one isolate.
{
  const mf = isolate()
  const times: number[] = []
  let rewritten = 0
  let last: Result | undefined
  for (let i = 0; i < 60; i++) {
    const r = await call(mf, `/append?rows=1000&devices=100&start=${start}`)
    start += 100_000
    times.push(r.wallMs)
    rewritten += Number((r.report.maintenance as { filesRewritten?: number } | undefined)?.filesRewritten ?? 0)
    last = r
  }
  times.sort((a, b) => a - b)
  const p50 = times[Math.floor(times.length / 2)]
  const max = times[times.length - 1]
  log(
    `| 60 appends with inline maintenance | 1000 each | p50 ${p50} ms, max ${max} ms | ${mb(last?.wasmMemory ?? 0)} (${mb(last?.heapPeak ?? 0)}) | ${rewritten} files compacted inline |`,
  )
  await mf.dispose()
}

// A cold day: 24 appends of 50,000 rows (no maintenance), then compaction in a fresh isolate.
{
  const mf = isolate()
  const day = T0 + 3 * DAY
  for (let h = 0; h < 24; h++) await call(mf, `/append?rows=50000&devices=1000&start=${day + h * 3_600_000}&maintain=false`)
  await mf.dispose()
}
for (const maxBytes of [64 << 20, undefined]) {
  const mf = isolate()
  const q = maxBytes === undefined ? "" : `?maxBytes=${maxBytes}`
  const r = await call(mf, `/maintain${q}`)
  const rep = r.report as { filesRewritten: number; rowsRewritten: number; bytesRewritten: number; moreToCompact: boolean }
  log(
    `| maintain${maxBytes === undefined ? "" : ` (maxBytes ${mb(maxBytes)})`}, fresh isolate | ${rep.rowsRewritten} | ${r.wallMs} ms | ${mb(r.wasmMemory)} (${mb(r.heapPeak)}) | ${rep.filesRewritten} files (${mb(rep.bytesRewritten)}) merged${rep.moreToCompact ? ", more left" : ""} |`,
  )
  await mf.dispose()
}

// Copy the table out of R2 and check it with the engine.
{
  const mf = isolate()
  const bucket = await mf.getR2Bucket("LAKE")
  rmSync(local, { recursive: true, force: true })
  let cursor: string | undefined
  do {
    const page = await bucket.list({ cursor })
    for (const o of page.objects) {
      const body = await bucket.get(o.key)
      const file = path.join(local, o.key)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, new Uint8Array(await body!.arrayBuffer()))
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  await mf.dispose()
}
const expected = 1_000 + 10_000 + 100_000 + 60 * 1_000 + 24 * 50_000
const counted = cli("sql", "--format", "json", "SELECT count(*) AS n FROM tsbs.readings").trim()
log(`\nThe engine reads ${JSON.parse(counted).n} rows (expected ${expected}).`)
rmSync(work, { recursive: true, force: true })
