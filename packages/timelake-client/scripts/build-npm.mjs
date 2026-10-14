// Builds the npm package in dist/: the client compiled to JavaScript with type declarations, the
// embedded WASM, and a package.json pointing at them. In this repository the package is used from
// source (src/index.ts); consumers from npm get JavaScript, since Node doesn't strip types in node_modules.
//
//   bun scripts/build-npm.mjs      then: npm publish dist
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const PKG = path.resolve(import.meta.dirname, "..")
const ROOT = path.resolve(PKG, "../..")
const DIST = path.join(PKG, "dist")

rmSync(DIST, { recursive: true, force: true })
execFileSync("bunx", ["tsc", "-p", "tsconfig.build.json"], { cwd: PKG, stdio: "inherit" })

// The WASM glue and the inlined module are already JavaScript with declarations: copy them as they are.
mkdirSync(path.join(DIST, "wasm"), { recursive: true })
for (const file of readdirSync(path.join(PKG, "src/wasm"))) {
  copyFileSync(path.join(PKG, "src/wasm", file), path.join(DIST, "wasm", file))
}
copyFileSync(path.join(PKG, "README.md"), path.join(DIST, "README.md"))
copyFileSync(path.join(ROOT, "LICENSE"), path.join(DIST, "LICENSE"))

const {
  private: _,
  scripts: __,
  devDependencies: ___,
  files: ____,
  ...manifest
} = JSON.parse(readFileSync(path.join(PKG, "package.json"), "utf8"))
manifest.exports = { ".": { types: "./index.d.ts", default: "./index.js" } }
manifest.publishConfig = { access: "public" }
writeFileSync(path.join(DIST, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`built ${manifest.name}@${manifest.version} in dist/`)
