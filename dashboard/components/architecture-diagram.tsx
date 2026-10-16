/**
 * How data flows through Timelake. Drawn with theme tokens so it reads in light and dark mode.
 * Boxes: writers → Timelake writer → object storage (Iceberg layout) ← maintenance; readers on the right.
 * Framed, and scrolls sideways on narrow screens.
 */
export function ArchitectureDiagram() {
  const box = "fill-card stroke-border"
  const label = "fill-foreground text-[13px] font-medium"
  const sub = "fill-muted-foreground text-[11px]"
  const mono = "fill-muted-foreground font-mono text-[11px]"
  const accent = "fill-[var(--chart-1)]"
  return (
    <div className="not-prose my-6 overflow-x-auto rounded-lg border p-4">
      <svg
        viewBox="0 0 960 420"
        role="img"
        aria-labelledby="arch-title arch-desc"
        className="h-auto w-full min-w-[720px]"
      >
        <title id="arch-title">Timelake architecture</title>
        <desc id="arch-desc">
          Applications append Arrow data through the Timelake writer, which sorts, partitions, and commits Parquet files
          and Iceberg metadata to object storage. Maintenance compacts and expires in place. The Timelake reader and
          plain engines such as DuckDB read the same tables.
        </desc>
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" className="fill-muted-foreground" />
          </marker>
        </defs>

        {/* Writers */}
        <rect x="10" y="40" width="170" height="150" rx="10" className={box} />
        <text x="26" y="66" className={label}>
          Your apps
        </text>
        <text x="26" y="90" className={sub}>
          Python · CLI · Rust
        </text>
        <text x="26" y="110" className={sub}>
          CSV / Parquet import
        </text>
        <text x="26" y="130" className={sub}>
          Lambda / container
        </text>
        <text x="26" y="166" className={mono}>
          table.append(batch)
        </text>

        {/* Writer */}
        <rect
          x="230"
          y="40"
          width="210"
          height="150"
          rx="10"
          className="fill-card stroke-[var(--chart-1)]"
          strokeWidth={1.5}
        />
        <text x="246" y="66" className={label}>
          Timelake writer
        </text>
        <text x="246" y="90" className={sub}>
          align to schema
        </text>
        <text x="246" y="110" className={sub}>
          sort by (series, time)
        </text>
        <text x="246" y="130" className={sub}>
          split by time partition
        </text>
        <text x="246" y="150" className={sub}>
          Parquet + last-value index
        </text>
        <text x="246" y="170" className={sub}>
          commit: put-if-absent
        </text>

        {/* Storage */}
        <rect x="490" y="20" width="250" height="380" rx="12" className="fill-muted/40 stroke-border" />
        <text x="508" y="46" className={label}>
          Object storage
        </text>
        <text x="508" y="66" className={sub}>
          S3 &amp; compatible · GCS · Azure · disk
        </text>
        <rect x="506" y="82" width="218" height="300" rx="8" className={box} />
        <text x="520" y="104" className={label}>
          Iceberg table
        </text>
        <text x="520" y="128" className={mono}>
          metadata/
        </text>
        <text x="532" y="146" className={mono}>
          v42.metadata.json
        </text>
        <text x="532" y="164" className={mono}>
          version-hint.text
        </text>
        <text x="532" y="182" className={mono}>
          snap-….avro, …-m.avro
        </text>
        <text x="532" y="200" className={mono}>
          lvi-….parquet
        </text>
        <text x="520" y="226" className={mono}>
          data/
        </text>
        <text x="532" y="244" className={mono}>
          time_day=2026-01-01/
        </text>
        <text x="532" y="262" className={mono}>
          time_day=2026-01-02/
        </text>
        <text x="532" y="280" className={mono}>
          time_day=2026-01-03/
        </text>
        <rect x="520" y="300" width="190" height="66" rx="6" className="fill-muted/60" />
        <text x="532" y="322" className={sub}>
          sorted Parquet, page index,
        </text>
        <text x="532" y="340" className={sub}>
          ZSTD, 1M-row row groups
        </text>
        <circle cx="700" cy="104" r="5" className={accent} />

        {/* Maintenance */}
        <rect x="230" y="240" width="210" height="140" rx="10" className={box} />
        <text x="246" y="266" className={label}>
          Maintenance
        </text>
        <text x="246" y="290" className={sub}>
          inline after appends, or
        </text>
        <text x="246" y="308" className={mono}>
          timelake maintain
        </text>
        <text x="246" y="330" className={sub}>
          compaction + dedup
        </text>
        <text x="246" y="348" className={sub}>
          retention
        </text>
        <text x="246" y="366" className={sub}>
          snapshot expiry + cleanup
        </text>

        {/* Readers */}
        <rect
          x="790"
          y="40"
          width="160"
          height="150"
          rx="10"
          className="fill-card stroke-[var(--chart-1)]"
          strokeWidth={1.5}
        />
        <text x="806" y="66" className={label}>
          Timelake reader
        </text>
        <text x="806" y="90" className={sub}>
          DataFusion
        </text>
        <text x="806" y="110" className={sub}>
          file pruning
        </text>
        <text x="806" y="130" className={sub}>
          latest-row rewrite
        </text>
        <text x="806" y="150" className={sub}>
          metadata prefetch
        </text>
        <text x="806" y="170" className={sub}>
          time_bucket()
        </text>

        <rect x="790" y="240" width="160" height="140" rx="10" className={box} />
        <text x="806" y="266" className={label}>
          Plain engines
        </text>
        <text x="806" y="290" className={sub}>
          DuckDB iceberg_scan
        </text>
        <text x="806" y="310" className={sub}>
          Hadoop-catalog layout
        </text>
        <text x="806" y="330" className={sub}>
          (vN.metadata.json)
        </text>
        <text x="806" y="356" className={sub}>
          no Timelake software
        </text>

        {/* Arrows */}
        <g className="stroke-muted-foreground" strokeWidth={1.5} fill="none" markerEnd="url(#arrow)">
          <path d="M180 115 H226" />
          <path d="M440 115 H502" />
          <path d="M440 300 H502" />
          <path d="M506 330 H444" />
          <path d="M740 115 H786" />
          <path d="M740 310 H786" />
        </g>
        <text x="446" y="106" className={sub}>
          commit
        </text>
        <text x="446" y="292" className={sub}>
          rewrite
        </text>
        <text x="748" y="106" className={sub}>
          read
        </text>
        <text x="748" y="302" className={sub}>
          read
        </text>
      </svg>
    </div>
  )
}
