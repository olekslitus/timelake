# timelake-format

Timelake's table conventions, with no I/O: the table contract stored in `timelake.*` Iceberg properties, the
table format version, time partition math, Iceberg bound decoding, and the codecs of the head object
(`head` feature). The engine ([`timelake`](https://crates.io/crates/timelake)) and Timelake's WebAssembly reader
share it, so both read tables the same way.

Most users want [`timelake`](https://crates.io/crates/timelake) instead. Docs:
[timelake.dev/docs](https://timelake.dev/docs).

Licensed under the Apache License 2.0.
