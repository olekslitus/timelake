"use client"

import { useEffect, useState } from "react"

/** The quick start's session, as timelake 0.4.0 printed it on a local warehouse. */
const SESSION: { cmd: string; out: string }[] = [
  {
    cmd: "timelake import iot.readings readings.csv --time-column time --series-key device_id",
    out: `created iot.readings
  commit 0: 6 rows, 1 files, 0.0 MB, commit 6 ms [0.1s]
iot.readings: appended 6 rows in 1 commits, 0.06s (107 rows/s) → v2`,
  },
  {
    cmd: `timelake sql "SELECT device_id, time_bucket(INTERVAL '10 minutes', time) AS bucket, avg(temp) AS avg_temp FROM iot.readings GROUP BY 1, 2 ORDER BY 1, 2"`,
    out: `+-----------+---------------------+----------+
| device_id | bucket              | avg_temp |
+-----------+---------------------+----------+
| pump-1    | 2026-01-05T10:00:00 | 61.6     |
| pump-1    | 2026-01-05T10:10:00 | 63.1     |
| pump-2    | 2026-01-05T10:00:00 | 59.15    |
| pump-2    | 2026-01-05T10:10:00 | 60.2     |
+-----------+---------------------+----------+`,
  },
  {
    cmd: "timelake latest iot.readings",
    out: `+---------------------+-----------+------+----------+
| time                | device_id | temp | humidity |
+---------------------+-----------+------+----------+
| 2026-01-05T10:10:00 | pump-1    | 63.1 | 41       |
| 2026-01-05T10:10:00 | pump-2    | 60.2 | 44       |
+---------------------+-----------+------+----------+`,
  },
]

const TYPE_MS = 28
const PAUSE_MS = 1800

/** Types each command, prints its real output, and moves on; the whole session loops. */
export function TypedTerminal() {
  const [step, setStep] = useState(0)
  const [typed, setTyped] = useState(0)
  const current = SESSION[step % SESSION.length]
  const cmd = current?.cmd ?? ""
  const done = typed >= cmd.length

  useEffect(() => {
    const entry = SESSION[step % SESSION.length]
    const finished = typed >= (entry?.cmd.length ?? 0)
    const id = finished
      ? setTimeout(
          () => {
            setStep((s) => s + 1)
            setTyped(0)
          },
          PAUSE_MS + (entry?.out.split("\n").length ?? 0) * 120,
        )
      : setTimeout(() => setTyped((t) => t + 1), TYPE_MS)
    return () => clearTimeout(id)
  }, [step, typed])

  return (
    <div className="overflow-hidden rounded-md border bg-card">
      <div className="flex items-center gap-1.5 border-b px-4 py-2.5">
        <span className="size-2 rounded-full bg-border" />
        <span className="size-2 rounded-full bg-border" />
        <span className="size-2 rounded-full bg-border" />
        <span className="ml-3 font-mono text-[11px] text-muted-foreground">~/timelake-demo</span>
      </div>
      <pre className="h-[300px] overflow-hidden p-4 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap">
        <span className="text-primary select-none">$ </span>
        <span className="text-foreground">{cmd.slice(0, typed)}</span>
        {done ? null : <span className="inline-block h-[1.1em] w-[0.55em] translate-y-[0.2em] bg-foreground/70" />}
        {done ? <span className="mt-1 block text-muted-foreground">{current?.out}</span> : null}
      </pre>
    </div>
  )
}
