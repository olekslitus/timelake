//! `timelake`: create, load, query, and maintain Timelake tables.

mod bench;
mod info;
mod load;

use std::io::{Read, Write};
use std::time::Instant;

use anyhow::Result;
use clap::{Parser, Subcommand, ValueEnum};
use timelake::datafusion::prelude::{DataFrame, SessionConfig};
use timelake::{Lake, MaintainOptions, Session, TableName};

use crate::info::TableInfo;
use crate::load::{LoadArgs, TableDef};

#[derive(Parser)]
#[expect(clippy::doc_markdown, reason = "doc comments are clap help text, shown verbatim")]
#[command(name = "timelake", version, about = "Timelake: the open time-series lakehouse")]
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
    Sql(SqlArgs),
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
#[expect(clippy::doc_markdown, reason = "doc comments are clap help text, shown verbatim")]
struct SqlArgs {
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
}

#[derive(Clone, Copy, ValueEnum)]
enum Format {
    Table,
    Csv,
    Json,
    None,
}

fn parse_kv(s: &str) -> Result<(String, String), String> {
    s.split_once('=')
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .ok_or_else(|| format!("expected key=value, got {s:?}"))
}

#[tokio::main]
async fn main() {
    if let Err(e) = run(Cli::parse()).await {
        eprintln!("Error: {e:#}");
        std::process::exit(1);
    }
}

async fn run(cli: Cli) -> Result<()> {
    let started = Instant::now();
    let lake = Lake::open(&cli.warehouse, cli.options.into_iter().collect())?;
    match cli.cmd {
        Cmd::Create { table, def } => create(&lake, &table, &def).await,
        Cmd::Append { table, files, load } => load::load_files(lake.table(&table).await?, &files, &load).await,
        Cmd::Import { table, files, def, load } => import(&lake, &table, &files, &def, &load).await,
        Cmd::Sql(args) => sql(lake, args, started).await,
        Cmd::Latest { table, format } => print_df(Session::new(lake).latest(&table).await?, format).await,
        Cmd::Maintain { tables, no_compact, no_retention, no_expire } => {
            let opts = MaintainOptions {
                compact: !no_compact,
                retention: !no_retention,
                expire: !no_expire,
                ..Default::default()
            };
            maintain(&lake, tables, opts).await
        }
        Cmd::Info { table, json } => {
            let info = TableInfo::load(&lake.table(&table).await?).await?;
            if json {
                println!("{}", info.to_json());
            } else {
                print!("{info}");
            }
            Ok(())
        }
        Cmd::Ls { json } => ls(&lake, json).await,
        Cmd::Duckdb { table } => duckdb(&lake, &table).await,
        Cmd::Index => {
            let names = lake.write_tables_index().await?;
            println!("indexed {} tables: {}", names.len(), names.join(", "));
            Ok(())
        }
        Cmd::Drop { table } => {
            lake.drop_table(&table).await?;
            println!("dropped {table}");
            Ok(())
        }
    }
}

async fn create(lake: &Lake, table: &str, def: &TableDef) -> Result<()> {
    let schema = def.schema(None).await?;
    let t = lake.create_table(table, &schema, def.options()?).await?;
    println!("created {} at {}", t.name(), t.location());
    Ok(())
}

async fn import(lake: &Lake, table: &str, files: &[String], def: &TableDef, load: &LoadArgs) -> Result<()> {
    let t = match lake.table(table).await {
        Ok(t) => t,
        Err(timelake::Error::NotFound(_)) => {
            let schema = def.schema(files.first().map(String::as_str)).await?;
            let t = lake.create_table(table, &schema, def.options()?).await?;
            eprintln!("created {}", t.name());
            t
        }
        Err(e) => return Err(e.into()),
    };
    load::load_files(t, files, load).await
}

async fn sql(lake: Lake, args: SqlArgs, started: Instant) -> Result<()> {
    let sql = if let Some(q) = args.query {
        q
    } else {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s)?;
        s
    };
    let mut config = SessionConfig::new().with_default_catalog_and_schema("timelake", &args.namespace);
    for (k, v) in &args.settings {
        config = config.set_str(k, v);
    }
    let session = Session::with_config(lake, config);
    if let Some(runs) = args.bench_runs {
        return bench::run(&session, &sql, runs, started.elapsed().as_secs_f64(), args.proxy_admin.as_deref()).await;
    }
    for statement in session.parse(&sql)? {
        print_df(session.execute(statement).await?, args.format).await?;
    }
    Ok(())
}

async fn maintain(lake: &Lake, tables: Vec<String>, opts: MaintainOptions) -> Result<()> {
    // Each table with the name to print: as the user wrote it, or qualified when listing them all.
    let targets: Vec<(TableName, String)> = if tables.is_empty() {
        lake.all_tables().await?.into_iter().map(|name| (name.clone(), name.to_string())).collect()
    } else {
        tables.into_iter().map(|t| Ok((t.parse()?, t))).collect::<timelake::Result<_>>()?
    };
    for (name, label) in targets {
        let (t, r) = lake.table(name).await?.maintain(opts.clone()).await?;
        println!(
            "{label}: compacted {} partitions ({} → {} files, {} rows, {} duplicates removed), dropped {} partitions, expired {} snapshots, deleted {} objects in {:.2}s → v{}",
            r.partitions_compacted,
            r.files_rewritten,
            r.files_written,
            r.rows_rewritten,
            r.duplicates_removed,
            r.partitions_dropped,
            r.snapshots_expired,
            r.objects_deleted,
            r.duration.as_secs_f64(),
            t.version()
        );
    }
    Ok(())
}

async fn ls(lake: &Lake, json: bool) -> Result<()> {
    let names: Vec<String> = lake.all_tables().await?.iter().map(ToString::to_string).collect();
    if json {
        println!("{}", serde_json::to_string(&names)?);
    } else {
        for name in names {
            println!("{name}");
        }
    }
    Ok(())
}

async fn duckdb(lake: &Lake, table: &str) -> Result<()> {
    let t = lake.table(table).await?;
    println!("INSTALL iceberg; LOAD iceberg;");
    if t.location().starts_with("s3://") {
        println!(
            "-- CREATE SECRET (TYPE s3, KEY_ID '…', SECRET '…', REGION '…' [, ENDPOINT '…', URL_STYLE 'path', USE_SSL false]);"
        );
    }
    println!("SELECT * FROM iceberg_scan('{}');", t.location());
    if let Some(lvi) = t.last_value_index() {
        println!("-- newest row per series (Timelake last-value index for v{}):", t.version());
        println!("SELECT * FROM read_parquet('{lvi}');");
    }
    Ok(())
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
        Format::None => {
            writeln!(out, "{} rows", batches.iter().map(timelake::arrow::array::RecordBatch::num_rows).sum::<usize>())?;
        }
    }
    Ok(())
}
