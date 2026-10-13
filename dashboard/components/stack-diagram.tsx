import { TimelakeMark } from "@/components/brand/timelake-mark";
import { cn } from "@/lib/utils";

/**
 * The stack, left to right: who publishes data, the ingest service, Timelake's layers from the API down to the
 * object store, and who reads. Dashed items are planned; everything else ships today.
 */
const PUBLISHERS = [
  {
    glyph: "((o))",
    title: "Field device",
    what: "PLC · sensor · gateway",
    via: "MQTT",
  },
  {
    glyph: "_/\\_/",
    title: "Market data",
    what: "prices · trades · ticks",
    via: "REST",
  },
  { glyph: "[o_o]", title: "Robot", what: "ROS 2 node", via: "ROS 2 topics" },
  {
    glyph: "[csv]",
    title: "Files & backfill",
    what: "CSV · Parquet · history",
    via: "CLI · Python",
  },
];

const INGEST = [
  "decode, validate",
  "rules → events",
  "buffer, batch",
  "append",
];

type Layer = {
  layer: string;
  tech: string;
  note: string;
  own?: boolean;
  planned?: string;
};

const RUNTIME: Layer[] = [
  {
    layer: "Interfaces",
    tech: "Python · Rust · CLI · TypeScript",
    note: "Arrow in, Arrow out",
  },
  {
    layer: "SQL engine",
    tech: "Apache DataFusion",
    note: "pruning, time_bucket, latest-value rewrite",
  },
  {
    layer: "In memory",
    tech: "Apache Arrow",
    note: "columnar batches, zero-copy",
  },
  {
    layer: "Timelake core",
    tech: "Writer · maintenance · index",
    note: "sort, partition, compact, dedup, retention",
    own: true,
  },
];

const BUCKET: Layer[] = [
  {
    layer: "Catalog",
    tech: "Files, no server",
    note: "put-if-absent commits",
    planned: "REST catalog",
  },
  {
    layer: "Table format",
    tech: "Apache Iceberg",
    note: "snapshots, manifests, column stats",
  },
  {
    layer: "File format",
    tech: "Apache Parquet",
    note: "columnar, ZSTD, sorted by series",
  },
  {
    layer: "Object store",
    tech: "S3 · R2 · GCS · Azure · MinIO · disk",
    note: "the only thing that holds state",
  },
];

const READERS = [
  {
    glyph: "▁▃▆▅",
    title: "Dashboard",
    what: "browser · @timelake/client + WASM",
    via: "HTTPS range reads",
  },
  {
    glyph: " λ ",
    title: "AWS Lambda",
    what: "Python or Rust, any function",
    via: "Timelake SQL",
  },
  {
    glyph: "[≡≡]",
    title: "Trino · Spark · Flink",
    what: "and DuckDB, PyIceberg",
    via: "Iceberg reads",
    planned: "Trino, Flink: REST catalog",
  },
];

function Planned({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-sm border border-dashed px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
      {children}
    </span>
  );
}

function Panel({
  label,
  where,
  className,
  children,
}: {
  label: string;
  where: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col rounded-md border bg-card",
        className,
      )}
    >
      <div className="flex flex-col gap-1 border-b px-4 py-3">
        <div className="label-mono text-primary">{label}</div>
        <div className="font-mono text-xs text-muted-foreground">{where}</div>
      </div>
      {children}
    </div>
  );
}

/** Arrow between panels: right-pointing beside each other (lg), down-pointing when stacked. */
function Wire() {
  return (
    <div aria-hidden className="flex items-center justify-center text-primary">
      <span className="py-2 font-mono text-sm lg:hidden">↓</span>
      <svg
        viewBox="0 0 40 12"
        className="hidden w-full lg:block"
        preserveAspectRatio="none"
      >
        <line
          x1="0"
          y1="6"
          x2="33"
          y2="6"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeDasharray="3 3"
        />
        <path
          d="M32 1.5 L39 6 L32 10.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
        />
      </svg>
    </div>
  );
}

function Endpoint({
  glyph,
  title,
  what,
  via,
  planned,
}: {
  glyph: string;
  title: string;
  what: string;
  via: string;
  planned?: string;
}) {
  return (
    <div className="flex flex-col justify-center bg-card px-4 py-3.5">
      <div className="flex flex-col gap-2 lg:flex-row lg:gap-3">
        <pre
          aria-hidden
          className="ascii w-11 shrink-0 overflow-visible text-[11px] text-primary lg:pt-0.5"
        >
          {glyph}
        </pre>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-sm text-foreground">{title}</div>
          <div className="text-xs text-muted-foreground">{what}</div>
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            <span className="rounded-sm border px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
              {via}
            </span>
            {planned ? <Planned>{planned}</Planned> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function LayerRow({ layer, tech, note, own, planned }: Layer) {
  return (
    <div
      className={cn(
        "grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 px-4 py-2.5",
        own && "bg-primary/[0.06]",
      )}
    >
      <div className={cn("label-mono pt-0.5", own && "text-primary")}>
        {layer}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="text-sm text-foreground">{tech}</div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {note}
          {planned ? <Planned>{planned} · planned</Planned> : null}
        </div>
      </div>
    </div>
  );
}

export function StackDiagram() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_2.25rem_minmax(0,0.8fr)_2.25rem_minmax(0,1.55fr)_2.25rem_minmax(0,1fr)]">
      <Panel label="Publishers" where="anything that makes data">
        <div className="grid flex-1 grid-cols-2 gap-px rounded-b-md bg-border sm:grid-cols-4 lg:auto-rows-fr lg:grid-cols-1">
          {PUBLISHERS.map((p) => (
            <Endpoint key={p.title} {...p} />
          ))}
        </div>
      </Panel>

      <Wire />

      <Panel
        label="Ingest"
        where="Lambda · container · edge"
        className="border-dashed"
      >
        <div className="flex flex-1 flex-col justify-center gap-4 p-4">
          <div className="text-sm text-foreground">timelake-ingest</div>
          <pre className="ascii text-muted-foreground">
            {INGEST.map((s, i) => (
              <span key={s}>
                {i ? "\n  |\n" : ""}
                <span className={i === INGEST.length - 1 ? "hi" : "fg"}>
                  {s}
                </span>
              </span>
            ))}
          </pre>
          <div className="flex flex-col items-start gap-1.5">
            <Planned>planned</Planned>
            <p className="text-xs text-muted-foreground">
              Today: append from Python, Rust or the CLI.
            </p>
          </div>
        </div>
      </Panel>

      <Wire />

      <div className="flex min-w-0 flex-col rounded-md border border-primary/45 bg-card">
        <div className="flex items-center gap-2.5 border-b px-4 py-3">
          <TimelakeMark className="size-5 text-foreground" />
          <div className="flex flex-col gap-0.5">
            <div className="label-mono text-primary">Timelake</div>
            <div className="font-mono text-xs text-muted-foreground">
              a library in your process
            </div>
          </div>
        </div>
        <div className="divide-y">
          {RUNTIME.map((l) => (
            <LayerRow key={l.layer} {...l} />
          ))}
        </div>
        <div className="flex items-center gap-2 border-y border-dashed px-4 py-1.5">
          <span className="font-mono text-[11px] text-primary">↓ ↑</span>
          <span className="label-mono">in your bucket</span>
        </div>
        <div className="divide-y">
          {BUCKET.map((l) => (
            <LayerRow key={l.layer} {...l} />
          ))}
        </div>
      </div>

      <Wire />

      <Panel label="Readers" where="query the same files">
        <div className="grid flex-1 gap-px rounded-b-md bg-border sm:grid-cols-3 lg:auto-rows-fr lg:grid-cols-1">
          {READERS.map((r) => (
            <Endpoint key={r.title} {...r} />
          ))}
        </div>
      </Panel>
    </div>
  );
}
