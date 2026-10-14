import "server-only"
import { isNotConfigured } from "./errors"

/** Maps lake errors to API responses: 503 when not configured, 400 for bad input or failed queries. */
export function errorResponse(e: unknown): Response {
  if (isNotConfigured(e)) return Response.json({ error: e.message, notConfigured: true }, { status: 503 })
  const message = e instanceof Error ? e.message : String(e)
  return Response.json({ error: message }, { status: 400 })
}
