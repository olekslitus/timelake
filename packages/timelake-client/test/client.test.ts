// Reads a generated warehouse over HTTP and checks the results against the Rust engine.
// Needs the CLI: `cargo build -p timelake-cli` at the repo root (or set TIMELAKE_CLI).
import { afterAll, beforeAll, expect, test } from "bun:test"

import { z } from "zod"

import { Lake, readerVersion, zodSource } from "../src/index"
import { buildFixture, POINTS, SERIES, type Fixture } from "./fixture"

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
