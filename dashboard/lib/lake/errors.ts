/** The explorer has no lake to read (no CLI binary or warehouse here, e.g. on a hosted deploy). */
export class LakeNotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LakeNotConfiguredError"
  }
}

export function isNotConfigured(e: unknown): e is LakeNotConfiguredError {
  return e instanceof Error && e.name === "LakeNotConfiguredError"
}

/** A caller-facing error (bad input); API routes return it as 400. */
export class LakeInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LakeInputError"
  }
}
