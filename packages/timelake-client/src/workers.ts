/**
 * @timelake/client for Cloudflare Workers and other runtimes that don't compile WebAssembly from
 * bytes at runtime: the same API as the default entry, without the embedded module. Import the
 * module and initialize it once:
 *
 * ```ts
 * import wasm from "@timelake/client/timelake.wasm"
 * import { initWasm, TableWriter, r2Store } from "@timelake/client/workers"
 *
 * initWasm(wasm)
 * ```
 */

export * from "./client.js"
