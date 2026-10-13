# Codebase cleanup plan (2026-10-13)

The result of a read-only audit of the whole repository: builds, tests, linters, docs against code, and a style review per language (Rust, Python, TypeScript). Nothing below has been changed yet, except the docs (commit `351aebd`). This file goes away when the work is done; the performance plan (SPEC §19.1) starts after it.

**Goal:** code that is clean, clear to a human reader, and written the way each language's community writes it; formatters and linters run on every commit; CI checks every push.

## Where things stand

| Check | Result |
|---|---|
| Rust build and tests (`cargo test --workspace`) | Pass. 7 tests in total: 3 end-to-end, 3 unit tests in `timelake-format`, 1 in the CLI. No tests in the WASM reader. |
| Rust formatting (`cargo fmt --check`) | Fails: about 300 places, because the code is written wider than rustfmt's default. |
| Clippy (default) | 1 warning. With `pedantic`: about 110 unique warnings (mostly missing docs and number casts). |
| Python tests | 1 smoke test, passes. Test dependencies aren't declared anywhere. |
| Python lint/format/types | No tools configured. ruff (strict set): 656 issues in `bench/`. Not formatted. ty: 17 errors. The Python package ships no type information. |
| TypeScript (`tsc`, ESLint) | Clean. oxlint with a recommended config: about 30 warnings. |
| TypeScript client tests | 3 of 6 fail, and the 3 that pass silently read production data over the internet (details in bugs, B14). |
| Go (`go vet`) | Clean. |
| CI | None. Vercel deploys the website on push to `main`; nothing else runs. |

## Decisions needed

| # | Question | Recommendation |
|---|---|---|
| D1 | Pre-commit hook runner | **prek**: a fast Rust rewrite of `pre-commit`, same `.pre-commit-config.yaml` format, installs with `uv tool install prek`, no Python environment needed. Alternatives: `pre-commit` (the original, slower), `lefthook` (Go, popular with JS repos). |
| D2 | Line width | **120 in every language** (rustfmt, ruff, oxfmt). The code is already written that way; it causes the least churn (rustfmt: 112 lines instead of 376 at the default 100). |
| D3 | Python layout | **One uv workspace at the root** with `bench` and `crates/timelake-py` as members, one ruff and ty config. `uv sync` then builds the Python package into the bench environment (today that is a manual `maturin develop`). |
| D4 | Rust workspace | **Move `timelake-py` into the workspace** (one lock file, one target dir, one toolchain file). Keep `timelake-wasm` separate: it needs its own build settings. |
| D5 | Old benchmark scripts | **Move Phase 0 scripts and their results to `bench/archive/`** (they back BASELINE.md, which SPEC cites); delete one-off experiments. |
| D6 | Docs format | **Convert the docs pages to MDX** (Markdown with components). Today 16 pages of prose are written as React code full of `&apos;` and `{" "}`: hard to edit and the biggest source of formatter churn. |
| D7 | `brand/` | Keep it in the repo, but take it out of the bun workspace so Vercel stops installing its dependencies. |

## Phase 1: Tools and hooks

| Language | Format | Lint | Types | Config |
|---|---|---|---|---|
| Rust | rustfmt | clippy, `pedantic` with a few noisy lints allowed | the compiler | `rustfmt.toml` (`style_edition = "2024"`, `max_width = 120`, `use_small_heuristics = "Max"`), `[workspace.lints]` in `Cargo.toml`, `clippy.toml` |
| Python | ruff format | ruff (E, W, F, I, B, UP, SIM, RUF, PTH, N, ANN, D, C4, C90, PL, PT, S, BLE, DTZ, …) | ty | root `pyproject.toml` |
| TypeScript | oxfmt (`semi: false`, width 120) | oxlint (typescript, react, nextjs, import, unicorn plugins) | `tsc --noEmit` | `.oxlintrc.json`, `.oxfmtrc.json`; remove ESLint |
| Go | gofmt | go vet | the compiler | — |

- **Pre-commit hooks** (`.pre-commit-config.yaml`, run by prek): formatters and fast linters on staged files only, so a commit takes seconds. Slow checks (clippy, ty, `tsc`, tests) run in CI and with `prek run --all-files --hook-stage manual`.
- **One reformat commit per language**, listed in `.git-blame-ignore-revs` so `git blame` skips them.
- **One command to check everything locally**, e.g. `bun run check` / `cargo xtask check` or a `justfile`.
- **Rust lint settings** (proposed): `unsafe_code = "forbid"` (deny in py and wasm, whose binding macros need it), `pedantic` warnings with `missing_errors_doc`, `must_use_candidate` and a few other noisy ones allowed; `unwrap_used` and `allow_attributes` warned (use `#[expect(…, reason = "…")]`); `missing_docs` on the two library crates.
- **Python:** full type annotations; Google-style docstrings; `.pyi` stub and `py.typed` for the native module so users get types and completions.
- **TypeScript:** add `noUncheckedIndexedAccess` (18 fixes); type-check the client's tests (they are excluded today).
- Pin tool versions (oxfmt and ty are pre-1.0).

## Phase 2: CI (GitHub Actions, no secrets)

| Job | Runs | Time (cached) |
|---|---|---|
| `rust` | `cargo fmt --check`, `clippy -D warnings`, `cargo test` (workspace incl. the Python crate) | 2–4 min |
| `wasm` | fmt, clippy for `wasm32`, unit tests, check the committed WASM bundle matches its sources (hash) | 1–2 min |
| `python` | `ruff check`, `ruff format --check`, `ty check`, build the package, `pytest`, check the `.pyi` stub against the module | 2–3 min |
| `web` | `oxlint`, `oxfmt --check`, `tsc` (dashboard, client), check `dashboard/data/results` matches `bench/results` | under 1 min |
| `client-test` | CLI build + client tests on a generated fixture, network blocked | about 1 min after `rust` |
| `go` | `gofmt -l`, `go vet` for `bench/tools/s3proxy` | under 1 min |
| optional | `cargo-deny` (licenses, advisories), `cargo-shear` (unused dependencies), `typos` | under 1 min |

Vercel keeps building the website (preview per pull request, production on `main`).

## Phase 3: Bugs

| # | Where | Problem |
|---|---|---|
| B1 | `packages/timelake-client/src/index.ts:300` | A `range`/`bucket` query touching 16+ files hangs: each file holds a concurrency slot while waiting for slots for its own reads. |
| B2 | `crates/timelake/src/ops.rs:122` | If inline maintenance fails after an append committed, the append returns an error; a retry without a batch id writes the data twice. |
| B3 | `crates/timelake-wasm/src/query.rs:327` | Filtering an int column by `1.5` (or a value ≥ 2³²) matches rows equal to 0 (or wrapped values). |
| B4 | `crates/timelake/src/query.rs:203` | `SHOW TABLES` / `information_schema` panics on a single-threaded Tokio runtime (`block_in_place`). |
| B5 | `crates/timelake/src/query.rs:525` | `rn = '1'` (a string) also triggers the latest-row rewrite. |
| B6 | `crates/timelake/src/commit.rs:122` | If writing the manifest or the index fails, files the other one already wrote are left behind. |
| B7 | `crates/timelake-format/src/contract.rs` | Panics on out-of-range timestamps; duration overflow; `"True"` parses as false; `"1 day"` (singular) is rejected. |
| B8 | `crates/timelake-cli/src/main.rs:212` | Several statements are split on `;`, which breaks on `;` inside a string literal. |
| B9 | `crates/timelake/src/query.rs:141` | `Session::latest` builds SQL by hand; a column name containing `"` breaks it. |
| B10 | `crates/timelake-py/src/lib.rs:30` | A bad duration or chunk raises `RuntimeError` instead of `ValueError`. |
| B11 | CLI and Python `append` | A skipped duplicate batch still reports "appended N rows". |
| B12 | client `latest()` and the Explorer | Docs say "falls back to a scan"; the code throws. |
| B13 | `bench/run_all.sh:7` | Deletes every result file, including the ones the website uses. |
| B14 | client tests, `scripts/build-demo-warehouse.sh` | Production and test builds share one output folder; tests need TSBS data, a release CLI and DuckDB, and silently fetch from production. Fix: a small generated fixture, a separate output folder, and no network. |
| B15 | `bench/v0/tsdb_cloud.py:69,114` | A failed export loads partial data silently; the tiering wait can exit at once. |
| B16 | `bench/v0/summarize.py:34` | Keys results by storage, so S3 and S3 Express results overwrite each other. |
| B17 | `dashboard/components/sql-console.tsx:69`, `app/api/sql/route.ts:6` | Unhandled promise; bad JSON returns 500 instead of 400. |
| B18 | `scripts/serve-range.mjs:18` | Path traversal check accepts sibling folders with the same prefix (test server only). |

Each fix comes with a test that fails before it.

## Phase 4: Repository hygiene

- **Remove:** unused dependencies (`tracing` in `timelake`, `chrono` in the CLI); `dashboard/public/*.svg` (create-next-app leftovers); `components/ui/scroll-area.tsx`; unused exports; committed raw logs in `bench/results/*.log`; one-off scripts (`bench/v0/experiment.py`, `live_size.py`, `rerun_timelake.sh`).
- **Move:** Phase 0 runners and comparison scripts with their results to `bench/archive/` (D5). `spikes/iceberg-write` out of the workspace (its question is answered; keep the README for SPEC's link).
- **Align:** one Rust toolchain version (`bench/rust-reader` pins 1.95, the rest 1.94); pin `wasm-bindgen`; make the WASM build work on Linux (no hard-coded Homebrew clang path).
- **Declare:** Python test dependencies; `numpy` and `timelake` in the bench project.
- **Fix:** `.gitignore` (`target/` everywhere, `.env*` with `!.env.example`); `NOTICE` should mention the bundled Geist font (OFL); client `package.json` (`exports` vs `files`, unpinned `@types/bun`).
- **Generated WASM bundle** (`inline.js`, 8 MB, the largest file): keep it committed (Vercel needs no Rust build), add a header with a hash of its sources, and check the hash in CI.

## Phase 5: Idiomatic code

### Rust
1. **One sort and dedup helper.** The same lexsort + tiebreak + "last row per group" logic is written three times (`lvi.rs`, `ops.rs`, `write.rs`).
2. **Typed errors everywhere.** About 20 `map_err(|e| e.to_string())` in the WASM crate; error sources dropped in `storage.rs` and `write.rs`; 7 silently ignored errors (`let _ =`).
3. **Enums instead of strings:** aggregate ops (an unknown op silently returns null), manifest status and content codes, `Chunk` and `TableName` via `FromStr`/`Display`, retention as a `Duration`.
4. **Split long functions and big files:**
   - `try_commit` (118 lines) becomes a `SnapshotWriter` struct;
   - `query.rs` becomes `session`, `catalog`, `provider`, `stats` and `rewrite`;
   - the CLI's `run` becomes one function per command.
5. **One bounded cache type** instead of four `Mutex<HashMap>` copies that clear themselves when full.
6. **Parse names once, at the boundary.** Table names are re-parsed several times per call today.
7. **Fewer serial awaits and clones on hot paths:**
   - loops that await one request at a time;
   - `Table::files()` deep-cloning every file entry on each query;
   - per-row allocations in the WASM aggregator.
8. **A tidier public API:**
   - accessor methods instead of mutable `pub` fields on `Table`;
   - doc comments on the 118 public items that lack them;
   - `#[expect]` instead of `#[allow]`.

### Python
1. Type stub and `py.typed` for the native module; `TypedDict`s for the result dicts.
2. Make `bench` a package: remove the `sys.path.insert` hacks and module-level mutable settings (`global STORAGE`), and pass a small config dataclass.
3. One shared module for the helpers copied across scripts:
   - geometric mean (4 copies);
   - JSONL reading and writing (5 copies);
   - S3 endpoints and keys (repeated in about 10 places).
4. A `System` protocol for the v0 ingest systems (replaces `hasattr` checks).
5. Split `run.main`, `run.setup_duckdb` and `ingest.main`.
6. Move the Python embedded in shell scripts into `.py` files so the tools check it.
7. Use timezone-aware timestamps in result records.

### TypeScript
1. One definition each for bucket sizes, "numeric type" and the formatters (copied in 2–3 places).
2. Share types between server and client code instead of redefining them.
3. Split long components:
   - the Explorer's table page (206 lines);
   - the landing page (352 lines);
   - one shared chart tooltip.
4. Tidy the client:
   - a single request instead of HEAD + GET;
   - shared stats and timing helpers;
   - named constants.
5. Remove the 11 non-null assertions; quote the one unquoted table name in `cli.ts`.

## Phase 6: Tests

- **Rust unit tests:**
  - last-value index edge cases;
  - contract and duration parsing;
  - table names;
  - schema alignment;
  - pruning statistics.
- **Table-driven tests of the latest-row rewrite:** which query shapes should and shouldn't rewrite.
- **Commit conflicts:**
  - compaction vs append;
  - compaction vs compaction;
  - retry limit;
  - batch id across a lost race;
  - no leftover files.
- **WASM reader tests:**
  - footer parsing;
  - range coalescing;
  - filters;
  - bucket math;
  - a manifest written by the engine.
- **A CLI smoke test.**
- **Python:** a few API tests beyond the smoke test.
- Replace brittle `EXPLAIN`-string checks with plan inspection.

## Phase 7: Docs follow-ups

- MDX for the docs pages (D6).
- A Rust API page (`Lake`, `Table`, `Session`, options), once the public API is tidied.
- Regenerate or relabel `V0.md` (RustFS) now that the site shows the AWS runs.

## Order

1. Phase 1 (tools, hooks, reformat commits)
2. Phase 2 (CI)
3. Phase 3 (bugs, each with a test)
4. Phases 4 and 5 (hygiene and idiomatic refactors), then 6 and 7

Phases 1 and 2 make every later change checked automatically. Each phase is one or a few commits, pushed separately.
