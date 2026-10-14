import type { Metadata } from "next"
import Link from "next/link"

import { DocPage } from "@/components/docs/pager"

export const metadata: Metadata = { title: "Development" }

export default function Page() {
  return (
    <DocPage href="/docs/development">
      <h1>Development</h1>
      <p>
        How to build, test and run each part of the repository. For what each part is, see the{" "}
        <Link href="/docs/codebase">Codebase tour</Link>.
      </p>

      <h2>Tools to install</h2>
      <table>
        <thead>
          <tr>
            <th>Tool</th>
            <th>Needed for</th>
            <th>Install</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Rust (rustup)</td>
            <td>
              Everything in <code>crates/</code>
            </td>
            <td>
              <code>curl https://sh.rustup.rs -sSf | sh</code>. The version (1.94) is pinned in{" "}
              <code>rust-toolchain.toml</code>; rustup installs it on first use.
            </td>
          </tr>
          <tr>
            <td>uv</td>
            <td>Python package and benchmarks</td>
            <td>
              <code>curl -LsSf https://astral.sh/uv/install.sh | sh</code>
            </td>
          </tr>
          <tr>
            <td>Bun</td>
            <td>Website and TypeScript client</td>
            <td>
              <code>curl -fsSL https://bun.sh/install | bash</code>
            </td>
          </tr>
          <tr>
            <td>Go</td>
            <td>The benchmark proxy only</td>
            <td>
              <code>brew install go</code>
            </td>
          </tr>
          <tr>
            <td>LLVM, wasm-bindgen</td>
            <td>Rebuilding the WASM reader only</td>
            <td>
              <code>brew install llvm</code>, <code>rustup target add wasm32-unknown-unknown</code>,{" "}
              <code>cargo install wasm-bindgen-cli</code>
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Rust: engine and CLI</h2>
      <pre>{`cargo build --release -p timelake-cli        # → target/release/timelake
cargo test --workspace                          # tests
cargo clippy --workspace --all-targets          # lints
cargo fmt --all                                 # formatting`}</pre>
      <p>
        The Cargo workspace (root <code>Cargo.toml</code>) holds <code>timelake</code>, <code>timelake-format</code>,{" "}
        <code>timelake-cli</code> and <code>timelake-py</code>, with one <code>Cargo.lock</code> and one{" "}
        <code>target/</code>. <code>timelake-wasm</code> is built separately for WebAssembly (see below).
      </p>
      <p>Try the CLI on a throwaway warehouse:</p>
      <pre>{`export TIMELAKE_WAREHOUSE=/tmp/tl-dev
target/release/timelake import iot.readings readings.csv --time-column time --series-key device_id
target/release/timelake sql "SELECT count(*) FROM iot.readings"`}</pre>

      <h2>Python package</h2>
      <pre>{`uv sync                                    # at the repo root: builds the package into ./.venv
uv run pytest crates/timelake-py/tests`}</pre>
      <p>
        The root <code>pyproject.toml</code> is a uv workspace with two members: the package (
        <code>crates/timelake-py</code>) and the benchmarks (<code>bench</code>). <code>uv sync</code> and{" "}
        <code>uv run</code> rebuild the native module with maturin whenever Rust sources change. The Python files live
        in <code>python/timelake</code>; the native part is imported as <code>timelake._timelake</code>.
      </p>

      <h2>WASM reader and TypeScript client</h2>
      <pre>{`bun install                                         # at the repo root (bun workspace)
cd packages/timelake-client
bun run build:wasm                                  # after changing crates/timelake-wasm
bun run typecheck`}</pre>
      <p>The client tests compare its answers with the CLI&apos;s, on a demo warehouse served locally:</p>
      <pre>{`cargo build --release -p timelake-cli
scripts/build-demo-warehouse.sh                     # needs the TSBS data in bench/data
bun scripts/serve-range.mjs bench/data/demo-site 4100 &
(cd packages/timelake-client && bun test)`}</pre>

      <h2>Website</h2>
      <pre>{`bun install                       # at the repo root
cd dashboard
bun run dev                       # http://127.0.0.1:3000
bun run lint
bunx tsc --noEmit                 # type check
bun run build                     # production build, as Vercel runs it`}</pre>
      <p>
        Docs pages are plain React files in <code>dashboard/app/(site)/docs/&lt;page&gt;/page.tsx</code>; the sidebar
        order is in <code>dashboard/lib/docs-nav.ts</code>. After re-running benchmarks, copy the results the site uses
        with <code>bun run sync-results</code>.
      </p>
      <p>
        The Explorer runs the local CLI against <code>TIMELAKE_WAREHOUSE</code> (default: the v0 benchmark tables in{" "}
        <code>bench/data</code>). See <code>dashboard/README.md</code> for its settings and the hosted mode.
      </p>

      <h2>Benchmarks</h2>
      <pre>{`uv sync                                       # at the repo root; the same environment as above
cd bench && (cd tools/s3proxy && go build -o ../../.bin/s3proxy .)
uv run python run.py --suite tsbs_iot --engine duckdb --layout sorted`}</pre>
      <p>
        Then follow <code>bench/README.md</code> (query suites and data), <code>bench/v0/README.md</code> (the v0
        comparison) or <code>bench/infra/README.md</code> (AWS). Benchmark data lives in <code>bench/data</code>{" "}
        (git-ignored, several GB).
      </p>

      <h2>Code style</h2>
      <ul>
        <li>
          <strong>Rust:</strong> <code>rustfmt</code> and <code>clippy</code>; errors with <code>thiserror</code> in
          libraries and <code>anyhow</code> in the CLI.
        </li>
        <li>
          <strong>TypeScript:</strong> no semicolons, double quotes, strict TypeScript.
        </li>
        <li>
          <strong>Comments:</strong> explain why, not what. Public items get a doc comment.
        </li>
        <li>
          <strong>Commits:</strong> short imperative subject with the area first, such as <code>bench: …</code>,{" "}
          <code>Site: …</code> or <code>SPEC: …</code>.
        </li>
      </ul>

      <h2>Continuous integration</h2>
      <p>
        Vercel builds and deploys the website on every push to <code>main</code>. There are no automated tests or lint
        checks on pushes yet; run the commands above before pushing. Setting up CI and pre-commit hooks is the next step
        on the roadmap.
      </p>
    </DocPage>
  )
}
