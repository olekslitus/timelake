import { readOnlyError } from "@/lib/sql-guard"
import { sql } from "@/lib/timelake"

export async function POST(request: Request) {
  const { query } = (await request.json()) as { query?: string }
  if (!query?.trim()) return Response.json({ error: "Empty query." }, { status: 400 })
  const guard = readOnlyError(query)
  if (guard) return Response.json({ error: guard }, { status: 400 })
  try {
    const { rows, ms } = await sql(query)
    return Response.json({ rows, ms })
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 })
  }
}
