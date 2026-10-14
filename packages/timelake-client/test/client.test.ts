// Reads the demo warehouse over HTTP and checks results against the Rust engine (timelake CLI).
//   scripts/build-demo-warehouse.sh            (repo root; builds for http://127.0.0.1:4100/demo)
//   bun test                                   (starts scripts/serve-range.mjs itself)
import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import path from "node:path"

import { z } from "zod"

import { Lake, readerVersion, zodSource } from "../src/index"

const ROOT = path.resolve(import.meta.dir, "../../..")
const PORT = 4111
const BASE_BUILT = "http://127.0.0.1:4100/demo"
const BASE = `http://127.0.0.1:${PORT}/demo`
let server: ChildProcess

beforeAll(async () => {
  server = spawn(
    "bun",
    [path.join(ROOT, "scripts/serve-range.mjs"), path.join(ROOT, "bench/data/demo-site"), String(PORT)],
    { stdio: "ignore" },
  )
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/timelake-tables.json`)).ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error("range server did not start")
})
afterAll(() => server?.kill())

// The warehouse was built for port 4100; serve it from the test port.
const lake = new Lake(BASE, { rewriteUrl: (u) => u.replace(BASE_BUILT, BASE) })

function cliSql(sql: string): Record<string, unknown>[] {
  const r = spawnSync(
    path.join(ROOT, "target/release/timelake"),
    [
      "-w",
      BASE_BUILT,
      "-o",
      `timelake_local_root=${path.join(ROOT, "bench/data/demo-site")}`,
      "sql",
      "--format",
      "json",
      sql,
    ],
    { encoding: "utf8" },
  )
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

const Reading = z.object({
  time: z.coerce.date(),
  tags_id: z.number().int().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  elevation: z.number().nullable(),
  velocity: z.number().nullable(),
  heading: z.number().nullable(),
  grade: z.number().nullable(),
  fuel_consumption: z.number().nullable(),
})

test("wasm loads", () => {
  expect(readerVersion()).toBe("0.0.1")
})

test("lists tables and reads info", async () => {
  expect(await lake.tables()).toEqual(["tsbs.diagnostics", "tsbs.readings", "tsbs.tags"])
  const info = await lake.table("tsbs.readings").info()
  expect(info.timeColumn).toBe("time")
  expect(info.seriesKey).toEqual(["tags_id"])
  expect(info.files.reduce((s, f) => s + f.records, 0)).toBe(1156395)
})

test("latest matches the engine", async () => {
  const t = lake.table("tsbs.readings", Reading)
  const rows = await t.latest()
  expect(rows.length).toBe(50)
  expect(rows[0].time).toBeInstanceOf(Date)
  const expected = cliSql(
    "SELECT tags_id, velocity FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY tags_id ORDER BY time DESC) rn FROM tsbs.readings) WHERE rn = 1 ORDER BY tags_id",
  )
  const got = [...rows]
    .sort((a, b) => (a.tags_id ?? 0) - (b.tags_id ?? 0))
    .map((r) => ({ tags_id: r.tags_id, velocity: r.velocity }))
  expect(got).toEqual(expected as typeof got)
  const some = await t.latest({ series: [3, 7] })
  expect(some.map((r) => r.tags_id).sort()).toEqual([3, 7])
  expect(t.lastStats.requests).toBe(1)
})

test("range matches the engine and prunes", async () => {
  const t = lake.table("tsbs.readings", Reading)
  const from = "2026-01-03T12:00:00Z"
  const to = "2026-01-03T13:00:00Z"
  const rows = await t.range({ series: 7, from, to })
  const expected = cliSql(
    `SELECT time, velocity FROM tsbs.readings WHERE tags_id = 7 AND time >= TIMESTAMP '2026-01-03 12:00:00' AND time < TIMESTAMP '2026-01-03 13:00:00' ORDER BY time`,
  )
  expect(rows.length).toBe(expected.length)
  expect(rows.map((r) => r.velocity)).toEqual(expected.map((r) => r.velocity) as number[])
  expect(t.lastStats.files).toBe(1) // one day partition
  const desc = await t.range({ series: 7, limit: 1, order: "desc", columns: ["time", "velocity"] })
  expect(desc.length).toBe(1)
})

test("bucket aggregates match the engine", async () => {
  const t = lake.table("tsbs.readings")
  const rows = await t.bucket({ series: 7, every: "1h", agg: { velocity: ["avg", "max"], "*": ["count"] } })
  const expected = cliSql(
    "SELECT date_bin(INTERVAL '1 hour', time) AS bucket, avg(velocity) AS velocity_avg, max(velocity) AS velocity_max, count(*) AS count FROM tsbs.readings WHERE tags_id = 7 GROUP BY 1 ORDER BY 1",
  )
  expect(rows.length).toBe(expected.length)
  rows.forEach((r, i) => {
    expect(r.bucket.toISOString().replace(".000Z", "Z")).toBe(String(expected[i].bucket))
    expect(r.velocity_avg).toBeCloseTo(Number(expected[i].velocity_avg), 9)
    expect(r.velocity_max).toBe(Number(expected[i].velocity_max))
    expect(r.count).toBe(Number(expected[i].count))
  })
  const bySeries = await t.bucket({ series: [1, 2], every: "1d", agg: { velocity: ["avg"] }, by: ["tags_id"] })
  expect(bySeries.length).toBe(6)
  expect(bySeries[0].tags_id).toBeDefined()
})

test("zod source generation", async () => {
  const src = await lake.table("tsbs.readings").zodSource()
  expect(src).toContain("export const Reading = z.object({")
  expect(src).toContain("time: z.coerce.date(),")
  expect(zodSource({ name: "iot.devices", schema: [{ id: 1, name: "id", type: "string", required: true }] })).toContain(
    "export const Device",
  )
})
