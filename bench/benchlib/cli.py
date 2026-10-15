"""``timelake-bench``: run benchmarks and read their history (bench/README.md).

uv run timelake-bench list
uv run timelake-bench run tsbs-iot --scale small --systems timelake,iceberg
uv run timelake-bench run tsbs-iot --target s3 --ttfb-ms 20        # local RustFS behind tools/s3proxy
uv run timelake-bench profile weekly                                # bench/profiles/weekly.toml
uv run timelake-bench report latest
uv run timelake-bench history --workload tsbs-iot
"""

from __future__ import annotations

import argparse

import tomllib

from benchlib import BENCH, RUNS
from benchlib.harness import CHECKPOINTS, RunSpec, run
from benchlib.report import Run, history, markdown, runs
from benchlib.systems import systems
from benchlib.targets import Target
from benchlib.workloads import Workload, workloads

PROFILES = BENCH / "profiles"


def make_workload(name: str, scale: str | None, params: dict[str, object]) -> Workload:
    """A workload by name, with its scale and parameters."""
    if name not in workloads():
        msg = f"unknown workload {name!r} (workloads: {', '.join(workloads())})"
        raise SystemExit(msg)
    return workloads()[name](scale, **params)


def parse_params(pairs: list[str]) -> dict[str, object]:
    """``key=value`` pairs; integer values become ints."""
    out: dict[str, object] = {}
    for pair in pairs:
        key, _, value = pair.partition("=")
        out[key] = int(value) if value.isdigit() else value
    return out


def split(value: str | None) -> list[str] | None:
    """A comma-separated list, None if not given."""
    return value.split(",") if value else None


def cmd_list(_: argparse.Namespace) -> None:
    """Prints the workloads with their scales, and the systems with their readers."""
    print("Workloads:")
    for w in workloads().values():
        print(f"  {w.name}: {w.title}; suites {', '.join(w.suites)}")
        for scale, about in w.scales.items():
            print(f"    {scale:9} {about}{' (default)' if scale == w.default_scale else ''}")
    print("Systems (readers):")
    for s in systems().values():
        print(f"  {s.name:12} {s.title} ({', '.join(s.readers)}){'; a database server' if s.server else ''}")


def cmd_run(args: argparse.Namespace) -> None:
    """Runs one workload on some systems."""
    workload = make_workload(args.workload, args.scale, parse_params(args.param))
    names = split(args.systems) or [s for s in systems() if s != "s3tables" and not systems()[s].server]
    unknown = set(names) - set(systems())
    if unknown:
        msg = f"unknown systems {sorted(unknown)} (systems: {', '.join(systems())})"
        raise SystemExit(msg)
    spec = RunSpec(
        workload=workload,
        target=Target(args.target),
        systems=names,
        readers=split(args.readers),
        checkpoints=tuple(split(args.checkpoints) or CHECKPOINTS),
        queries=set(split(args.queries) or []) or None,
        runs=args.runs,
        timeout=args.timeout,
        ttfb_ms=args.ttfb_ms,
        label=args.label,
        reuse=args.reuse,
    )
    print(markdown(Run(run(spec))))


def cmd_profile(args: argparse.Namespace) -> None:
    """Runs every entry of a profile (``profiles/<name>.toml``)."""
    profile = tomllib.loads((PROFILES / f"{args.name}.toml").read_text())
    for entry in profile["run"]:
        if args.target and entry["target"] != args.target:
            continue
        spec = RunSpec(
            workload=make_workload(entry["workload"], entry.get("scale"), entry.get("params", {})),
            target=Target(entry["target"]),
            systems=entry["systems"],
            runs=entry.get("runs", profile.get("runs", 2)),
            timeout=entry.get("timeout", profile.get("timeout", 600)),
            label=profile.get("label", args.name),
        )
        print(markdown(Run(run(spec))))


def cmd_report(args: argparse.Namespace) -> None:
    """Prints one run as Markdown."""
    if args.run == "latest":
        found = sorted(RUNS.glob("*.jsonl"))
        if not found:
            msg = "no runs yet"
            raise SystemExit(msg)
        path = found[-1]
    else:
        path = RUNS / f"{args.run.removesuffix('.jsonl')}.jsonl"
    print(markdown(Run(path)))


def cmd_history(args: argparse.Namespace) -> None:
    """Prints the history of runs."""
    print(history(runs(args.workload, args.label), args.checkpoint))


def main() -> None:
    """Parses the command line and runs the command."""
    p = argparse.ArgumentParser(
        prog="timelake-bench", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    commands = p.add_subparsers(dest="command", required=True)

    commands.add_parser("list", help="workloads, scales, systems and readers").set_defaults(func=cmd_list)

    r = commands.add_parser("run", help="run one workload")
    r.add_argument("workload")
    r.add_argument("--scale", help="default: the workload's default scale")
    r.add_argument("--systems", help="comma-separated (default: every lake system)")
    r.add_argument("--readers", help="comma-separated (default: every reader of each system)")
    r.add_argument("--target", default="local", help="local, s3 (RustFS via the proxy), or an AWS target name")
    r.add_argument("--checkpoints", help=f"comma-separated, of {', '.join(CHECKPOINTS)} (default: both)")
    r.add_argument("--queries", help="comma-separated query names (default: all)")
    r.add_argument("--runs", type=int, default=2, help="repeat runs per query after the first run")
    r.add_argument("--timeout", type=int, default=600, help="seconds per query, all runs")
    r.add_argument("--ttfb-ms", type=int, help="latency the proxy adds per request (local object stores)")
    r.add_argument("--param", action="append", default=[], help="workload parameter key=value (repeatable)")
    r.add_argument("--label", default="", help="free text recorded with the run")
    r.add_argument("--reuse", action="store_true", help="query the tables an earlier run left (no ingest)")
    r.set_defaults(func=cmd_run)

    pr = commands.add_parser("profile", help="run a set of runs (profiles/<name>.toml)")
    pr.add_argument("name")
    pr.add_argument("--target", help="only the entries with this target")
    pr.set_defaults(func=cmd_profile)

    rep = commands.add_parser("report", help="one run as Markdown")
    rep.add_argument("run", help="a run id, or latest")
    rep.set_defaults(func=cmd_report)

    h = commands.add_parser("history", help="first-run geometric means of every run")
    h.add_argument("--workload")
    h.add_argument("--label")
    h.add_argument("--checkpoint", default="maintained")
    h.set_defaults(func=cmd_history)

    args = p.parse_args()
    args.func(args)
