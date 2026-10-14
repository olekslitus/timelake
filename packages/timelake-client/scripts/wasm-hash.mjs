// Prints a SHA-256 over the sources the embedded WASM is built from. build-wasm.sh records it in
// src/wasm/inline.js, and `build-wasm.sh --check` compares: rebuilding to compare bytes wouldn't
// work, since wasm-opt's output differs between hosts.
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "../../..")
const INPUTS = [
  "crates/timelake-wasm/src",
  "crates/timelake-wasm/Cargo.toml",
  "crates/timelake-wasm/Cargo.lock",
  "crates/timelake-wasm/rust-toolchain.toml",
  "crates/timelake-format/src",
]

/** Files under `rel` (or `rel` itself), as sorted repo-relative paths with `/` separators. */
function files(rel) {
  const abs = path.join(ROOT, rel)
  if (!statSync(abs).isDirectory()) return [rel]
  return readdirSync(abs, { recursive: true, encoding: "utf8" })
    .filter((f) => statSync(path.join(abs, f)).isFile())
    .map((f) => `${rel}/${f.split(path.sep).join("/")}`)
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex")
const lines = INPUTS.flatMap(files)
  .toSorted()
  .map((f) => `${sha256(readFileSync(path.join(ROOT, f)))}  ${f}\n`)
console.log(sha256(lines.join("")))
