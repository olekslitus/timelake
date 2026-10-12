//! `timelake`: create, load, query, and maintain Timelake tables.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::time::Instant;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand, ValueEnum};
use futures::StreamExt;
use timelake::arrow::array::RecordBatch;
use timelake::arrow::datatypes::SchemaRef;
use timelake::datafusion::prelude::{CsvReadOptions, DataFrame, ParquetReadOptions, SessionContext};
use timelake::{AppendOptions, Chunk, Lake, MaintainOptions, Session, TableOptions};

#[derive(Parser)]
#[command(name = "timelake", version, about = "Serverless time-series lake on Apache Iceberg")]
struct Cli {
    /// Warehouse location: s3://bucket/prefix, gs://…, az://…, file:///… or a local path.
    #[arg(short, long, env = "TIMELAKE_WAREHOUSE", global = true, default_value = "./warehouse")]
    warehouse: String,
    /// Storage option, e.g. -o aws_endpoint=http://localhost:9000 -o aws_allow_http=true.
    #[arg(short = 'o', long = "option", value_parser = parse_kv, global = true)]
    options: Vec<(String, String)>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create a table. The schema comes from a Parquet/CSV file (--from) or --schema.
    Create {
        table: String,
        #[command(flatten)]
        def: TableDef,
    },
    /// Append Parquet or CSV files (one commit per --rows-per-commit rows, or per file).
    Append {
        table: String,
        files: Vec<String>,
        #[command(flatten)]
        load: LoadArgs,
    },
    /// Create the table if needed (schema inferred from the first file), then append the files.
    Import {
        table: String,
        files: Vec<String>,
        #[command(flatten)]
        def: TableDef,
        #[command(flatten)]
        load: LoadArgs,
    },
    /// Run SQL (argument or stdin). Tables are `namespace.table`.
    Sql {
        query: Option<String>,
        #[arg(long, value_enum, default_value_t = Format::Table)]
        format: Format,
        /// Default namespace for unqualified table names.
        #[arg(long, default_value = "default")]
        namespace: String,
        /// DataFusion setting, e.g. --set datafusion.execution.target_partitions=32.
        #[arg(long = "set", value_parser = parse_kv)]
        settings: Vec<(String, String)>,
        /// Benchmark mode: run 1 + N times, print {"times": [...], "rows": n} as JSON.
        #[arg(long, hide = true)]
        bench_runs: Option<usize>,
        /// Benchmark mode: s3proxy admin address for request/byte counts.
        #[arg(long, hide = true)]
        proxy_admin: Option<String>,
    },
    /// Newest row of every series.
    Latest {
        table: String,
        #[arg(long, value_enum, default_value_t = Format::Table)]
        format: Format,
    },
    /// Compact, apply retention, expire snapshots. All tables if none given.
    Maintain {
        tables: Vec<String>,
        #[arg(long)]
        no_compact: bool,
        #[arg(long)]
        no_retention: bool,
        #[arg(long)]
        no_expire: bool,
    },
    /// Table details: contract, snapshots, files, partitions.
    Info {
        table: String,
        /// Machine-readable output.
        #[arg(long)]
        json: bool,
    },
    /// List tables.
    Ls {
        /// Machine-readable output.
        #[arg(long)]
        json: bool,
    },
    /// Print the DuckDB SQL that reads a table without Timelake.
    Duckdb { table: String },
    /// Delete a table and all its files.
    Drop { table: String },
    /// Rewrite timelake-tables.json, the table index for readers that cannot list (HTTPS, browsers).
    Index,
}

#[derive(clap::Args)]
struct TableDef {
    /// Take the schema from this Parquet or CSV file.
    #[arg(long)]
    from: Option<String>,
    /// Schema as "name:type,…" (types: int, bigint, double, float, string, bool, date, timestamp, timestamptz).
    #[arg(long)]
    schema: Option<String>,
    /// The time column (makes this a time-series table).
    #[arg(long)]
    time_column: Option<String>,
    /// Columns identifying a series, comma-separated.
    #[arg(long, value_delimiter = ',')]
    series_key: Vec<String>,
    /// Time partition size: hour, day or month (default day).
    #[arg(long)]
    chunk: Option<String>,
    /// Drop data older than this, e.g. 90d.
    #[arg(long)]
    retention: Option<String>,
    /// Disable dedup of identical (series, time) rows during compaction.
    #[arg(long)]
    no_dedup: bool,
    /// Extra table property k=v.
    #[arg(long = "prop", value_parser = parse_kv)]
    props: Vec<(String, String)>,
}

#[derive(clap::Args)]
struct LoadArgs {
    /// Rows per commit (0 = one commit per input file).
    #[arg(long, default_value_t = 10_000_000)]
    rows_per_commit: usize,
    /// Skip inline auto-maintenance.
    #[arg(long)]
    no_maintain: bool,
    /// Idempotency key (suffixed with the commit number).
    #[arg(long)]
    batch_id: Option<String>,
}

#[derive(Clone, Copy, ValueEnum)]
enum Format {
    Table,
    Csv,
    Json,
    None,
}

fn parse_kv(s: &str) -> Result<(String, String), String> {
    s.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())).ok_or_else(|| format!("expected key=value, got {s:?}"))
}

#[tokio::main]
async fn main() {
    if let Err(e) = run(Cli::parse()).await {
        eprintln!("Error: {e:#}");
        std::process::exit(1);
    }
}

async fn run(cli: Cli) -> Result<()> {
    let t0 = Instant::now();
    let lake = Lake::open(&cli.warehouse, cli.options.into_iter().collect())?;
    match cli.cmd {
        Cmd::Create { table, def } => {
            let schema = def_schema(&def, None).await?;
            let t = lake.create_table(&table, &schema, table_options(&def)?).await?;
            println!("created {} at {}", t.name, t.location);
        }
        Cmd::Append { table, files, load } => {
            let t = lake.table(&table).await?;
            load_files(t, &files, &load).await?;
        }
        Cmd::Import { table, files, def, load } => {
            let t = match lake.table(&table).await {
                Ok(t) => t,
                Err(timelake::Error::NotFound(_)) => {
                    let schema = def_schema(&def, files.first().map(String::as_str)).await?;
                    let t = lake.create_table(&table, &schema, table_options(&def)?).await?;
                    eprintln!("created {}", t.name);
                    t
                }
                Err(e) => return Err(e.into()),
            };
            load_files(t, &files, &load).await?;
        }
        Cmd::Sql { query, format, namespace, settings, bench_runs, proxy_admin } => {
            let sql = match query {
                Some(q) => q,
                None => {
                    let mut s = String::new();
                    std::io::stdin().read_to_string(&mut s)?;
                    s
                }
            };
            let mut config = timelake::datafusion::prelude::SessionConfig::new()
                .with_default_catalog_and_schema("timelake", &namespace);
            for (k, v) in &settings {
                config = config.set_str(k, v);
            }
            let session = Session::with_config(lake, config);
            if let Some(runs) = bench_runs {
                return bench(&session, &sql, runs, t0.elapsed().as_secs_f64(), proxy_admin.as_deref()).await;
            }
            for stmt in sql.split(';').map(str::trim).filter(|s| !s.is_empty()) {
                let df = session.sql(stmt).await?;
                print_df(df, format).await?;
            }
        }
        Cmd::Latest { table, format } => {
            let session = Session::new(lake);
            print_df(session.latest(&table).await?, format).await?;
        }
        Cmd::Maintain { tables, no_compact, no_retention, no_expire } => {
            let names = if tables.is_empty() {
                lake.all_tables().await?.into_iter().map(|t| t.to_string()).collect()
            } else {
                tables
            };
            for name in names {
                let t = lake.table(&name).await?;
                let opts = MaintainOptions { compact: !no_compact, retention: !no_retention, expire: !no_expire, ..Default::default() };
                let (t, r) = t.maintain(opts).await?;
                println!(
                    "{name}: compacted {} partitions ({} → {} files, {} rows, {} duplicates removed), dropped {} partitions, expired {} snapshots, deleted {} objects in {:.2}s → v{}",
                    r.partitions_compacted, r.files_rewritten, r.files_written, r.rows_rewritten, r.duplicates_removed,
                    r.partitions_dropped, r.snapshots_expired, r.objects_deleted, r.duration.as_secs_f64(), t.version
                );
            }
        }
        Cmd::Info { table, json: true } => println!("{}", info_json(&lake, &table).await?),
        Cmd::Info { table, json: false } => info(&lake, &table).await?,
        Cmd::Ls { json: true } => {
            let names: Vec<String> = lake.all_tables().await?.into_iter().map(|t| t.to_string()).collect();
            println!("{}", serde_json::to_string(&names)?);
        }
        Cmd::Ls { json: false } => {
            for t in lake.all_tables().await? {
                println!("{t}");
            }
        }
        Cmd::Duckdb { table } => {
            let t = lake.table(&table).await?;
            println!("INSTALL iceberg; LOAD iceberg;");
            if t.location.starts_with("s3://") {
                println!("-- CREATE SECRET (TYPE s3, KEY_ID '…', SECRET '…', REGION '…' [, ENDPOINT '…', URL_STYLE 'path', USE_SSL false]);");
            }
            println!("SELECT * FROM iceberg_scan('{}');", t.location);
            if let Some(lvi) = t.last_value_index() {
                println!("-- newest row per series (Timelake last-value index for v{}):", t.version);
                println!("SELECT * FROM read_parquet('{lvi}');");
            }
        }
        Cmd::Index => {
            let names = lake.write_tables_index().await?;
            println!("indexed {} tables: {}", names.len(), names.join(", "));
        }
        Cmd::Drop { table } => {
            lake.drop_table(&table).await?;
            println!("dropped {table}");
        }
    }
    Ok(())
}

fn table_options(def: &TableDef) -> Result<TableOptions> {
    Ok(TableOptions {
        time_column: def.time_column.clone(),
        series_key: def.series_key.clone(),
        chunk: def.chunk.as_deref().map(Chunk::parse).transpose()?,
        dedup: def.no_dedup.then_some(false),
        retention: def.retention.clone(),
        properties: def.props.iter().cloned().collect(),
    })
}

async fn def_schema(def: &TableDef, fallback_file: Option<&str>) -> Result<SchemaRef> {
    if let Some(s) = &def.schema {
        return parse_schema(s);
    }
    let file = def.from.as_deref().or(fallback_file).context("pass --from <file> or --schema")?;
    let ctx = SessionContext::new();
    let df = read_file(&ctx, file).await?;
    Ok(df.schema().inner().clone())
}

fn parse_schema(s: &str) -> Result<SchemaRef> {
    use timelake::arrow::datatypes::{DataType as T, Field, Schema, TimeUnit};
    let fields = s
        .split(',')
        .map(|f| {
            let (name, ty) = f.trim().split_once(':').with_context(|| format!("expected name:type, got {f:?}"))?;
            let dt = match ty.trim().to_ascii_lowercase().as_str() {
                "int" | "int32" | "integer" => T::Int32,
                "bigint" | "long" | "int64" => T::Int64,
                "double" | "float64" => T::Float64,
                "float" | "float32" | "real" => T::Float32,
                "string" | "text" | "varchar" => T::Utf8,
                "bool" | "boolean" => T::Boolean,
                "date" => T::Date32,
                "timestamp" => T::Timestamp(TimeUnit::Microsecond, None),
                "timestamptz" => T::Timestamp(TimeUnit::Microsecond, Some("+00:00".into())),
                other => bail!("unknown type {other:?}"),
            };
            Ok(Field::new(name.trim(), dt, true))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(std::sync::Arc::new(Schema::new(fields)))
}

async fn read_file(ctx: &SessionContext, path: &str) -> Result<DataFrame> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".csv") || lower.ends_with(".csv.gz") || lower.ends_with(".tsv") {
        let mut o = CsvReadOptions::new().has_header(true);
        if lower.ends_with(".tsv") {
            o = o.delimiter(b'\t').file_extension(".tsv");
        }
        if lower.ends_with(".gz") {
            o = o.file_compression_type(timelake::datafusion::datasource::file_format::file_compression_type::FileCompressionType::GZIP).file_extension(".csv.gz");
        }
        Ok(ctx.read_csv(path, o).await?)
    } else if lower.ends_with(".parquet") || std::path::Path::new(path).is_dir() {
        Ok(ctx.read_parquet(path, ParquetReadOptions::default()).await?)
    } else {
        bail!("unsupported file type: {path} (use .parquet or .csv)")
    }
}

async fn load_files(mut table: timelake::Table, files: &[String], load: &LoadArgs) -> Result<()> {
    if files.is_empty() {
        bail!("no input files");
    }
    let ctx = SessionContext::new();
    let t0 = Instant::now();
    let (mut rows, mut commits) = (0usize, 0usize);
    let mut buf: Vec<RecordBatch> = vec![];
    let mut buffered = 0usize;
    let flush = |table: timelake::Table, buf: Vec<RecordBatch>, n: usize| {
        let opts = AppendOptions {
            batch_id: load.batch_id.as_ref().map(|b| format!("{b}-{n}")),
            maintain: load.no_maintain.then_some(false),
            ..Default::default()
        };
        async move { table.append(&buf, opts).await }
    };
    for file in files {
        let mut stream = read_file(&ctx, file).await?.execute_stream().await?;
        while let Some(b) = stream.next().await {
            let b = b?;
            buffered += b.num_rows();
            buf.push(b);
            if load.rows_per_commit > 0 && buffered >= load.rows_per_commit {
                let (t, r) = flush(table, std::mem::take(&mut buf), commits).await?;
                report(&r, commits, t0);
                (table, rows, commits, buffered) = (t, rows + r.rows, commits + 1, 0);
            }
        }
        if load.rows_per_commit == 0 && buffered > 0 {
            let (t, r) = flush(table, std::mem::take(&mut buf), commits).await?;
            report(&r, commits, t0);
            (table, rows, commits, buffered) = (t, rows + r.rows, commits + 1, 0);
        }
    }
    if buffered > 0 {
        let (t, r) = flush(table, std::mem::take(&mut buf), commits).await?;
        report(&r, commits, t0);
        (table, rows, commits) = (t, rows + r.rows, commits + 1);
    }
    let secs = t0.elapsed().as_secs_f64();
    println!("{}: appended {rows} rows in {commits} commits, {secs:.2}s ({:.0} rows/s) → v{}", table.name, rows as f64 / secs, table.version);
    Ok(())
}

fn report(r: &timelake::AppendResult, n: usize, t0: Instant) {
    let m = r.maintenance.as_ref().map(|m| format!(", compacted {} partitions", m.partitions_compacted)).unwrap_or_default();
    let dup = if r.commit.duplicate { " (duplicate batch, skipped)" } else { "" };
    eprintln!(
        "  commit {n}: {} rows, {} files, {:.1} MB, commit {:.0} ms{m}{dup} [{:.1}s]",
        r.rows,
        r.files,
        r.bytes as f64 / 1e6,
        r.commit.duration.as_secs_f64() * 1000.0,
        t0.elapsed().as_secs_f64()
    );
}

async fn print_df(df: DataFrame, format: Format) -> Result<()> {
    let batches = df.collect().await?;
    let mut out = std::io::stdout().lock();
    match format {
        Format::Table => writeln!(out, "{}", timelake::arrow::util::pretty::pretty_format_batches(&batches)?)?,
        Format::Csv => {
            let mut w = timelake::arrow::csv::Writer::new(out);
            for b in &batches {
                w.write(b)?;
            }
        }
        Format::Json => {
            let mut w = timelake::arrow::json::WriterBuilder::new()
                .with_explicit_nulls(true)
                .build::<_, timelake::arrow::json::writer::LineDelimited>(out);
            for b in &batches {
                w.write(b)?;
            }
            w.finish()?;
        }
        Format::None => writeln!(out, "{} rows", batches.iter().map(|b| b.num_rows()).sum::<usize>())?,
    }
    Ok(())
}

async fn bench(session: &Session, sql: &str, runs: usize, setup_s: f64, proxy: Option<&str>) -> Result<()> {
    let (mut times, mut requests, mut bytes, mut rows) = (vec![], vec![], vec![], 0usize);
    for _ in 0..=runs {
        let before = proxy.map(proxy_stats).transpose()?;
        let t = Instant::now();
        let batches = session.sql(sql).await?.collect().await?;
        times.push(t.elapsed().as_secs_f64());
        rows = batches.iter().map(|b| b.num_rows()).sum();
        if let (Some((r0, b0)), Some(p)) = (before, proxy) {
            let (r1, b1) = proxy_stats(p)?;
            requests.push(r1 - r0);
            bytes.push(b1 - b0);
        }
    }
    let mut out = serde_json::json!({ "times": times, "rows": rows, "setup_s": setup_s });
    if proxy.is_some() {
        out["requests"] = requests.into();
        out["bytes"] = bytes.into();
    }
    println!("{out}");
    Ok(())
}

/// (requests, bytes) counters from tools/s3proxy's admin endpoint.
fn proxy_stats(addr: &str) -> Result<(u64, u64)> {
    let mut s = std::net::TcpStream::connect(addr)?;
    write!(s, "GET /stats HTTP/1.0\r\nHost: {addr}\r\n\r\n")?;
    let mut resp = String::new();
    s.read_to_string(&mut resp)?;
    let body = resp.split("\r\n\r\n").nth(1).context("bad proxy response")?;
    let v: serde_json::Value = serde_json::from_str(body.trim())?;
    Ok((v["requests"].as_u64().unwrap_or(0), v["bytes"].as_u64().unwrap_or(0)))
}

async fn info(lake: &Lake, name: &str) -> Result<()> {
    let t = lake.table(name).await?;
    let files = t.files().await?;
    let c = &t.contract;
    println!("table      {} (v{}, Iceberg {:?})", t.name, t.version, t.metadata.format_version());
    println!("location   {}", t.location);
    if let Some(tc) = &c.time_column {
        println!("time       {tc} (chunk {})", c.chunk.map(|c| c.as_str()).unwrap_or("-"));
        println!("series key {}", if c.series_key.is_empty() { "-".into() } else { c.series_key.join(", ") });
        println!("dedup      {}", c.dedup);
        println!("retention  {}", c.retention.map(|d| format!("{}d", d.as_secs() / 86_400)).unwrap_or("forever".into()));
    } else {
        println!("kind       plain table (no time column)");
    }
    println!("schema     {}", t.schema().fields().iter().map(|f| format!("{} {}", f.name(), f.data_type())).collect::<Vec<_>>().join(", "));
    let rows: u64 = files.iter().map(|f| f.data_file.record_count()).sum();
    let bytes: u64 = files.iter().map(|f| f.data_file.file_size_in_bytes()).sum();
    println!("data       {rows} rows in {} files, {:.1} MB", files.len(), bytes as f64 / 1e6);
    println!("snapshots  {} (manifests in current: {})", t.metadata.snapshots().len(), t.manifests().await?.len());
    println!("last-value {}", t.last_value_index().unwrap_or_else(|| "-".into()));
    let mut parts: HashMap<Option<i32>, (usize, u64, u64)> = HashMap::new();
    for f in &files {
        let e = parts.entry(timelake::file_partition(&f.data_file)).or_default();
        e.0 += 1;
        e.1 += f.data_file.record_count();
        e.2 += f.data_file.file_size_in_bytes();
    }
    let mut parts: Vec<_> = parts.into_iter().collect();
    parts.sort_by_key(|p| p.0);
    if let Some(chunk) = c.chunk {
        println!("partitions {}", parts.len());
        for (p, (n, r, b)) in parts.iter().rev().take(10) {
            let label = p.map(|v| chunk.label(v)).unwrap_or("-".into());
            println!("  {label:<14} {n:>5} files {r:>12} rows {:>10.1} MB", *b as f64 / 1e6);
        }
        if parts.len() > 10 {
            println!("  … {} older", parts.len() - 10);
        }
    }
    Ok(())
}

async fn info_json(lake: &Lake, name: &str) -> Result<serde_json::Value> {
    use serde_json::json;
    let t = lake.table(name).await?;
    let files = t.files().await?;
    let c = &t.contract;
    let mut parts: std::collections::BTreeMap<Option<i32>, (usize, u64, u64)> = Default::default();
    for f in &files {
        let e = parts.entry(timelake::file_partition(&f.data_file)).or_default();
        e.0 += 1;
        e.1 += f.data_file.record_count();
        e.2 += f.data_file.file_size_in_bytes();
    }
    let partitions: Vec<_> = parts
        .iter()
        .rev()
        .map(|(p, (n, r, b))| {
            let label = match (p, c.chunk) {
                (Some(v), Some(chunk)) => chunk.label(*v),
                _ => "-".into(),
            };
            json!({ "partition": label, "files": n, "rows": r, "bytes": b })
        })
        .collect();
    let mut snaps: Vec<_> = t.metadata.snapshots().collect();
    snaps.sort_by_key(|s| std::cmp::Reverse(s.timestamp_ms()));
    let snapshots: Vec<_> = snaps
        .iter()
        .take(50)
        .map(|s| {
            let p = &s.summary().additional_properties;
            let num = |k: &str| p.get(k).and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
            json!({
                "id": s.snapshot_id().to_string(),
                "timestamp_ms": s.timestamp_ms(),
                "operation": format!("{:?}", s.summary().operation).to_lowercase(),
                "added_records": num("added-records"),
                "deleted_records": num("deleted-records"),
                "added_files": num("added-data-files"),
                "deleted_files": num("deleted-data-files"),
                "total_records": num("total-records"),
            })
        })
        .collect();
    Ok(json!({
        "name": t.name.to_string(),
        "version": t.version,
        "location": t.location,
        "format_version": format!("{:?}", t.metadata.format_version()),
        "time_column": c.time_column,
        "series_key": c.series_key,
        "chunk": c.chunk.map(|c| c.as_str()),
        "dedup": c.dedup,
        "retention_days": c.retention.map(|d| d.as_secs() / 86_400),
        "schema": t.schema().fields().iter().map(|f| json!({ "name": f.name(), "type": f.data_type().to_string(), "nullable": f.is_nullable() })).collect::<Vec<_>>(),
        "rows": files.iter().map(|f| f.data_file.record_count()).sum::<u64>(),
        "files": files.len(),
        "bytes": files.iter().map(|f| f.data_file.file_size_in_bytes()).sum::<u64>(),
        "manifests": t.manifests().await?.len(),
        "snapshot_count": t.metadata.snapshots().len(),
        "last_commit_ms": t.current_snapshot().map(|s| s.timestamp_ms()),
        "last_value_index": t.last_value_index(),
        "partitions": partitions,
        "snapshots": snapshots,
    }))
}
