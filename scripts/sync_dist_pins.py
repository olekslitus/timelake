"""Copy the action pins in release.yml into dist-workspace.toml, then regenerate release.yml.

dist generates release.yml from dist-workspace.toml, and refuses to release when the two disagree. Dependabot
updates the actions in release.yml like in any other workflow, so its pull requests fail CI until the new pins are
in dist-workspace.toml too. Run this on the pull request's branch and commit the result:

    uv run python scripts/sync_dist_pins.py

Needs git and dist (https://opensource.axo.dev/cargo-dist/) on the PATH.
"""

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RELEASE = ROOT / ".github/workflows/release.yml"
CONFIG = ROOT / "dist-workspace.toml"

USES = re.compile(r"uses: ([\w.-]+/[\w.-]+)@([0-9a-f]{40})")
PIN = re.compile(r'^"(?P<action>[\w.-]+/[\w.-]+)" = "[0-9a-f]{40}".*$', re.MULTILINE)


def run(*cmd: str) -> str:
    """Runs a command in the repository and returns its output; fails loudly."""
    # The commands are fixed in this script; only action names from release.yml vary, and they match USES.
    return subprocess.run(cmd, cwd=ROOT, check=True, capture_output=True, text=True).stdout  # noqa: S603


def release_tag(action: str, sha: str) -> str | None:
    """The most specific release tag of `action` that points at `sha`, such as v7.0.2."""
    out = run("git", "ls-remote", "--tags", f"https://github.com/{action}")
    # Annotated tags are listed twice: the tag object, then the commit it points at with a ^{} suffix.
    refs = (line.split() for line in out.splitlines())
    tags = [ref.removeprefix("refs/tags/").removesuffix("^{}") for commit, ref in refs if commit == sha]
    return max(tags, key=lambda tag: tag.count(".")) if tags else None


def main() -> None:
    """Syncs the pins and regenerates release.yml."""
    pins = dict(USES.findall(RELEASE.read_text()))

    def pin(match: re.Match[str]) -> str:
        action = match["action"]
        if action not in pins:
            return match[0]
        tag = release_tag(action, pins[action])
        return f'"{action}" = "{pins[action]}"' + (f" # {tag}" if tag else "")

    CONFIG.write_text(PIN.sub(pin, CONFIG.read_text()))
    run("dist", "generate", "--mode", "ci")
    print(run("git", "diff", "--stat", "--", str(CONFIG), str(RELEASE)), end="")


if __name__ == "__main__":
    main()
