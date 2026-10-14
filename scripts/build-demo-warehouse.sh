#!/usr/bin/env bash
# Builds the public demo warehouse: a slice of TSBS IoT (50 trucks × 3 days, ~1.2M rows per table)
# written as Timelake tables whose metadata already points at the URL they will be served from.
#
#   scripts/build-demo-warehouse.sh https://<store-id>.public.blob.vercel-storage.com/demo
#   scripts/build-demo-warehouse.sh http://127.0.0.1:4100/demo          # local testing (default)
#
# Output: bench/data/demo-site/<files to upload, paths relative to the URL origin>
# Then upload with `bun run upload-demo` in dashboard/ (Vercel Blob) or any static host with Range support.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE_URL=${1:-http://127.0.0.1:4100/demo}
OUT=bench/data/demo-site
SRC=bench/data/tsbs/parquet
TL=target/release/timelake
TRUCKS=${TRUCKS:-50}
[ -x "$TL" ] || cargo build --release -p timelake-cli
rm -rf "$OUT" bench/data/demo-src && mkdir -p bench/data/demo-src
uv run python scripts/slice_tsbs.py "$SRC" bench/data/demo-src "$TRUCKS"
# Small row groups: web readers fetch whole row-group column chunks, so 64k rows keeps a
# one-series read to a few hundred KB.
TLW=("$TL" -w "$BASE_URL" -o "timelake_local_root=$OUT")
"${TLW[@]}" import tsbs.tags bench/data/demo-src/tags.parquet
for t in readings diagnostics; do
  "${TLW[@]}" import tsbs.$t bench/data/demo-src/$t.parquet --time-column time --series-key tags_id --no-dedup \
    --prop timelake.row-group-rows=65536
done
"${TLW[@]}" maintain
"${TLW[@]}" index
rm -rf bench/data/demo-src
echo; echo "built $(find "$OUT" -type f | wc -l | tr -d ' ') files, $(du -sh "$OUT" | cut -f1) in $OUT for $BASE_URL"
