/** Loads the embedded WebAssembly module once, on first use. */

import { wasmBase64 } from "./wasm/inline.js"
import { initSync } from "./wasm/timelake_wasm.js"

let ready = false

export function ensureWasm(): void {
  if (ready) return
  const bin = atob(wasmBase64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  initSync({ module: bytes })
  ready = true
}
