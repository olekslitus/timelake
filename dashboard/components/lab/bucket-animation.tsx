"use client"

import { useEffect, useState } from "react"

/**
 * What the writer does to a bucket, step by step: appends add small files to today's folder, a merge turns them into
 * one sorted file, retention drops the oldest day, and every commit writes new metadata and a new head. The sequence
 * illustrates the mechanism; file names and sizes are made up.
 */
type File = { name: string; kb: number; fresh: boolean }
type Day = { label: string; files: File[] }
type State = { step: number; version: number; days: Day[]; log: string[] }

/** Appends per day before the merge. */
const APPENDS = 4
const KEEP_DAYS = 3
const START = Date.UTC(2026, 9, 13)

const hex = (n: number) => ((n * 2654435761) >>> 0).toString(16).padStart(8, "0")
const dayLabel = (d: number) => new Date(START + d * 86_400_000).toISOString().slice(0, 10)
const file = (version: number, kb: number): File => ({ name: `${hex(version).slice(0, 8)}….parquet`, kb, fresh: true })

function initial(): State {
  const days = [0, 1].map((d) => ({ label: dayLabel(d), files: [{ ...file(d + 3, 46), fresh: false }] }))
  return { step: 0, version: 12, days, log: ["v12  at rest"] }
}

function next(s: State): State {
  const version = s.version + 1
  const phase = s.step % (APPENDS + 1)
  const days = s.days.map((d) => ({ ...d, files: d.files.map((f) => ({ ...f, fresh: false })) }))
  const lines: string[] = []
  if (phase === 0) {
    const label = dayLabel(2 + Math.floor(s.step / (APPENDS + 1)))
    days.push({ label, files: [file(version, 12)] })
    lines.push(`v${version}  append  1,440 rows, new folder ${label}`)
    if (days.length > KEEP_DAYS) lines.push(`v${version}  retention: dropped ${days.shift()?.label}`)
  } else {
    const today = days.at(-1)
    if (today && phase < APPENDS) {
      today.files.push(file(version, 12))
      lines.push(`v${version}  append  1,440 rows`)
    } else if (today) {
      lines.push(`v${version}  merge   ${today.files.length} files → 1, sorted by series and time`)
      today.files = [file(version, 46)]
    }
  }
  return { step: s.step + 1, version, days, log: [...s.log, ...lines].slice(-6) }
}

export function BucketAnimation() {
  const [s, setS] = useState(initial)

  useEffect(() => {
    const id = setInterval(() => setS((cur) => (cur.step >= 3 * (APPENDS + 1) ? initial() : next(cur))), 1300)
    return () => clearInterval(id)
  }, [])

  const tone = (fresh: boolean) => `transition-colors duration-700 ${fresh ? "text-primary" : "text-foreground/80"}`
  const touched = s.step > 0
  return (
    <div className="cells lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <pre className="min-h-[340px] overflow-x-auto p-5 font-mono text-[12px] leading-[1.75]">
        <span className="block text-foreground">s3://my-bucket/lake/iot/readings/</span>
        <span className="block text-foreground">{"  data/"}</span>
        {s.days.map((d) => (
          <span key={d.label} className="block">
            <span className="block text-foreground">{`    time_day=${d.label}/`}</span>
            {d.files.map((f) => (
              <span key={f.name} className={`block ${tone(f.fresh)}`}>
                {`      ${f.name}`.padEnd(30)}
                <span className="text-muted-foreground">{`${f.kb} KB`}</span>
              </span>
            ))}
          </span>
        ))}
        <span className="block text-foreground">{"  metadata/"}</span>
        <span className={`block ${tone(touched)}`}>{`    v${s.version}.metadata.json`}</span>
        <span className={`block ${tone(touched)}`}>
          {"    timelake-head".padEnd(30)}
          <span className="text-muted-foreground">the table in one request</span>
        </span>
        <span className={`block ${tone(touched)}`}>
          {"    lvi-….parquet".padEnd(30)}
          <span className="text-muted-foreground">newest row per series</span>
        </span>
      </pre>
      <div className="flex flex-col gap-3 p-5">
        <div className="label-mono">Writer log</div>
        <pre className="font-mono text-[12px] leading-[1.75] whitespace-pre-wrap text-muted-foreground">
          {s.log.map((l, i) => (
            <span key={`${s.step}-${i}`} className={`block ${i === s.log.length - 1 ? "text-foreground" : ""}`}>
              {l}
            </span>
          ))}
        </pre>
        <p className="mt-auto text-xs text-muted-foreground">
          No job runs this. Appends merge small files of similar size within a day, and retention drops whole days.
        </p>
      </div>
    </div>
  )
}
