// Builds dist/, what npm installs: the client compiled to JavaScript with type declarations, plus the
// embedded WASM (already JavaScript with declarations, so copied as is). `npm pack` and `npm publish` run it.
// In this repository the client is used from its TypeScript source; Node doesn't strip types in node_modules.
import { execFileSync } from "node:child_process"
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const PKG = path.resolve(import.meta.dirname, "..")
const DIST = path.join(PKG, "dist")

rmSync(DIST, { recursive: true, force: true })
execFileSync("bunx", ["tsc", "-p", "tsconfig.build.json"], { cwd: PKG, stdio: "inherit" })
cpSync(path.join(PKG, "src/wasm"), path.join(DIST, "wasm"), { recursive: true })
// The module as a file, for runtimes that import WebAssembly instead of compiling it from bytes
// (Cloudflare Workers: `import wasm from "@timelake/client/timelake.wasm"`).
const inline = readFileSync(path.join(PKG, "src/wasm/inline.js"), "utf8")
const base64 = /wasmBase64 = "([^"]+)"/.exec(inline)?.[1]
if (!base64) throw new Error("src/wasm/inline.js has no wasmBase64")
writeFileSync(path.join(DIST, "wasm/timelake.wasm"), Buffer.from(base64, "base64"))
cpSync(path.join(PKG, "../../LICENSE"), path.join(DIST, "LICENSE"))
