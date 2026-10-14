import { z } from "zod"

import { sql } from "@/lib/lake"
import { badRequest, errorResponse, invalidRequest } from "@/lib/lake/error-response"
import { readOnlyError } from "@/lib/sql"

const SqlRequest = z.object(
  { query: z.string({ error: "Empty query." }).trim().min(1, "Empty query.") },
  { error: 'Send a JSON body: { "query": "SELECT …" }.' },
)

/** Runs one read-only SQL statement. Body: `{ "query": "…" }`. */
export async function POST(request: Request) {
  const body = SqlRequest.safeParse(await request.json().catch(() => null))
  if (!body.success) return invalidRequest(body.error)
  const { query } = body.data
  const guard = readOnlyError(query)
  if (guard) return badRequest(guard)
  try {
    return Response.json(await sql(query))
  } catch (e) {
    return errorResponse(e)
  }
}
