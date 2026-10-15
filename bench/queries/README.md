# Benchmark queries

| Suite | Source | License |
|---|---|---|
| `tsbs_iot` | Ported from [TSBS](https://github.com/timescale/tsbs) (`cmd/tsbs_generate_queries/databases/timescaledb/iot.go`); porting rules in the file's header | MIT, [LICENSE-tsbs.txt](tsbs_iot/LICENSE-tsbs.txt) |
| `tpch` | [TPC-H](https://www.tpc.org/tpch/) queries 1–22 as shipped in [DuckDB](https://github.com/duckdb/duckdb)'s `tpch` extension | MIT, [LICENSE-duckdb.txt](tpch/LICENSE-duckdb.txt). Results are not TPC-H results. |
| `clickbench` | [ClickBench](https://github.com/ClickHouse/ClickBench) `datafusion-partitioned` and `duckdb-parquet-partitioned`, unchanged | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), not Apache-2.0 |
| `iot_point` | Timelake | Apache-2.0 |

The ClickBench files stay one query per line, because `benchlib.queries` reads them that way, so their credit lives
here and in [NOTICE](../../NOTICE) rather than in a header.
