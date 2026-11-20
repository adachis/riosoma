"""Decide which dependency advisories block a build, and track the others as dated issues.

An advisory blocks when it is in a shipped package (the server image or the web bundle) at moderate
severity or above, or when a pull request adds it.  Every other advisory gets one GitHub issue with a
due date.  Pushes to dev and the nightly keep those issues current, and the nightly fails once an
issue is past due while its advisory is still reported.  See docs/developer/dependencies.md.
"""

import argparse
from dataclasses import dataclass, field
from datetime import date, timedelta
import json
import os
from pathlib import Path
import re
import sys

import pnpm_lock


LABEL = "dependency-advisory"
SEVERITY_RANK = {"low": 1, "moderate": 2, "high": 3, "critical": 4}
# Days from first seen to due, following the FedRAMP remediation windows.
DUE_DAYS = {"critical": 30, "high": 30, "moderate": 90, "low": 180}
BLOCKING_SEVERITY = "moderate"
# What ships, by lockfile: the server and connector images install their apps' production closures
# (pnpm deploy --prod), and the web bundle is built from the web app's production closure.
SHIPPED = {
    "pnpm-lock.yaml": {
        "server image": ["apps/server"],
        "connector image": ["apps/connector-service"],
        "web bundle": ["apps/web"],
    }
}
# Both images use Debian in the Dockerfile, and .github/workflows/release.yml builds each for
# linux/amd64 and linux/arm64.  Tuples use the lockfile's OS, CPU, and libc names.
IMAGE_PLATFORMS = (("linux", "x64", "glibc"), ("linux", "arm64", "glibc"))
MARKER = re.compile(r"<!-- advisory-gate (\{.*?\}) -->")


@dataclass
class Occurrence:
    lockfile: str
    name: str
    version: str
    path: list
    shipped_in: list

    def key(self):
        return (self.lockfile, self.name, self.version)


@dataclass
class Advisory:
    id: str
    aliases: list
    severity: str
    summary: str
    occurrences: list = field(default_factory=list)
    added: bool = False

    @property
    def shipped(self):
        return any(occurrence.shipped_in for occurrence in self.occurrences)

    @property
    def severe(self):
        return SEVERITY_RANK[self.severity] >= SEVERITY_RANK[BLOCKING_SEVERITY]

    @property
    def blocks(self):
        return (self.shipped and self.severe) or self.added

    def reason(self):
        reasons = []
        if self.shipped and self.severe:
            places = sorted({place for occurrence in self.occurrences for place in occurrence.shipped_in})
            reasons.append(f"{self.severity} severity in the {' and the '.join(places)}")
        if self.added:
            reasons.append("added by this pull request")
        return ", and ".join(reasons)

    def fingerprint(self):
        return {
            "severity": self.severity,
            "blocks": self.shipped and self.severe,
            "packages": sorted(
                f"{o.lockfile}:{o.name}@{o.version}{' (shipped)' if o.shipped_in else ''}"
                for o in self.occurrences
            ),
        }


def severity_from_cvss(score):
    if score >= 9:
        return "critical"
    if score >= 7:
        return "high"
    if score >= 4:
        return "moderate"
    return "low"


def severity_of(vulnerability, group):
    """The GitHub advisory label when there is one, otherwise the group's CVSS score."""
    label = str((vulnerability.get("database_specific") or {}).get("severity", "")).lower()
    if label == "medium":
        label = "moderate"
    if label in SEVERITY_RANK:
        return label
    try:
        return severity_from_cvss(float(group.get("max_severity")))
    except (TypeError, ValueError):
        # An advisory without a severity is treated as moderate, so it still blocks when shipped.
        return "moderate"


def relative_lockfile(source, root):
    try:
        return Path(source).resolve().relative_to(Path(root).resolve()).as_posix()
    except ValueError:
        return Path(source).name


class Graphs:
    """Each scanned lockfile's shipped closures, and every package's path for the rest."""

    def __init__(self, root):
        self.root = Path(root)
        self.cache = {}

    def get(self, lockfile):
        if lockfile not in self.cache:
            lock = pnpm_lock.Lockfile.read(self.root / lockfile)
            shipped = {
                place: lock.closure(
                    importers,
                    platforms=IMAGE_PLATFORMS if place.endswith(" image") else None,
                    browser=place == "web bundle",
                )
                for place, importers in SHIPPED.get(lockfile, {}).items()
            }
            everything = lock.closure(sorted(lock.importers), pnpm_lock.ALL_SECTIONS)
            directory = Path(lockfile).parent.as_posix()
            for path in everything.values():
                if path[0] == ".":
                    path[0] = "the root" if directory == "." else directory
            self.cache[lockfile] = (shipped, everything)
        return self.cache[lockfile]


def read_findings(scan, root, decide_shipping=True):
    """Group osv-scanner JSON results into advisories keyed by id."""
    graphs = Graphs(root)
    advisories = {}
    for result in scan.get("results") or []:
        lockfile = relative_lockfile((result.get("source") or {}).get("path", ""), root)
        shipped, everything = graphs.get(lockfile) if decide_shipping else ({}, {})
        for entry in result.get("packages") or []:
            package = entry.get("package") or {}
            name, version = package.get("name", ""), package.get("version", "")
            vulnerabilities = {v.get("id"): v for v in entry.get("vulnerabilities") or []}
            groups = entry.get("groups") or [{"ids": [identifier]} for identifier in vulnerabilities]
            for group in groups:
                ids = sorted(group.get("ids") or [], key=lambda i: (not i.startswith("GHSA-"), i))
                if not ids:
                    continue
                vulnerability = next((vulnerabilities[i] for i in ids if i in vulnerabilities), {})
                advisory = advisories.get(ids[0])
                if advisory is None:
                    aliases = sorted((set(group.get("aliases") or []) | set(ids)) - {ids[0]})
                    advisory = advisories[ids[0]] = Advisory(
                        ids[0], aliases, severity_of(vulnerability, group), vulnerability.get("summary", "")
                    )
                shipped_in = [place for place, closure in sorted(shipped.items()) if (name, version) in closure]
                path = next((shipped[place][(name, version)] for place in shipped_in), None)
                path = path or everything.get((name, version)) or []
                advisory.occurrences.append(Occurrence(lockfile, name, version, path, shipped_in))
    return advisories


def mark_added(head, base):
    """Mark advisories in the head scan that the base scan lacks for the same package."""
    before = {(a.id, o.lockfile, o.name) for a in base.values() for o in a.occurrences}
    for advisory in head.values():
        advisory.added = any((advisory.id, o.lockfile, o.name) not in before for o in advisory.occurrences)


def due_date(first_seen, severity):
    return first_seen + timedelta(days=DUE_DAYS[severity])


def describe_occurrence(occurrence):
    arrives = " > ".join(occurrence.path) if occurrence.path else "not found in the lockfile"
    shipped = ", ".join(occurrence.shipped_in) or "not shipped"
    return f"`{occurrence.name}@{occurrence.version}` in `{occurrence.lockfile}` ({shipped}): {arrives}"


def issue_title(advisory, due):
    names = sorted({o.name for o in advisory.occurrences})
    return f"{advisory.id} in {', '.join(names)} ({advisory.severity}), due {due.isoformat()}"


def issue_body(advisory, first_seen, due):
    state = {"id": advisory.id, "first_seen": first_seen.isoformat(), "fingerprint": advisory.fingerprint()}
    lines = [
        f"<!-- advisory-gate {json.dumps(state, sort_keys=True)} -->",
        f"**{advisory.id}**: {advisory.summary or 'no summary'}",
        "",
        f"- Severity: {advisory.severity}",
        f"- First seen: {first_seen.isoformat()}",
        f"- Due: {due.isoformat()} ({DUE_DAYS[advisory.severity]} days for {advisory.severity})",
        f"- Advisory: https://osv.dev/vulnerability/{advisory.id}",
    ]
    if advisory.aliases:
        lines.append(f"- Aliases: {', '.join(advisory.aliases)}")
    lines += ["", "Packages and how they arrive:", ""]
    lines += [f"- {describe_occurrence(o)}" for o in advisory.occurrences]
    lines += [
        "",
        "Upgrade or override the package, or add an ignore with a reason to `osv-scanner.toml`.  "
        "The nightly fails once this is past due and still reported.  "
        "This issue closes on its own when the advisory is gone.",
    ]
    return "\n".join(lines)


def issue_state(issue):
    match = MARKER.search(issue.get("body") or "")
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except ValueError:
        return None


def describe_change(old, new):
    changes = []
    if old.get("severity") != new["severity"]:
        changes.append(f"severity changed from {old.get('severity')} to {new['severity']}")
    if bool(old.get("blocks")) != new["blocks"]:
        changes.append("it now blocks builds" if new["blocks"] else "it no longer blocks builds")
    before, after = set(old.get("packages") or []), set(new["packages"])
    if after - before:
        changes.append("now in " + ", ".join(sorted(after - before)))
    if before - after:
        changes.append("no longer in " + ", ".join(sorted(before - after)))
    return ", ".join(changes) or "details changed"


def issue_first_seen(issue, state):
    try:
        return date.fromisoformat(state.get("first_seen", ""))
    except (TypeError, ValueError):
        return date.fromisoformat(issue["created_at"][:10])


def sync_issues(client, advisories, today):
    """Open, update, reopen, consolidate, and close advisory issues.  Returns overdue advisories."""
    tracked = {}
    for issue in client.issues(LABEL):
        state = issue_state(issue)
        if state and state.get("id"):
            tracked.setdefault(state["id"], []).append((issue, state))
    overdue = []
    actions = []
    for advisory in sorted(advisories.values(), key=lambda a: a.id):
        existing = tracked.get(advisory.id)
        if existing is None:
            if advisory.blocks:
                continue
            due = due_date(today, advisory.severity)
            labels = [LABEL, f"severity:{advisory.severity}"]
            created = client.create_issue(issue_title(advisory, due), issue_body(advisory, today, due), labels)
            actions.append(f"Opened #{created['number']} for {advisory.id}")
            continue
        existing = sorted(existing, key=lambda entry: (
            entry[0]["state"] != "open", issue_first_seen(*entry), entry[0]["number"]
        ))
        issue, state = existing[0]
        # Closed history can hold an older date than any remaining open issue.
        first_seen = min(issue_first_seen(*entry) for entry in existing)
        duplicates = [other for other, _ in existing[1:] if other["state"] == "open"]
        due = due_date(first_seen, advisory.severity)
        fingerprint = advisory.fingerprint()
        update = {}
        if issue["state"] != "open":
            update["state"] = "open"
            client.comment(issue["number"], f"{advisory.id} is reported again, so this issue is open again.  "
                           f"It keeps its first-seen date of {first_seen.isoformat()}.")
            actions.append(f"Reopened #{issue['number']} for {advisory.id}")
        elif state.get("fingerprint") != fingerprint:
            change = describe_change(state.get("fingerprint") or {}, fingerprint)
            client.comment(issue["number"], f"{advisory.id} changed: {change}.")
            actions.append(f"Updated #{issue['number']} for {advisory.id}")
        if (
            update or state.get("fingerprint") != fingerprint or duplicates
            or state.get("first_seen") != first_seen.isoformat()
        ):
            update["title"] = issue_title(advisory, due)
            update["body"] = issue_body(advisory, first_seen, due)
            client.update_issue(issue["number"], **update)
        for duplicate in duplicates:
            client.comment(duplicate["number"], f"Duplicate tracking issue for {advisory.id}.  "
                           f"Continuing in #{issue['number']} with first-seen date {first_seen.isoformat()}.")
            client.update_issue(duplicate["number"], state="closed", state_reason="not_planned")
            actions.append(f"Consolidated #{duplicate['number']} into #{issue['number']} for {advisory.id}")
        if not advisory.blocks and today > due:
            overdue.append((advisory, issue["number"], due))
    for advisory_id, issues in sorted(tracked.items()):
        if advisory_id in advisories:
            continue
        for issue, _ in issues:
            if issue["state"] != "open":
                continue
            client.comment(issue["number"], f"{advisory_id} is no longer reported: it was fixed, or ignored with a "
                           "reason in `osv-scanner.toml`.  Closing.")
            client.update_issue(issue["number"], state="closed", state_reason="completed")
            actions.append(f"Closed #{issue['number']} for {advisory_id}")
    return overdue, actions


def report(advisories, overdue=(), actions=()):
    blocking = [a for a in advisories.values() if a.blocks]
    lines = ["## Dependency advisories", ""]
    if not advisories:
        lines.append("No advisories reported.")
    else:
        lines += ["| Advisory | Severity | Packages | Decision |", "| --- | --- | --- | --- |"]
        for advisory in sorted(advisories.values(), key=lambda a: (not a.blocks, -SEVERITY_RANK[a.severity], a.id)):
            packages = "<br>".join(describe_occurrence(o) for o in advisory.occurrences)
            decision = f"**blocks**: {advisory.reason()}" if advisory.blocks else "tracked in an issue"
            lines.append(f"| {advisory.id} | {advisory.severity} | {packages} | {decision} |")
    for advisory, number, due in overdue:
        lines.append(f"\n**Past due**: {advisory.id} (#{number}) was due {due.isoformat()}.")
    if actions:
        lines += ["", "Issues:", ""] + [f"- {action}" for action in actions]
    lines.append(f"\n{len(blocking)} blocking, {len(advisories) - len(blocking)} tracked, {len(overdue)} past due.")
    return "\n".join(lines) + "\n"


def annotate(level, message):
    escaped = str(message).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    print(f"::{level}::{escaped}")


def load_scan(path):
    with open(path, encoding="utf-8") as source:
        text = source.read()
    return json.loads(text) if text.strip() else {}


def main(argv=None, client_factory=None, today=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--scan", required=True, help="osv-scanner JSON for the checked-out lockfiles")
    parser.add_argument("--root", default=".", help="where the scanned lockfiles are")
    parser.add_argument("--base-scan", help="osv-scanner JSON for a pull request's base lockfiles")
    parser.add_argument("--base-root", help="where the base lockfiles are")
    parser.add_argument("--write-issues", action="store_true", help="open, update, and close advisory issues")
    parser.add_argument("--enforce-due", action="store_true", help="fail when a tracked advisory is past due")
    parser.add_argument("--exit-zero", action="store_true", help="report only; another job enforces the decision")
    args = parser.parse_args(argv)
    today = today or date.today()
    try:
        advisories = read_findings(load_scan(args.scan), args.root)
        if args.base_scan:
            mark_added(advisories, read_findings(load_scan(args.base_scan), args.base_root or args.root, False))
    except (OSError, ValueError) as error:
        annotate("error", f"Cannot read the advisory scan: {error}")
        return 2
    overdue, actions = [], []
    if args.write_issues:
        factory = client_factory or __import__("github_api").GitHub.from_environment
        overdue, actions = sync_issues(factory(), advisories, today)
    text = report(advisories, overdue, actions)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as output:
            output.write(text)
    status = 0
    for advisory in sorted(advisories.values(), key=lambda a: a.id):
        if advisory.blocks:
            annotate("warning" if args.exit_zero else "error", f"{advisory.id} blocks: {advisory.reason()}")
            status = 1
    if args.enforce_due:
        for advisory, number, due in overdue:
            annotate("error", f"{advisory.id} (#{number}) was due {due.isoformat()} and is still reported")
            status = 1
    else:
        for advisory, number, due in overdue:
            annotate("warning", f"{advisory.id} (#{number}) was due {due.isoformat()} and is still reported")
    return 0 if args.exit_zero else status


if __name__ == "__main__":
    sys.exit(main())
