import { z } from "zod"

import { BUCKET_LABELS, DEFAULT_BUCKET } from "@/lib/buckets"
import { series } from "@/lib/lake"
import { errorResponse, invalidRequest } from "@/lib/lake/error-response"

const NO_COLUMN = "Pick a numeric column of a time-series table."

const SeriesParams = z.object({
  table: z.string({ error: "Missing table." }).min(1, "Missing table."),
  column: z.string({ error: NO_COLUMN }).min(1, NO_COLUMN),
  bucket: z.enum(BUCKET_LABELS, { error: "Unknown bucket." }).default(DEFAULT_BUCKET),
  series: z
    .string()
    .optional()
    .transform((s) => s || null),
})

/** One series of a time-series table, bucketed: avg, min, max and count per bucket. */
export async function GET(request: Request) {
  const params = SeriesParams.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!params.success) return invalidRequest(params.error)
  try {
    return Response.json(await series(params.data))
  } catch (e) {
    return errorResponse(e)
  }
}
