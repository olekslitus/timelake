export const BUCKETS = ["1 minute", "10 minutes", "1 hour", "1 day"] as const
export type Bucket = (typeof BUCKETS)[number]
