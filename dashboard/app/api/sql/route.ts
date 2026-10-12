import { sql } from "@/lib/lake"
import { errorResponse } from "@/lib/lake/http"
import { readOnlyError } from "@/lib/sql-guard"

export async function POST(request: Request) {
  const { query } = (await request.json()) as { query?: string }
  if (!query?.trim()) return Response.json({ error: "Empty query." }, { status: 400 })
  const guard = readOnlyError(query)
  if (guard) return Response.json({ error: guard }, { status: 400 })
  try {
    return Response.json(await sql(query))
  } catch (e) {
    return errorResponse(e)
  }
}
