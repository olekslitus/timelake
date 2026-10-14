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
          <code>bench/run_aws.sh</code>: the same benchmark against AWS S3 and S3 Tables, from your machine. The buckets come
          from <code>bench/infra</code> (one CloudFormation stack; <code>down.sh</code> deletes it).
        </li>
        <li>
          <code>bench/run.py</code>: the query runner. Each query runs in a fresh process: one first run, then repeats, with
          request and byte counts when going through the proxy.
        </li>
        <li>
          <code>bench/tools/s3proxy</code>: counts requests and bytes. In front of AWS it signs each request for the real
          bucket; in front of a local RustFS it can add a fixed delay per request.
        </li>
        <li>
          <code>bench/queries/</code>: the 12 TSBS IoT queries ported to every engine, and 5 single-device queries.
        </li>
      </ul>
      <pre>{`aws login --profile timelake        # any AWS account; the scripts use us-east-2
bench/infra/up.sh                   # buckets: S3, S3 Express, S3 Tables
bench/run_aws.sh                    # a few hours
uv run python bench/compare_aws.py laptop
bench/infra/down.sh`}</pre>
    </DocPage>
  )
}
