/** What moving your data to another tool takes, per system, from each vendor's docs (October 2026). */
const SYSTEMS = [
  {
    name: "Timelake",
    color: "var(--chart-3)",
    text: "Nothing to move: the files are already in your bucket, and DuckDB and Spark read them in place.",
  },
  {
    name: "Tiger Cloud",
    color: "var(--muted-foreground)",
    text: "Tiered data can be queried but not modified, and Tiger documents no way to read its files directly. Leaving means reading every row back through Postgres.",
  },
  {
    name: "Snowflake",
    color: "var(--muted-foreground)",
    text: "Standard tables are in Snowflake’s own format. Leaving means unloading them with COPY INTO, paying for warehouse time, and per byte to another region or cloud.",
  },
]

/** A small table: each system, marked in its color, and what leaving it takes. */
export function MoveOut() {
  return (
    <div className="flex flex-col gap-3 font-mono text-xs">
      <span className="text-muted-foreground">Moving your data to another tool</span>
      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5">
        {SYSTEMS.map((s) => (
          <div key={s.name} className="contents">
            <span className="flex items-baseline gap-1.5 whitespace-nowrap">
              <span className="inline-block size-[7px]" style={{ backgroundColor: s.color }} />
              {s.name}
            </span>
            <span className="leading-relaxed text-muted-foreground">{s.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
