import { series } from "@/lib/lake"
import { errorResponse } from "@/lib/lake/http"

/** One series of a time-series table, bucketed: avg, min, max and count per bucket. */
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams
  try {
    return Response.json(
      await series({
        table: p.get("table") ?? "",
        column: p.get("column") ?? "",
        bucket: p.get("bucket") ?? "1 hour",
        series: p.get("series"),
      }),
    )
  } catch (e) {
    return errorResponse(e)
  }
}
