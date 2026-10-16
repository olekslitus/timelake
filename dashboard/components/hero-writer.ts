/**
 * The writer the hero charts show: points collect in memory, a full batch is committed as a small file in today's
 * partition, files of one size merge into one four times bigger (size-tiered compaction), and at the end of a day its
 * files become one sorted file while the oldest day is dropped.
 */

/** Points buffered in memory before a commit writes them as a file. */
export const BATCH = 8
/** Files of one size that merge into one four times bigger. */
export const TIER = 4
/** Commits in a day; then the day's files become one sorted file. */
export const DAY = 32
/** Days kept; older ones are dropped by retention. */
export const DAYS = 3
/** The first "today", for partition names. */
const FIRST_DAY = Date.UTC(2026, 9, 16)

/** A file's size, in commits' worth of points; a day's single sorted file is `sorted`. */
export type File = { size: number; sorted?: boolean }

/** Columns a file takes in the pictures: bigger tiers are wider, a day's sorted file widest. */
export const widthOf = (f: File) => (f.sorted ? 18 : f.size >= TIER * TIER ? 10 : f.size >= TIER ? 4 : 2)

/**
 * Merges TIER files of one size into one file TIER times bigger, from the smallest size up. A merge only makes a
 * bigger file, so one pass upward catches every cascade.
 */
export function compact(files: File[]): { files: File[]; merged: boolean } {
  let merged = false
  for (let size = 1; files.some((f) => !f.sorted && f.size >= size); size *= TIER) {
    const group = files.filter((f) => !f.sorted && f.size === size).slice(0, TIER)
    if (group.length < TIER) continue
    const at = files.indexOf(group[0] as File)
    files = files.filter((f) => !group.includes(f))
    files.splice(at, 0, { size: size * TIER })
    merged = true
  }
  return { files, merged }
}

export class Writer {
  /** Points in memory, the table version, commits so far today, and the last thing the writer did. */
  buffered = 3
  version = 41
  commitsToday = 9
  event = "commit"
  /** The newest file, drawn brighter. */
  fresh: File | null = null
  /** Each day's files, today first. */
  days: File[][] = [
    [{ size: 4 }, { size: 4 }, { size: 1 }],
    [{ size: DAY, sorted: true }],
    [{ size: DAY, sorted: true }],
  ]
  /** Days rolled over so far, for partition names. */
  rolled = 0

  /** Takes one point; returns true when it caused a commit. */
  write(): boolean {
    if (++this.buffered < BATCH) return false
    this.buffered = 0
    this.version++
    let fresh: File = { size: 1 }
    const today = [...(this.days[0] ?? []), fresh]
    const { files, merged } = compact(today)
    if (merged) fresh = files.find((f) => !today.includes(f)) ?? fresh
    this.event = merged ? "merge" : "commit"
    this.days = [files, ...this.days.slice(1)]
    if (++this.commitsToday === DAY) {
      this.commitsToday = 0
      this.version++
      this.rolled++
      this.event = "sorted"
      fresh = { size: DAY, sorted: true }
      this.days = [[], [fresh], ...this.days.slice(1)].slice(0, DAYS)
    }
    this.fresh = fresh
    return true
  }

  /** A day's partition name, e.g. time_day=10-16. */
  partition(d: number): string {
    return `time_day=${new Date(FIRST_DAY + (this.rolled - d) * 86_400_000).toISOString().slice(5, 10)}`
  }
}
