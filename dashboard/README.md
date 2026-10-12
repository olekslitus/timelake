# Timelake dashboard

A small Next.js 16 dashboard for a Timelake warehouse: tables and freshness, per-table layout, snapshots, latest values and a time-series explorer, a read-only SQL console, and the v0 benchmark results.

Stack: Next.js (App Router, Cache Components), React 19, bun, shadcn/ui (Base UI), Tailwind v4, Recharts, lucide icons.

## Run
```bash
cargo build --release -p timelake-cli     # from the repo root; the dashboard calls this binary
cd dashboard
bun install
bun run dev                               # http://127.0.0.1:3000
```

The server reads the lake by running the `timelake` CLI: `ls --json`, `info --json`, `latest`, and `sql --format json`. It needs no database or service of its own.

| Env var | Default | Meaning |
|---|---|---|
| `TIMELAKE_WAREHOUSE` | `../bench/data/v0/local/timelake/lake` (TSBS IoT tables) | Warehouse to browse: local path or `s3://…` |
| `TIMELAKE_OPTIONS` | (none) | Storage options, comma-separated `k=v` (e.g. `aws_endpoint=http://localhost:9000,aws_allow_http=true`) |
| `TIMELAKE_BIN` | `../target/release/timelake` | CLI binary |
| `TIMELAKE_BENCH_RESULTS` | `../bench/results` | Benchmark results for the Benchmarks page |

The SQL console accepts only single read statements (`SELECT`, `WITH`, `EXPLAIN`, `SHOW`, `DESCRIBE`), because DataFusion can write files. The dev and start scripts bind to 127.0.0.1.

## Layout
| Path | What |
|---|---|
| `app/page.tsx` | Overview: totals and the tables list |
| `app/tables/[name]/page.tsx` | Table detail: explore chart, latest values, layout, snapshots |
| `app/sql/page.tsx` | SQL console |
| `app/benchmarks/page.tsx` | v0 benchmark charts and ingest table |
| `app/api/sql`, `app/api/series` | Route handlers used by the console and the chart |
| `lib/timelake.ts` | Server-only wrapper around the CLI |
