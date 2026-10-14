// Builds dist/, what npm installs: the client compiled to JavaScript with type declarations, plus the
// embedded WASM (already JavaScript with declarations, so copied as is). `npm pack` and `npm publish` run it.
// In this repository the client is used from its TypeScript source; Node doesn't strip types in node_modules.
import { execFileSync } from "node:child_process"
import { cpSync, rmSync } from "node:fs"
import path from "node:path"

const PKG = path.resolve(import.meta.dirname, "..")
const DIST = path.join(PKG, "dist")

rmSync(DIST, { recursive: true, force: true })
execFileSync("bunx", ["tsc", "-p", "tsconfig.build.json"], { cwd: PKG, stdio: "inherit" })
cpSync(path.join(PKG, "src/wasm"), path.join(DIST, "wasm"), { recursive: true })
cpSync(path.join(PKG, "../../LICENSE"), path.join(DIST, "LICENSE"))
