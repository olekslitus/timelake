// Preloaded by bunfig.toml: tests may only talk to the local fixture server, never the network.
const realFetch = globalThis.fetch

globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname !== "127.0.0.1") return Promise.reject(new Error(`tests are offline: refused ${url.href}`))
    return realFetch(input, init)
  },
  { preconnect: realFetch.preconnect },
)
