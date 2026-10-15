/**
 * Public benchmarks we know of, and where Timelake stands with each (SPEC §17.7). Keep in sync with SPEC.md.
 */

export type PublicBenchmark = {
  name: string
  url: string
  measures: string
  status: "running" | "planned" | "not planned"
  why: string
}

export const PUBLIC_BENCHMARKS: PublicBenchmark[] = [
  {
    name: "TSBS IoT",
    url: "https://github.com/timescale/tsbs",
    measures: "A truck fleet's readings and diagnostics; 12 queries",
    status: "running",
    why: "Our base workload. Its data generator and queries are what time-series databases publish numbers for.",
  },
  {
    name: "TSBS DevOps",
    url: "https://github.com/timescale/tsbs",
    measures: "Server metrics, 100 per host; 15 queries",
    status: "planned",
    why: "The TSBS use case most databases report. Same generator as TSBS IoT, so it's next.",
  },
  {
    name: "ClickBench",
    url: "https://benchmark.clickhouse.com",
    measures: "One wide table, 43 analytics queries",
    status: "planned",
    why: "We run a 10% subset during development. Comparable numbers need the full dataset on its reference machine.",
  },
  {
    name: "RTABench",
    url: "https://rtabench.com",
    measures: "Orders and events: selective lookups, joins, pre-aggregates",
    status: "planned",
    why: "Close to fresh-data dashboards. Its pre-aggregate queries wait for rollups.",
  },
  {
    name: "TSM-Bench",
    url: "https://github.com/eXascaleInfolab/TSM-Bench",
    measures: "Sensor data: 7 query types, queries while ingesting, compression",
    status: "planned",
    why: "Its query templates and online mode fit. The code has no license yet; we're asking the authors.",
  },
  {
    name: "IoT-benchmark (Apache IoTDB)",
    url: "https://github.com/thulab/iot-benchmark",
    measures: "Batched writes, out-of-order data, 12 query types, read/write mixes",
    status: "planned",
    why: "The best tool for mixed reads and writes. Its adapters talk to a server, so it waits for Timelake's server mode.",
  },
  {
    name: "LST-Bench",
    url: "https://github.com/microsoft/lst-bench",
    measures: "How table formats slow down over many writes and maintenance rounds",
    status: "planned",
    why: "We use its method, not its TPC-DS workload: rounds of appends and compaction on our own data.",
  },
  {
    name: "TS-Benchmark",
    url: "https://github.com/dbiir/TS-Benchmark",
    measures: "Wind-farm sensor data; loading, appends and 5 queries",
    status: "not planned",
    why: "Unmaintained since 2022, and its 5 queries are covered by the workloads above.",
  },
  {
    name: "TSDBBench",
    url: "https://tsdbbench.github.io",
    measures: "YCSB-style inserts and range scans on time-series databases",
    status: "not planned",
    why: "Unmaintained since 2019; the systems it compares have moved on.",
  },
  {
    name: "TPCx-IoT",
    url: "https://www.tpc.org/tpcx-iot",
    measures: "Ingest throughput of 1 KB sensor records",
    status: "not planned",
    why: "TPC rules allow only audited results to be published, and its key-value records don't suit columnar files.",
  },
  {
    name: "STAC-M3",
    url: "https://www.stacresearch.com/m3",
    measures: "Financial tick data analytics",
    status: "not planned",
    why: "Closed to members, with paid audits.",
  },
  {
    name: "TSRBench",
    url: "https://tsrbench.github.io",
    measures: "How well AI models reason about time series",
    status: "not planned",
    why: "It pastes the series into the prompt, so storage plays no part. We're planning our own benchmark for AI agents that query the data themselves.",
  },
]
