/** Bucket sizes for the series chart: the label (also the SQL interval) → the TypeScript client's duration. */
export const BUCKETS = {
  "1 minute": "1m",
  "10 minutes": "10m",
  "1 hour": "1h",
  "1 day": "1d",
} as const

export type Bucket = keyof typeof BUCKETS

export const BUCKET_LABELS = Object.keys(BUCKETS) as [Bucket, ...Bucket[]]

export const DEFAULT_BUCKET: Bucket = "1 hour"
