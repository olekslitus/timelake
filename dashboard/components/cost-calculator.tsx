"use client"

import { useState } from "react"

import { BarChart } from "@/components/bar-chart"
import { cn } from "@/lib/utils"

/** List prices (October 2026): S3 Standard storage and requests, and Tiger Cloud's Performance plan. */
const S3 = { gbMonth: 0.023, write: 0.005 / 1000, read: 0.0004 / 1000 }
const TIGER = { computeMonth: 30, gbMonth: 0.177 }
/** Timelake's Parquet for the same data, as a share of TimescaleDB's columnstore (228 MB to 413 MB, TSBS IoT). */
const PARQUET_SHARE = 228 / 413
/** Requests per append (docs: Requests and cost): 7 writes and 2 reads, before maintenance. */
const APPEND = { writes: 7, reads: 2 }
/** Requests per query: about 5 reads, the TSBS IoT queries' first runs after maintenance in the weekly S3 run. */
const QUERY_READS = 5
const DAYS = 30
const SECONDS_A_MONTH = DAYS * 24 * 3600

const SIZES = [
  ["10 GB", 10],
  ["100 GB", 100],
  ["1 TB", 1000],
  ["10 TB", 10000],
] as const
const APPENDS = [
  ["1 s", 1],
  ["10 s", 10],
  ["1 min", 60],
  ["10 min", 600],
] as const
const QUERIES = [
  ["1k", 1e3],
  ["10k", 1e4],
  ["100k", 1e5],
  ["1M", 1e6],
] as const

const usd = (v: number) => (v < 10 ? `$${v.toFixed(2)}` : `$${Math.round(v).toLocaleString("en")}`)

/** A row of options; the chosen one underlined in the saving color. */
function Choice({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: readonly (readonly [string, number])[]
  value: number
  onChange: (v: number) => void
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="w-28 text-muted-foreground">{label}</span>
      {options.map(([name, v]) => (
        <button
          key={name}
          type="button"
          aria-pressed={v === value}
          onClick={() => onChange(v)}
          className={cn(
            "underline-offset-4",
            v === value
              ? "text-foreground underline decoration-(--chart-3) decoration-2"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {name}
        </button>
      ))}
    </div>
  )
}

/**
 * A month of Timelake on S3 against a Tiger Cloud service, for a data size, how often you append, and how many queries
 * a day: Timelake pays for storage and requests, Tiger Cloud for compute and storage (it doesn't charge per request).
 */
export function CostCalculator() {
  const [gb, setGb] = useState<number>(100)
  const [every, setEvery] = useState<number>(10)
  const [perDay, setPerDay] = useState<number>(1e4)

  const lake = {
    storage: gb * PARQUET_SHARE * S3.gbMonth,
    writes: (SECONDS_A_MONTH / every) * (APPEND.writes * S3.write + APPEND.reads * S3.read),
    reads: perDay * DAYS * QUERY_READS * S3.read,
  }
  const tiger = { compute: TIGER.computeMonth, storage: gb * TIGER.gbMonth }
  const [lakeTotal, tigerTotal] = [lake.storage + lake.writes + lake.reads, tiger.compute + tiger.storage]

  return (
    <div className="flex flex-col gap-4 font-mono text-xs">
      <div className="flex flex-col gap-1.5">
        <Choice label="Data" options={SIZES} value={gb} onChange={setGb} />
        <Choice label="Append every" options={APPENDS} value={every} onChange={setEvery} />
        <Choice label="Queries a day" options={QUERIES} value={perDay} onChange={setPerDay} />
      </div>
      <BarChart
        caption="A month at list prices"
        rows={[
          {
            label: "Timelake",
            bars: [{ value: lakeTotal, color: "var(--chart-3)", text: usd(lakeTotal), strong: true }],
          },
          {
            label: "Tiger Cloud",
            bars: [{ value: tigerTotal, color: "var(--muted-foreground)", text: usd(tigerTotal) }],
          },
        ]}
      />
      <div className="flex flex-col gap-1 text-muted-foreground">
        <span>
          Timelake: storage {usd(lake.storage)} · writes {usd(lake.writes)} · reads {usd(lake.reads)}
        </span>
        <span>
          Tiger Cloud: compute {usd(tiger.compute)} (its smallest) · storage {usd(tiger.storage)}
        </span>
      </div>
    </div>
  )
}
