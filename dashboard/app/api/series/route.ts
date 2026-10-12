import { BUCKETS } from "@/lib/buckets"
import { quoteIdent } from "@/lib/sql-guard"
import { sql, tableInfo } from "@/lib/timelake"

const NUMERIC = /^(Int|UInt|Float|Decimal)/

/** One series of a time-series table, bucketed: avg, min, max and count per bucket. */
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams
  const table = p.get("table") ?? ""
  const column = p.get("column") ?? ""
  const bucket = p.get("bucket") ?? "1 hour"
  const series = p.get("series")
  try {
    const info = await tableInfo(table)
    const tc = info.time_column
    const col = info.schema.find((f) => f.name === column && NUMERIC.test(f.type))
    if (!tc || !col) return Response.json({ error: "Pick a numeric column of a time-series table." }, { status: 400 })
    if (!(BUCKETS as readonly string[]).includes(bucket)) return Response.json({ error: "Unknown bucket." }, { status: 400 })

    let where = ""
    const key = info.series_key[0]
    if (key && series !== null && series !== "") {
      const keyType = info.schema.find((f) => f.name === key)?.type ?? ""
      let literal: string
      if (NUMERIC.test(keyType)) {
        if (!Number.isFinite(Number(series))) return Response.json({ error: `${key} must be a number.` }, { status: 400 })
        literal = String(Number(series))
      } else {
        literal = `'${series.replace(/'/g, "''")}'`
      }
      where = `WHERE ${quoteIdent(key)} = ${literal}`
    }
    const c = quoteIdent(column)
    const query =
      `SELECT time_bucket(INTERVAL '${bucket}', ${quoteIdent(tc)}) AS t, avg(${c}) AS avg, min(${c}) AS min, max(${c}) AS max, count(*) AS n\n` +
      `FROM ${info.name}\n${where}\nGROUP BY 1 ORDER BY 1`
    const { rows, ms } = await sql(query)
    return Response.json({ rows, ms, query })
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 })
  }
}
