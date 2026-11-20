"""Summarize what a pull request's lockfile changes add and remove, and keep one comment about it.

The comment says how many packages the change adds and removes, and how many each new direct
dependency brings with it.  It is posted once and edited on later pushes, never duplicated.
"""

import argparse
import json
import os
from pathlib import Path
import sys

import pnpm_lock


MARKER = "<!-- dependency-changes -->"


def importer_label(lockfile, importer):
    if importer == ".":
        directory = str(Path(lockfile).parent)
        return "the root" if directory == "." else directory
    return importer


def compare(base, head, lockfile="pnpm-lock.yaml"):
    """Return the change between two lockfiles as plain data."""
    before, after = base.packages(), head.packages()
    added, removed = after - before, before - after
    new_direct = []
    for importer in sorted(head.importers):
        old = base.direct(importer)
        for name in sorted(head.direct(importer)):
            if name in old:
                continue
            brings = head.closure_of_dependency(importer, name)
            new_direct.append(
                {
                    "importer": importer_label(lockfile, importer),
                    "name": name,
                    "total": len(brings),
                    "new": len(set(brings) & added),
                }
            )
    return {"lockfile": lockfile, "added": sorted(added), "removed": sorted(removed), "new_direct": new_direct}


def render(changes):
    lines = [MARKER, "## Dependency changes", ""]
    changed = [c for c in changes if c["added"] or c["removed"] or c["new_direct"]]
    if not changed:
        lines.append("The lockfiles now match the base branch.")
        return "\n".join(lines) + "\n"
    added = sum(len(c["added"]) for c in changed)
    removed = sum(len(c["removed"]) for c in changed)
    lines.append(f"This change adds **{added}** {plural(added)} and removes **{removed}**.")
    for change in changed:
        lines += ["", f"### `{change['lockfile']}`", ""]
        lines.append(f"Adds {len(change['added'])} and removes {len(change['removed'])}.")
        if change["new_direct"]:
            lines += ["", "| New direct dependency | In | Brings new | Brings in all |"]
            lines.append("| --- | --- | --- | --- |")
            for entry in change["new_direct"]:
                lines.append(f"| `{entry['name']}` | {entry['importer']} | {entry['new']} | {entry['total']} |")
        for title, packages in (("Added", change["added"]), ("Removed", change["removed"])):
            if packages:
                listed = ", ".join(f"`{name}@{version}`" for name, version in packages[:200])
                more = f", and {len(packages) - 200} more" if len(packages) > 200 else ""
                summary = f"<details><summary>{title} ({len(packages)})</summary>"
                lines += ["", summary, "", listed + more, "", "</details>"]
    lines += [
        "",
        "Each new direct dependency needs a reason in `dependency-reasons.toml`.  "
        "See [the dependency guide](docs/developer/dependencies.md).",
    ]
    return "\n".join(lines) + "\n"


def plural(count):
    return "package" if count == 1 else "packages"


def publish(client, number, body, changed):
    """Edit the existing comment, or post one only when the lockfiles changed."""
    for comment in client.comments(number):
        if MARKER in (comment.get("body") or ""):
            if comment["body"] != body:
                client.update_comment(comment["id"], body)
                return "updated"
            return "unchanged"
    if not changed:
        return "skipped"
    client.comment(number, body)
    return "posted"


def pull_request_number():
    path = os.environ.get("GITHUB_EVENT_PATH")
    if not path:
        return None
    with open(path, encoding="utf-8") as source:
        return (json.load(source).get("pull_request") or {}).get("number")


def main(argv=None, client_factory=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base-root", required=True, help="where the base branch's lockfiles are")
    parser.add_argument("--root", default=".", help="where the pull request's lockfiles are")
    parser.add_argument("--lockfile", action="append", required=True, help="a lockfile path, repeatable")
    parser.add_argument("--post", action="store_true", help="post or edit the pull request comment")
    args = parser.parse_args(argv)
    changes = []
    for lockfile in args.lockfile:
        base = pnpm_lock.Lockfile.read(Path(args.base_root) / lockfile)
        head = pnpm_lock.Lockfile.read(Path(args.root) / lockfile)
        changes.append(compare(base, head, lockfile))
    body = render(changes)
    print(body)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as output:
            output.write(body.replace(MARKER + "\n", ""))
    if args.post:
        number = pull_request_number()
        if not number:
            print("::warning::No pull request number, so no comment was posted")
            return 0
        github_api = __import__("github_api")
        factory = client_factory or github_api.GitHub.from_environment
        changed = any(c["added"] or c["removed"] or c["new_direct"] for c in changes)
        try:
            print(f"Comment {publish(factory(), number, body, changed)}")
        except github_api.GitHubError as error:
            # Pull requests from forks get a read-only token, and the step summary still has the numbers.
            print(f"::warning::Could not post the dependency comment: {error}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
