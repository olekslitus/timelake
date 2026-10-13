/**
 * Where every part of Timelake runs: four places code runs, what each sends to storage, and the bucket's layout.
 * Every box is something that ships today; the one dashed item is planned.
 */
const ZONES = [
  {
    title: "Your process",
    where: "server · laptop · edge gateway · Lambda",
    art: (
      <>
        <span className="fg">python</span> --+ PyO3{"\n"}
        <span className="fg">cli   </span> --+{"\n"}
        <span className="fg">rust  </span> --+{"\n"}
        {"           v\n"}
        <span className="hi">[ timelake core ]</span>
        {"\n  writer    sort, partition,\n            Parquet + index\n  commit    put-if-absent,\n            retry\n  maintain  inline, tiered\n  reader    DataFusion SQL,\n            pruning, index"}
      </>
    ),
    chips: ["Rust", "Apache Arrow", "Apache DataFusion", "Parquet", "object_store", "PyO3"],
    wire: ["PUT data, PUT-if-absent metadata", "GET byte ranges"],
  },
  {
    title: "Scheduled · optional",
    where: "cron · Lambda · K8s CronJob",
    art: (
      <>
        <span className="hi">$ timelake maintain</span>
        {"\n\n  full compaction\n  one sorted file\n  per partition\n  retention\n  snapshot cleanup"}
      </>
    ),
    chips: ["same binary", "stateless"],
    wire: ["GET, PUT rewritten files", "DELETE replaced ones"],
  },
  {
    title: "Browser & edge",
    where: "web apps · Vercel · Workers",
    art: (
      <>
        <span className="fg">@timelake/client</span>
        {"\n  TypeScript, Zod\n        v\n"}
        <span className="hi">[ timelake-wasm ]</span>
        {"\n  metadata, pruning,\n  Parquet decode,\n  latest / range /\n  bucket queries"}
      </>
    ),
    chips: ["Rust → WebAssembly", "TypeScript", "Zod"],
    wire: ["GET byte ranges over HTTPS", "read-only"],
  },
  {
    title: "Other engines",
    where: "the same files, no export",
    art: (
      <>
        <span className="fg">DuckDB   </span> iceberg_scan{"\n"}
        <span className="fg">Spark    </span> Hadoop catalog{"\n"}
        <span className="fg">PyIceberg</span> static table
      </>
    ),
    chips: [],
    planned: "Trino · Athena · Snowflake via a REST catalog (planned)",
    wire: ["GET", "standard Iceberg reads"],
  },
]

export function WhereItRuns() {
  return (
    <div className="overflow-x-auto">
      <div className="cells min-w-[300px] grid-cols-1 md:min-w-[920px] md:grid-cols-[1.25fr_0.85fr_1fr_0.95fr]">
        {ZONES.map((z) => (
          <div key={z.title} className="flex flex-col">
            <div className="flex flex-1 flex-col gap-3 p-5">
              <div className="label-mono text-primary">{z.title}</div>
              <div className="-mt-1 font-mono text-xs text-muted-foreground">{z.where}</div>
              <pre className="ascii text-muted-foreground">{z.art}</pre>
              <div className="mt-auto flex flex-wrap gap-1.5 pt-2">
                {z.chips.map((c) => (
                  <span key={c} className="rounded-sm border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {c}
                  </span>
                ))}
                {z.planned ? (
                  <span className="rounded-sm border border-dashed px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {z.planned}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="flex flex-col gap-0.5 border-t border-dashed px-5 py-3 font-mono text-xs text-muted-foreground">
              <span className="text-primary" aria-hidden>
                ↓ ↑
              </span>
              {z.wire.map((w) => (
                <span key={w}>{w}</span>
              ))}
            </div>
          </div>
        ))}
        <div className="grid gap-6 p-6 md:col-span-4 md:grid-cols-[1fr_auto]">
          <div className="flex min-w-0 flex-col gap-3">
            <div className="label-mono">
              <span className="text-primary">Your bucket</span> · S3, R2, GCS, Azure Blob, MinIO, local disk
            </div>
            <pre className="ascii text-muted-foreground">
              <span className="fg">s3://your-bucket/lake/</span>
              {"\n+-- "}
              <span className="hi">timelake-tables.json</span>
              {" ............ table list for HTTPS readers\n+-- "}
              <span className="fg">iot/readings/</span>
              {"\n    +-- metadata/\n    |   +-- "}
              <span className="hi">v42.metadata.json</span>
              {" ........... schema, contract, snapshots\n    |   +-- "}
              <span className="hi">version-hint.text</span>
              {" ........... newest version, for DuckDB and Spark\n    |   +-- "}
              <span className="hi">snap-*.avro</span>
              {" ................. manifest list\n    |   +-- "}
              <span className="hi">*-m.avro</span>
              {" .................... manifests: column stats per file\n    |   +-- "}
              <span className="hi">lvi-*.parquet</span>
              {" ............... last-value index\n    +-- data/time_day=2026-10-12/\n        +-- "}
              <span className="hi">*.parquet</span>
              {" ................... sorted by (series, time), ZSTD"}
            </pre>
          </div>
          <div className="flex max-w-xs flex-col gap-2">
            <div className="label-mono">No catalog server</div>
            <p className="text-sm text-muted-foreground">
              A commit is one conditional write of the next <code className="font-mono text-[0.85em]">vN.metadata.json</code>.
              Two writers can&apos;t both win, so there is no lock service and no database.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
