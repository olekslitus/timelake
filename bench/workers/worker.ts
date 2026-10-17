// The Worker the benchmark runs in workerd: appends generated rows to a table in an R2 binding,
// or runs maintenance, and reports time and the WebAssembly memory peak.
import wasm from "./timelake.wasm"
import {
  TableWriter,
  initWasm,
  r2Store,
  wasmHeapPeakBytes,
  wasmMemoryBytes,
  type R2BucketLike,
} from "../../packages/timelake-client/src/workers"

initWasm(wasm)

interface Env {
  LAKE: R2BucketLike
  WAREHOUSE: string
}

/** `n` rows of `devices` devices from `start` (ms), one reading per device every 10 s: TSBS-like,
 * values drifting with noise (so they compress like sensor data, not like a pattern). */
function rows(n: number, devices: number, start: number) {
  let seed = (start / 1000) ^ n
  const noise = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 2 ** 32
  }
  return Array.from({ length: n }, (_, i) => {
    const d = i % devices
    const t = start + Math.floor(i / devices) * 10_000
    return {
      time: t,
      tags_id: d,
      latitude: (d * 0.37) % 90 + noise() * 0.01,
      longitude: (d * 0.11) % 180 + noise() * 0.01,
      elevation: 100 + noise() * 400,
      velocity: noise() * 120,
      heading: noise() * 360,
      grade: noise(),
      fuel_consumption: 20 + noise() * 10,
    }
  })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const q = (k: string, d: number) => Number(url.searchParams.get(k) ?? d)
    const writer = new TableWriter(r2Store(env.LAKE), env.WAREHOUSE, "tsbs.readings")
    const started = Date.now()
    if (url.pathname === "/append") {
      const batch = rows(q("rows", 1000), q("devices", 100), q("start", 1_767_225_600_000))
      const maintain = url.searchParams.get("maintain") !== "false"
      const report = await writer.append(batch, { maintain, maxCompactBytes: q("maxBytes", 64 << 20) })
      return Response.json({ report, ms: Date.now() - started, wasmMemory: wasmMemoryBytes(), heapPeak: wasmHeapPeakBytes() })
    }
    if (url.pathname === "/maintain") {
      const max = url.searchParams.get("maxBytes")
      const report = await writer.maintain({ maxBytes: max === null ? undefined : Number(max) })
      return Response.json({ report, ms: Date.now() - started, wasmMemory: wasmMemoryBytes(), heapPeak: wasmHeapPeakBytes() })
    }
    return new Response("not found", { status: 404 })
  },
}
