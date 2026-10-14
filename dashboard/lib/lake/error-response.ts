import "server-only"
import type { z } from "zod"

import { isNotConfigured } from "./errors"

/** A 400 response with an error message, as the Explorer's API routes return them. */
export function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 })
}

/** A 400 response for a request that failed validation: the first issue's message. */
export function invalidRequest(error: z.ZodError): Response {
  return badRequest(error.issues[0]?.message ?? "Invalid request.")
}

/** Maps lake errors to API responses: 503 when not configured, 400 for bad input or failed queries. */
export function errorResponse(e: unknown): Response {
  if (isNotConfigured(e)) return Response.json({ error: e.message, notConfigured: true }, { status: 503 })
  return badRequest(e instanceof Error ? e.message : String(e))
}
