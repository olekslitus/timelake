/**
 * Loading the WebAssembly module, once. The default entry embeds it and compiles it on first use;
 * runtimes that don't compile WebAssembly from bytes at runtime (Cloudflare Workers) import the
 * `.wasm` file as a module and pass it to {@link initWasm} instead (the `workers` entry).
 */

import { initSync } from "./wasm/timelake_wasm.js"

let ready = false
let embedded: (() => Uint8Array) | undefined

/** Initializes the module from a compiled `WebAssembly.Module` (or its bytes). Later calls do nothing. */
export function initWasm(module: WebAssembly.Module | BufferSource): void {
  if (ready) return
  initSync({ module })
  ready = true
}

/** Registers the embedded module, compiled on first use if {@link initWasm} wasn't called. */
export function setEmbedded(load: () => Uint8Array): void {
  embedded = load
}

export function ensureWasm(): void {
  if (ready) return
  if (!embedded) {
    throw new Error(
      'Timelake WebAssembly not loaded: import wasm from "@timelake/client/timelake.wasm" and call initWasm(wasm) first',
    )
  }
  initWasm(embedded())
}
