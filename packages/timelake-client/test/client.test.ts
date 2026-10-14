// Reads a generated warehouse over HTTP and checks the results against the Rust engine.
// Needs the CLI: `cargo build -p timelake-cli` at the repo root (or set TIMELAKE_CLI).
import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { z } from "zod"

import { Lake, readerVersion, zodSource, type AggOp } from "../src/index"
import { buildFixture, POINTS, SERIES, START, type Fixture } from "./fixture"

let fx: Fixture
let lake: Lake

beforeAll(() => {
  fx = buildFixture()
  lake = new Lake(fx.url)
})
afterAll(() => fx?.close())

const Reading = z.object({
  time: z.coerce.date(),
  tags_id: z.number().int(),
  velocity: z.number().nullable(),
  name: z.string(),
})

const byTag = (a: { tags_id: number }, b: { tags_id: number }) => a.tags_id - b.tags_id

test("wasm loads", () => {
  expect(readerVersion()).toBe("0.0.1")
})

test("lists tables and reads info", async () => {
  expect(await lake.tables()).toEqual(["iot.readings", "iot.tags", "iot.unindexed"])
  const info = await lake.table("iot.readings").info()
  expect(info.timeColumn).toBe("time")
  expect(info.seriesKey).toEqual(["tags_id"])
  expect(info.chunk).toBe("hour")
  expect(info.files.length).toBe(24)
  expect(info.files.reduce((s, f) => s + f.records, 0)).toBe(SERIES * POINTS)
  // Hour partitions, as hours since the epoch.
  const first = START / 3_600_000
  expect(info.files.map((f) => f.partition).toSorted()).toEqual(Array.from({ length: 24 }, (_, i) => first + i))
})

test("finds a commit the version hint doesn't mention yet", async () => {
  const hint = path.join(fx.dir, "lake/iot/readings/metadata/version-hint.text")
  const version = Number(readFileSync(hint, "utf8"))
  writeFileSync(hint, String(version - 1))
  try {
    expect((await new Lake(fx.url).table("iot.readings").info()).version).toBe(version)
  } finally {
    writeFileSync(hint, String(version))
  }
})

test("latest matches the engine", async () => {
  const t = lake.table("iot.readings", Reading)
  const rows = await t.latest()
  expect(t.lastStats.requests).toBe(1)
  const expected = fx.sql(
    "SELECT tags_id, velocity FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY tags_id ORDER BY time DESC) rn FROM iot.readings) WHERE rn = 1 ORDER BY tags_id",
  )
  expect(rows.length).toBe(SERIES)
  expect(rows[0]?.time).toBeInstanceOf(Date)
  expect(rows.toSorted(byTag).map((r) => ({ tags_id: r.tags_id, velocity: r.velocity }))).toEqual(
    expected as { tags_id: number; velocity: number | null }[],
  )
  const some = await t.latest({ series: [3, 7] })
  expect(some.map((r) => r.tags_id).toSorted()).toEqual([3, 7])
})

test("latest scans tables without a last-value index (B12)", async () => {
  const t = lake.table("iot.unindexed", Reading)
  expect((await t.info()).lastValueIndex).toBeNull()
  const rows = await t.latest()
  expect(t.lastStats.files).toBe(24)
  const expected = fx.sql(
    "SELECT tags_id, time, velocity FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY tags_id ORDER BY time DESC) rn FROM iot.unindexed) WHERE rn = 1 ORDER BY tags_id",
  )
  const got = rows.toSorted(byTag).map((r) => ({ ...r, time: r.time.toISOString().replace(".000Z", "Z") }))
  expect(got.map(({ tags_id, time, velocity }) => ({ tags_id, time, velocity }))).toEqual(
    expected as { tags_id: number; time: string; velocity: number | null }[],
  )
  const indexed = await lake.table("iot.readings", Reading).latest({ series: [3, 7] })
  const scanned = await t.latest({ series: [3, 7] })
  expect(scanned.toSorted(byTag)).toEqual(indexed.toSorted(byTag))
})

test("range matches the engine and prunes files", async () => {
  const t = lake.table("iot.readings", Reading)
  const from = "2026-01-01T12:00:00Z"
  const to = "2026-01-01T13:00:00Z"
  const rows = await t.range({ series: 7, from, to })
  const expected = fx.sql(
    `SELECT time, velocity FROM iot.readings WHERE tags_id = 7 AND time >= TIMESTAMP '2026-01-01 12:00:00' AND time < TIMESTAMP '2026-01-01 13:00:00' ORDER BY time`,
  )
  expect(rows.length).toBe(12)
  expect(rows.map((r) => r.velocity)).toEqual(expected.map((r) => r.velocity) as (number | null)[])
  expect(t.lastStats.files).toBe(1) // one hour partition
  const desc = await t.range({ series: 7, limit: 1, order: "desc", columns: ["time", "velocity"] })
  expect(desc.length).toBe(1)
  expect(desc[0]?.time.toISOString()).toBe("2026-01-01T23:55:00.000Z")
})

test("series values an int column can't hold match nothing (B3)", async () => {
  const t = lake.table("iot.readings")
  expect(await t.range({ series: 2 ** 32 + 7 })).toEqual([])
  expect(await t.range({ series: 7.5 })).toEqual([])
  expect(await t.range({ series: "7", limit: 1 })).toHaveLength(1)
})

test("queries over more files than the concurrency limit finish (B1)", async () => {
  const [{ n }] = fx.sql("SELECT count(*) AS n FROM iot.readings") as [{ n: number }]
  for (const concurrency of [1, 2, 16]) {
    const t = new Lake(fx.url, { concurrency }).table("iot.readings")
    expect(await t.range()).toHaveLength(n)
    expect(t.lastStats.files).toBe(24)
  }
})

test("bucket aggregates match the engine", async () => {
  const t = lake.table("iot.readings")
  const rows = await t.bucket({ series: 7, every: "1h", agg: { velocity: ["avg", "max"], "*": ["count"] } })
  const expected = fx.sql(
    "SELECT date_bin(INTERVAL '1 hour', time) AS bucket, avg(velocity) AS velocity_avg, max(velocity) AS velocity_max, count(*) AS count FROM iot.readings WHERE tags_id = 7 GROUP BY 1 ORDER BY 1",
  )
  expect(rows.length).toBe(24)
  expect(rows.length).toBe(expected.length)
  rows.forEach((r, i) => {
    const e = expected[i] ?? {}
    expect(r.bucket.toISOString().replace(".000Z", "Z")).toBe(String(e.bucket))
    expect(r.velocity_avg).toBeCloseTo(Number(e.velocity_avg), 9)
    expect(r.velocity_max).toBe(Number(e.velocity_max))
    expect(r.count).toBe(Number(e.count))
  })
  const bySeries = await t.bucket({ series: [1, 2], every: "1d", agg: { velocity: ["avg"] }, by: ["tags_id"] })
  expect(bySeries.map((r) => r.tags_id)).toEqual([1, 2])
})

test("bucket origin and grouping match the engine", async () => {
  const t = lake.table("iot.readings")
  const rows = await t.bucket({
    every: "6h",
    origin: "2026-01-01T02:00:00Z",
    agg: { velocity: ["min", "first", "last"] },
    by: ["tags_id"],
  })
  const expected = fx.sql(
    "SELECT date_bin(INTERVAL '6 hours', time, TIMESTAMP '2026-01-01 02:00:00') AS bucket, tags_id, min(velocity) AS velocity_min, first_value(velocity ORDER BY time) FILTER (WHERE velocity IS NOT NULL) AS velocity_first, last_value(velocity ORDER BY time) FILTER (WHERE velocity IS NOT NULL) AS velocity_last FROM iot.readings GROUP BY 1, 2 ORDER BY 1, 2",
  )
  expect(rows.length).toBe(5 * SERIES)
  const got = rows.map((r) => ({ ...r, bucket: r.bucket.toISOString().replace(".000Z", "Z") }))
  expect(got).toEqual(expected as typeof got)
})

test("unknown aggregates are errors", async () => {
  const agg = { velocity: ["median" as AggOp] }
  await expect(lake.table("iot.readings").bucket({ every: "1h", agg })).rejects.toThrow("unknown variant")
})

test("zod source generation", async () => {
  const src = await lake.table("iot.readings").zodSource()
  expect(src).toContain("export const Reading = z.object({")
  expect(src).toContain("time: z.coerce.date(),")
  expect(zodSource({ name: "iot.devices", schema: [{ id: 1, name: "id", type: "string", required: true }] })).toContain(
    "export const Device",
  )
})

test("tests cannot reach the network", async () => {
  await expect(fetch("https://example.com/")).rejects.toThrow("tests are offline")
})
