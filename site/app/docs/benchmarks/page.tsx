import type { Metadata } from "next"
import Link from "next/link"

import { DocPage } from "@/components/docs/pager"

export const metadata: Metadata = { title: "Benchmarks (docs)" }

export default function Page() {
  return (
    <DocPage href="/docs/benchmarks">
      <h1>Benchmarks</h1>
      <p>
        The results, charts and methodology are on the <Link href="/benchmarks">Benchmarks page</Link>. The benchmark lives in
        the repository under <code>bench/</code>:
      </p>
      <ul>
        <li>
          <code>bench/v0/</code>: the v0 comparison. <code>ingest.py</code> streams TSBS IoT into Timelake, Lance and PyIceberg
          as 5-minute micro-batches and runs each system’s maintenance; <code>run_queries.sh</code> runs the query suites;{" "}
          <code>summarize.py</code> writes <code>bench/results/V0.md</code>.
        </li>
        <li>
          <code>bench/run.py</code>: the query runner. Each query runs in a fresh process: one first run, then repeats, with
          request and byte counts when going through the latency proxy.
        </li>
        <li>
          <code>bench/tools/s3proxy</code>: a TCP proxy in front of RustFS that adds a fixed delay before each response and
          counts requests and bytes.
        </li>
        <li>
          <code>bench/queries/</code>: the 12 TSBS IoT queries ported to every engine, and 5 single-device queries.
        </li>
      </ul>
      <pre>{`cd bench
for s in iceberg lance timelake; do .venv/bin/python v0/ingest.py --system $s --storage local; done
v0/run_queries.sh local ingested
.venv/bin/python v0/summarize.py > results/V0.md`}</pre>
    </DocPage>
  )
}
