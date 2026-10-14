# Agent instructions

Timelake: an open time-series lakehouse. A Rust engine (`crates/timelake`) writes and queries Apache Iceberg + Parquet
tables on object storage. Around it: a CLI, Python bindings, a WebAssembly reader with a TypeScript client, a
Next.js website (`dashboard/`) and benchmarks (`bench/`).

## Before changing code

- Follow [CONTRIBUTING.md](CONTRIBUTING.md). It is the code guide, and it applies to you.
- For anything beyond a small fix, check [SPEC.md](SPEC.md) and the docs (`dashboard/app/(site)/docs/*/page.mdx`).
  Agree on the design with the user before building something new.

## Rules

- **Done means checked.** Before you report work as finished, run
  `prek run --all-files --hook-stage pre-push` and the tests for what you touched (commands in CONTRIBUTING.md,
  "Checks"). Report failures as failures.
- **Fix the code, not the checks.** Don't loosen lint, type or format configs. Don't add `#[allow]`, `noqa`,
  `type: ignore` or `oxlint-disable` to get a check passing. Use `#[expect(..., reason = "...")]` or a targeted ignore
  with a reason only when the tool is genuinely wrong.
- **Keep things in sync:** a change in behaviour updates the docs, the tests and `CHANGELOG.md` (under `Unreleased`) in
  the same commit. A change to the Python bindings updates `_timelake.pyi`. A change to `timelake-wasm` or
  `timelake-format` gets a rebuilt WASM bundle (`bun run build:wasm` in `packages/timelake-client`).
  A change to the plan in SPEC.md (§19, §21) updates the public roadmap, `dashboard/lib/roadmap.ts`.
- **Don't run Prettier or ESLint.** Formatting is oxfmt, linting oxlint, Python ruff, Rust rustfmt and clippy.
- **Never commit secrets** or `.env*` files. Don't touch AWS, Vercel settings, Docker containers or other services
  unless asked.
- **Tests run offline.** No network, AWS or benchmark data in tests.
- **Disk space is limited.** Use debug builds unless you need release.

## Commands

```bash
uv sync && bun install                    # environments: ./.venv (builds the Python package), node_modules
cargo build --release -p timelake-cli     # → target/release/timelake
cargo test --workspace                    # Rust tests
uv run pytest crates/timelake-py/tests    # Python package tests (and: uv run pytest bench/tests)
bun run check                             # oxlint, oxfmt --check, tsc for all TypeScript
cd dashboard && bun run dev               # website on http://127.0.0.1:3000
```
