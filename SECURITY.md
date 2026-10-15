# Security policy

## Reporting a vulnerability

Please don't report security problems in public issues, pull requests or discussions. Report them privately on
GitHub instead: [**Report a vulnerability**](https://github.com/polythings/timelake/security/advisories/new). Only
the maintainers see the report.

Please include what's affected (component and version), how to reproduce it, and what an attacker could do with
it. A minimal table, script or request that shows the problem helps most.

What happens next:

1. We reply within 7 days to confirm we've got it, and keep you posted while we work on a fix.
2. We fix it in a new patch release of the latest version, published to every registry.
3. We publish a [GitHub security advisory](https://github.com/polythings/timelake/security/advisories) with a CVE
   and credit you, unless you'd rather not be named.

Please keep the problem private until the fixed release is out, or for 90 days after your report, whichever comes
first.

## Supported versions

Timelake is before 1.0, so only the latest release gets security fixes. If you're on an older version, upgrade:
the [Upgrading](https://timelake.dev/docs/upgrading) docs say how.

## Scope

In scope is everything Timelake ships: the `timelake`, `timelake-format` and `timelake-cli` crates, the `timelake`
Python package, the `@timelake/client` npm package and its WebAssembly reader, the CLI binaries and installers on
[GitHub releases](https://github.com/polythings/timelake/releases), and the [timelake.dev](https://timelake.dev)
website. For example:

- leaking storage credentials, into tables, logs, error messages or requests to another host;
- reading or changing data that the given credentials or URLs shouldn't reach;
- running code, or memory unsafety, from a crafted table, file or query;
- a way to tamper with what the release workflows build or publish.

Out of scope: the benchmarks (`bench/`), experiments (`spikes/`) and design tools (`brand/`), which never ship. A
vulnerability in a dependency belongs with that project, unless Timelake's use of it makes it exploitable. A
crash or slow query from a malformed file is a bug: open an [issue](https://github.com/polythings/timelake/issues).

## Verifying a release

Releases are built and published by GitHub Actions from a tag. The registries accept them through trusted
publishing, so no long-lived publishing token exists to steal.

- **CLI binaries and installers** carry signed build attestations:
  `gh attestation verify <file> --repo polythings/timelake`.
- **npm** shows the package's provenance (the workflow run that built it), and **PyPI** shows its attestations.
