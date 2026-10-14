// bun test scripts
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { createRangeServer } from "./serve-range.mjs"

const dir = mkdtempSync(path.join(tmpdir(), "serve-range-"))
const root = path.join(dir, "site")
let server
let base

beforeAll(async () => {
  mkdirSync(root)
  writeFileSync(path.join(root, "data.txt"), "0123456789")
  // A sibling folder whose name starts with the root's name.
  mkdirSync(`${root}-secret`)
  writeFileSync(path.join(`${root}-secret`, "key.txt"), "secret")
  server = createRangeServer(root)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

test("serves byte ranges", async () => {
  const r = await fetch(`${base}/data.txt`, { headers: { Range: "bytes=2-4" } })
  expect(r.status).toBe(206)
  expect(r.headers.get("content-range")).toBe("bytes 2-4/10")
  expect(await r.text()).toBe("234")
  const suffix = await fetch(`${base}/data.txt`, { headers: { Range: "bytes=-3" } })
  expect(await suffix.text()).toBe("789")
  expect((await fetch(`${base}/data.txt`, { headers: { Range: "bytes=20-" } })).status).toBe(416)
})

test("rejects paths outside the root, including same-prefix siblings", async () => {
  const name = path.basename(root)
  expect((await fetch(`${base}/..%2F${name}-secret%2Fkey.txt`)).status).toBe(403)
  expect((await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`)).status).toBe(403)
})
