from contextlib import redirect_stdout
from datetime import date
from io import StringIO
import json
import os
from pathlib import Path
import re
from tempfile import TemporaryDirectory
import textwrap
import unittest
from unittest.mock import patch

import advisory_gate as gate


LOCK = textwrap.dedent(
    """\
    lockfileVersion: '9.0'

    importers:

      apps/server:
        dependencies:
          framework:
            specifier: 1.0.0
            version: 1.0.0
        devDependencies:
          test-tool:
            specifier: 1.0.0
            version: 1.0.0

      apps/web:
        dependencies:
          widget:
            specifier: 1.0.0
            version: 1.0.0

    snapshots:

      framework@1.0.0:
        dependencies:
          parser: 2.0.0

      parser@2.0.0: {}

      widget@1.0.0: {}

      test-tool@1.0.0:
        dependencies:
          parser: 1.0.0

      parser@1.0.0: {}
    """
)


def vulnerability(identifier, severity=None, summary="Something is wrong"):
    record = {"id": identifier, "summary": summary, "aliases": [f"CVE-{identifier}"]}
    if severity:
        record["database_specific"] = {"severity": severity}
    return record


def package(name, version, *vulnerabilities, scores=None):
    scores = scores or {}
    return {
        "package": {"name": name, "version": version, "ecosystem": "npm"},
        "vulnerabilities": list(vulnerabilities),
        "groups": [
            {"ids": [v["id"]], "aliases": [v["id"], f"CVE-{v['id']}"], "max_severity": scores.get(v["id"], "")}
            for v in vulnerabilities
        ],
    }


def scan(root, packages, lockfile="pnpm-lock.yaml"):
    return {"results": [{"source": {"path": str(Path(root) / lockfile), "type": "lockfile"}, "packages": packages}]}


class FakeGitHub:
    """Records calls instead of reaching GitHub."""

    def __init__(self, issues=()):
        self.issue_list = [dict(issue) for issue in issues]
        self.calls = []

    def issues(self, label):
        self.calls.append(("issues", label))
        return self.issue_list

    def create_issue(self, title, body, labels):
        number = 100 + len([c for c in self.calls if c[0] == "create"])
        self.calls.append(("create", title, body, labels))
        return {"number": number}

    def update_issue(self, number, **fields):
        self.calls.append(("update", number, fields))
        next(issue for issue in self.issue_list if issue["number"] == number).update(fields)

    def comment(self, number, body):
        self.calls.append(("comment", number, body))

    def of(self, kind):
        return [call for call in self.calls if call[0] == kind]


class GateFixture(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.root = Path(self.directory.name)
        (self.root / "pnpm-lock.yaml").write_text(LOCK)
        # Keep reports out of a real Actions step summary when the tests run in CI.
        self.enterContext(patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(self.root / "summary.md")}))

    def tearDown(self):
        self.directory.cleanup()

    def findings(self, packages, lockfile="pnpm-lock.yaml"):
        return gate.read_findings(scan(self.root, packages, lockfile), self.root)


class GateTest(GateFixture):
    def test_severity_comes_from_the_advisory_label_then_the_score(self):
        self.assertEqual(gate.severity_of({"database_specific": {"severity": "HIGH"}}, {}), "high")
        self.assertEqual(gate.severity_of({"database_specific": {"severity": "MEDIUM"}}, {}), "moderate")
        for score, expected in (("9.8", "critical"), ("7.0", "high"), ("4.0", "moderate"), ("3.9", "low")):
            with self.subTest(score=score):
                self.assertEqual(gate.severity_of({}, {"max_severity": score}), expected)
        self.assertEqual(gate.severity_of({}, {"max_severity": ""}), "moderate")

    def test_shipped_moderate_blocks_with_how_it_arrives(self):
        advisories = self.findings([package("parser", "2.0.0", vulnerability("GHSA-1111", "MODERATE"))])
        advisory = advisories["GHSA-1111"]
        self.assertTrue(advisory.blocks)
        self.assertEqual(advisory.occurrences[0].shipped_in, ["server image"])
        self.assertEqual(advisory.occurrences[0].path, ["apps/server", "framework", "parser"])
        self.assertIn("server image", advisory.reason())

    def test_web_bundle_counts_as_shipped(self):
        advisories = self.findings([package("widget", "1.0.0", vulnerability("GHSA-2222", "HIGH"))])
        self.assertEqual(advisories["GHSA-2222"].occurrences[0].shipped_in, ["web bundle"])
        self.assertTrue(advisories["GHSA-2222"].blocks)

    def test_shipping_filters_native_packages_but_keeps_their_reporting_paths(self):
        metadata = """packages:
  framework@1.0.0:
    os: [win32]
  widget@1.0.0:
    cpu: [x64]
"""
        (self.root / "pnpm-lock.yaml").write_text(LOCK + metadata)
        advisories = self.findings([
            package("framework", "1.0.0", vulnerability("GHSA-server", "MODERATE")),
            package("widget", "1.0.0", vulnerability("GHSA-web", "MODERATE")),
        ])
        for identifier in ("GHSA-server", "GHSA-web"):
            advisory = advisories[identifier]
            self.assertFalse(advisory.shipped)
            self.assertFalse(advisory.blocks)
            self.assertTrue(advisory.occurrences[0].path)
        gate.mark_added(advisories, {})
        self.assertTrue(all(advisory.blocks for advisory in advisories.values()))

    def test_repository_connector_image_ships_its_drivers(self):
        root = Path(__file__).resolve().parents[2]
        version = re.search(r"^  mysql2@([^:']+):", (root / "pnpm-lock.yaml").read_text(), re.M)[1]
        advisory = gate.read_findings(
            scan(root, [package("mysql2", version, vulnerability("GHSA-driver", "MODERATE"))]), root
        )["GHSA-driver"]
        self.assertTrue(advisory.blocks)
        self.assertIn("connector image", advisory.occurrences[0].shipped_in)
        self.assertNotIn("server image", advisory.occurrences[0].shipped_in)

    def test_repository_server_ships_both_linux_architectures_and_skips_windows(self):
        root = Path(__file__).resolve().parents[2]
        # The platform binaries share the version of @node-rs/argon2 that the lockfile holds.
        version = re.search(r"^  '@node-rs/argon2@([^']+)':", (root / "pnpm-lock.yaml").read_text(), re.M)[1]
        for suffix, shipped in (("linux-x64-gnu", True), ("linux-arm64-gnu", True),
                                ("win32-x64-msvc", False), ("linux-x64-musl", False)):
            with self.subTest(suffix=suffix):
                name = f"@node-rs/argon2-{suffix}"
                advisory = gate.read_findings(
                    scan(root, [package(name, version, vulnerability("GHSA-native", "MODERATE"))]), root
                )["GHSA-native"]
                self.assertEqual(advisory.shipped, shipped)
                self.assertEqual(advisory.blocks, shipped)
                self.assertEqual(advisory.occurrences[0].shipped_in, ["server image"] if shipped else [])

    def test_shipped_low_does_not_block(self):
        advisories = self.findings([package("parser", "2.0.0", vulnerability("GHSA-3333", "LOW"))])
        self.assertFalse(advisories["GHSA-3333"].blocks)

    def test_development_only_critical_does_not_block(self):
        # parser 1.0.0 arrives only through a development dependency.
        advisories = self.findings([package("parser", "1.0.0", vulnerability("GHSA-4444", "CRITICAL"))])
        self.assertFalse(advisories["GHSA-4444"].shipped)
        self.assertFalse(advisories["GHSA-4444"].blocks)

    def test_other_lockfiles_never_ship(self):
        advisories = self.findings(
            [package("parser", "2.0.0", vulnerability("GHSA-5555", "CRITICAL"))], "integrations/zapier/pnpm-lock.yaml"
        )
        self.assertEqual(advisories["GHSA-5555"].occurrences[0].lockfile, "integrations/zapier/pnpm-lock.yaml")
        self.assertFalse(advisories["GHSA-5555"].blocks)

    def test_unshipped_packages_still_say_how_they_arrive(self):
        zapier = self.root / "integrations" / "zapier"
        zapier.mkdir(parents=True)
        (zapier / "pnpm-lock.yaml").write_text(
            "importers:\n  .:\n    dependencies:\n      platform:\n        specifier: 1.0.0\n"
            "        version: 1.0.0\nsnapshots:\n  platform@1.0.0:\n    dependencies:\n      form-data: 4.0.0\n"
            "  form-data@4.0.0: {}\n"
        )
        advisories = self.findings(
            [package("form-data", "4.0.0", vulnerability("GHSA-9999", "HIGH"))], "integrations/zapier/pnpm-lock.yaml"
        )
        occurrence = advisories["GHSA-9999"].occurrences[0]
        self.assertEqual(occurrence.path, ["integrations/zapier", "platform", "form-data"])
        self.assertEqual(advisories["GHSA-9999"].aliases, ["CVE-GHSA-9999"])
        self.assertIn("(not shipped): integrations/zapier > platform > form-data", gate.describe_occurrence(occurrence))

    def test_one_advisory_in_several_packages_is_grouped(self):
        advisory = vulnerability("GHSA-6666", "MODERATE")
        advisories = self.findings([package("parser", "1.0.0", advisory), package("parser", "2.0.0", advisory)])
        self.assertEqual(len(advisories), 1)
        self.assertEqual(len(advisories["GHSA-6666"].occurrences), 2)
        self.assertTrue(advisories["GHSA-6666"].blocks)

    def test_a_pull_request_blocks_what_it_adds(self):
        base = self.findings([package("parser", "1.0.0", vulnerability("GHSA-7777", "LOW"))])
        head = self.findings(
            [
                # Same advisory and package at another version: not added.
                package("parser", "1.0.1", vulnerability("GHSA-7777", "LOW")),
                package("test-tool", "1.0.0", vulnerability("GHSA-8888", "LOW")),
            ]
        )
        gate.mark_added(head, base)
        self.assertFalse(head["GHSA-7777"].blocks)
        self.assertTrue(head["GHSA-8888"].added)
        self.assertTrue(head["GHSA-8888"].blocks)
        self.assertIn("added by this pull request", head["GHSA-8888"].reason())

    def test_due_dates_follow_severity(self):
        first = date(2026, 11, 1)
        self.assertEqual(gate.due_date(first, "critical"), date(2026, 12, 1))
        self.assertEqual(gate.due_date(first, "high"), date(2026, 12, 1))
        self.assertEqual(gate.due_date(first, "moderate"), date(2027, 1, 30))
        self.assertEqual(gate.due_date(first, "low"), date(2027, 4, 30))


class IssueSyncTest(GateFixture):
    today = date(2026, 11, 14)

    def issue(self, advisories, identifier, first_seen, number=7, state="open", fingerprint=None):
        advisory = advisories[identifier]
        body = gate.issue_body(advisory, first_seen, gate.due_date(first_seen, advisory.severity))
        if fingerprint is not None:
            body = body.replace(json.dumps(advisory.fingerprint(), sort_keys=True), json.dumps(fingerprint, sort_keys=True))
        return {"number": number, "state": state, "body": body, "created_at": "2026-01-01T00:00:00Z"}

    def test_opens_one_issue_per_tracked_advisory_and_none_for_blocking_ones(self):
        advisories = self.findings(
            [
                package("parser", "1.0.0", vulnerability("GHSA-1000", "HIGH")),
                package("parser", "2.0.0", vulnerability("GHSA-2000", "HIGH")),
            ]
        )
        client = FakeGitHub()
        overdue, actions = gate.sync_issues(client, advisories, self.today)
        created = client.of("create")
        self.assertEqual(len(created), 1)
        _, title, body, labels = created[0]
        self.assertEqual(title, "GHSA-1000 in parser (high), due 2026-12-14")
        self.assertEqual(labels, ["dependency-advisory", "severity:high"])
        for text in ("parser@1.0.0", "apps/server > test-tool > parser", "Due: 2026-12-14", "First seen: 2026-11-14"):
            self.assertIn(text, body)
        self.assertEqual(gate.issue_state({"body": body})["first_seen"], "2026-11-14")
        self.assertEqual((overdue, len(actions)), ([], 1))

    def test_unchanged_issue_is_left_alone(self):
        advisories = self.findings([package("parser", "1.0.0", vulnerability("GHSA-1000", "LOW"))])
        client = FakeGitHub([self.issue(advisories, "GHSA-1000", date(2026, 11, 1))])
        self.assertEqual(gate.sync_issues(client, advisories, self.today), ([], []))
        self.assertEqual([c[0] for c in client.calls], ["issues"])

    def test_duplicate_issues_keep_earliest_date_then_lowest_number(self):
        advisories = self.findings([package("parser", "1.0.0", vulnerability("GHSA-1000", "HIGH"))])
        issues = [
            self.issue(advisories, "GHSA-1000", date(2026, 11, 1), number=3),
            self.issue(advisories, "GHSA-1000", date(2026, 9, 1), number=9),
            self.issue(advisories, "GHSA-1000", date(2026, 9, 1), number=7),
        ]
        client = FakeGitHub(issues)
        overdue, _ = gate.sync_issues(client, advisories, self.today)
        self.assertEqual([(number, due) for _, number, due in overdue], [(7, date(2026, 10, 1))])
        self.assertEqual([issue["number"] for issue in client.issue_list if issue["state"] == "open"], [7])
        update = client.of("update")[0]
        self.assertEqual(update[1], 7)
        self.assertIn("due 2026-10-01", update[2]["title"])
        self.assertIn("First seen: 2026-09-01", update[2]["body"])
        self.assertIn("Due: 2026-10-01", update[2]["body"])
        self.assertEqual({call[1] for call in client.of("comment")}, {3, 9})
        self.assertTrue(all("#7" in call[2] for call in client.of("comment")))
        client.calls.clear()
        gate.sync_issues(client, advisories, self.today)
        self.assertEqual(client.calls, [("issues", gate.LABEL)])

    def test_older_closed_history_transfers_first_seen_and_due_to_open_issue(self):
        advisories = self.findings([package("parser", "1.0.0", vulnerability("GHSA-1000", "HIGH"))])
        client = FakeGitHub([
            self.issue(advisories, "GHSA-1000", date(2026, 11, 1), number=8),
            self.issue(advisories, "GHSA-1000", date(2026, 8, 1), number=2, state="closed"),
        ])
        overdue, _ = gate.sync_issues(client, advisories, self.today)
        kept = next(issue for issue in client.issue_list if issue["state"] == "open")
        self.assertEqual(kept["number"], 8)
        self.assertEqual(gate.issue_state(kept)["first_seen"], "2026-08-01")
        self.assertIn("Due: 2026-08-31", kept["body"])
        self.assertEqual([(number, due) for _, number, due in overdue], [(8, date(2026, 8, 31))])
        self.assertEqual(client.of("create"), [])

    def test_duplicate_dates_fall_back_to_creation_date_when_invalid(self):
        advisories = self.findings([package("parser", "1.0.0", vulnerability("GHSA-1000", "LOW"))])
        invalid = self.issue(advisories, "GHSA-1000", date(2026, 11, 1), number=3)
        invalid["body"] = invalid["body"].replace('"first_seen": "2026-11-01"', '"first_seen": null')
        client = FakeGitHub([self.issue(advisories, "GHSA-1000", date(2026, 10, 1)), invalid])
        gate.sync_issues(client, advisories, self.today)
        kept = next(issue for issue in client.issue_list if issue["state"] == "open")
        self.assertEqual(kept["number"], 3)
        self.assertEqual(gate.issue_state(kept)["first_seen"], "2026-01-01")

    def test_closed_duplicates_reopen_only_the_earliest_issue(self):
        advisories = self.findings([package("parser", "1.0.0", vulnerability("GHSA-1000", "LOW"))])
        client = FakeGitHub([
            self.issue(advisories, "GHSA-1000", date(2026, 11, 1), number=1, state="closed"),
            self.issue(advisories, "GHSA-1000", date(2026, 9, 1), number=9, state="closed"),
            self.issue(advisories, "GHSA-1000", date(2026, 9, 1), number=7, state="closed"),
        ])
        gate.sync_issues(client, advisories, self.today)
        self.assertEqual([issue["number"] for issue in client.issue_list if issue["state"] == "open"], [7])
        self.assertEqual(client.of("update")[0][2]["state"], "open")
        self.assertEqual(gate.issue_state(client.issue_list[2])["first_seen"], "2026-09-01")
        self.assertEqual(client.of("create"), [])

    def test_gone_advisory_closes_every_open_duplicate_in_one_run(self):
        advisories = self.findings([package("parser", "1.0.0", vulnerability("GHSA-1000", "LOW"))])
        client = FakeGitHub([
            self.issue(advisories, "GHSA-1000", date(2026, 11, 1), number=3),
            self.issue(advisories, "GHSA-1000", date(2026, 10, 1), number=7),
            self.issue(advisories, "GHSA-1000", date(2026, 9, 1), number=9, state="closed"),
        ])
        overdue, actions = gate.sync_issues(client, {}, self.today)
        self.assertTrue(all(issue["state"] == "closed" for issue in client.issue_list))
        self.assertEqual({call[1] for call in client.of("update")}, {3, 7})
        self.assertEqual({call[1] for call in client.of("comment")}, {3, 7})
        self.assertEqual(len(actions), 2)
        self.assertEqual(overdue, [])

    def test_push_issue_writer_is_serialized_and_the_nightly_scan_cannot_be_cancelled_by_it(self):
        root = Path(__file__).resolve().parents[2]
        for workflow, job, grouped in (("ci.yml", "advisory-issues", True), ("nightly.yml", "security", False)):
            with self.subTest(workflow=workflow):
                text = (root / ".github" / "workflows" / workflow).read_text()
                job_block = re.search(rf"^  {job}:\n(.*?)(?=^  [\w-]+:|\Z)", text, re.M | re.S)
                self.assertIsNotNone(job_block)
                self.assertIn("--write-issues", job_block[1])
                concurrency = re.search(r"^    concurrency:\n(?:      .*\n)+", job_block[1], re.M)
                if not grouped:
                    # A pending job in a group is cancelled when a newer one queues, which would
                    # drop the night's scan.  Duplicate issues are consolidated by the next sync.
                    self.assertIsNone(concurrency)
                    continue
                self.assertIsNotNone(concurrency)
                settings = gate.pnpm_lock.parse(textwrap.dedent(concurrency[0]))["concurrency"]
                self.assertEqual(settings, {"group": "dependency-advisory-issues", "cancel-in-progress": "false"})

    def test_change_is_commented_and_the_issue_rewritten(self):
        advisories = self.findings([package("parser", "1.0.0", vulnerability("GHSA-1000", "HIGH"))])
        old = {"severity": "low", "blocks": False, "packages": ["pnpm-lock.yaml:parser@0.9.0"]}
        client = FakeGitHub([self.issue(advisories, "GHSA-1000", date(2026, 11, 1), fingerprint=old)])
        gate.sync_issues(client, advisories, self.today)
        comment = client.of("comment")[0][2]
        self.assertIn("severity changed from low to high", comment)
        self.assertIn("now in pnpm-lock.yaml:parser@1.0.0", comment)
        self.assertIn("no longer in pnpm-lock.yaml:parser@0.9.0", comment)
        update = client.of("update")[0][2]
        # The due date moves with the severity but keeps the first-seen date.
        self.assertEqual(update["title"], "GHSA-1000 in parser (high), due 2026-12-01")
        self.assertIn("First seen: 2026-11-01", update["body"])

    def test_closed_issue_reopens_with_its_first_seen_date(self):
        advisories = self.findings([package("parser", "1.0.0", vulnerability("GHSA-1000", "LOW"))])
        client = FakeGitHub([self.issue(advisories, "GHSA-1000", date(2026, 10, 1), state="closed")])
        gate.sync_issues(client, advisories, self.today)
        self.assertEqual(client.of("update")[0][2]["state"], "open")
        self.assertIn("2026-10-01", client.of("comment")[0][2])
        self.assertEqual(client.of("create"), [])

    def test_gone_advisory_closes_its_issue(self):
        advisories = self.findings([package("parser", "1.0.0", vulnerability("GHSA-1000", "LOW"))])
        issues = [self.issue(advisories, "GHSA-1000", date(2026, 11, 1))]
        client = FakeGitHub(issues + [{"number": 9, "state": "open", "body": "unrelated", "created_at": ""}])
        overdue, actions = gate.sync_issues(client, {}, self.today)
        self.assertEqual(client.of("update"), [("update", 7, {"state": "closed", "state_reason": "completed"})])
        self.assertIn("no longer reported", client.of("comment")[0][2])
        self.assertEqual(actions, ["Closed #7 for GHSA-1000"])

    def test_already_closed_gone_issue_is_left_closed(self):
        advisories = self.findings([package("parser", "1.0.0", vulnerability("GHSA-1000", "LOW"))])
        client = FakeGitHub([self.issue(advisories, "GHSA-1000", date(2026, 11, 1), state="closed")])
        gate.sync_issues(client, {}, self.today)
        self.assertEqual(client.of("update"), [])

    def test_past_due_is_reported_the_day_after_the_due_date(self):
        advisories = self.findings([package("parser", "1.0.0", vulnerability("GHSA-1000", "HIGH"))])
        client = FakeGitHub([self.issue(advisories, "GHSA-1000", date(2026, 10, 14))])
        overdue, _ = gate.sync_issues(client, advisories, date(2026, 11, 13))
        self.assertEqual(overdue, [])
        overdue, _ = gate.sync_issues(client, advisories, date(2026, 11, 14))
        self.assertEqual([(a.id, number, due) for a, number, due in overdue], [("GHSA-1000", 7, date(2026, 11, 13))])

    def test_blocking_advisory_with_an_issue_gets_a_comment_but_stays_open(self):
        advisories = self.findings([package("parser", "2.0.0", vulnerability("GHSA-1000", "HIGH"))])
        old = {"severity": "high", "blocks": False, "packages": ["pnpm-lock.yaml:parser@1.0.0"]}
        client = FakeGitHub([self.issue(advisories, "GHSA-1000", date(2026, 9, 1), fingerprint=old)])
        overdue, _ = gate.sync_issues(client, advisories, self.today)
        self.assertIn("it now blocks builds", client.of("comment")[0][2])
        self.assertNotIn("state", client.of("update")[0][2])
        # Blocking advisories already fail the build, so they are never also past due.
        self.assertEqual(overdue, [])


class MainTest(GateFixture):
    def run_main(self, packages, *arguments, client=None, today=date(2026, 11, 14), base=None):
        scan_path = self.root / "scan.json"
        scan_path.write_text(json.dumps(scan(self.root, packages)))
        argv = ["--scan", str(scan_path), "--root", str(self.root), *arguments]
        if base is not None:
            base_root = self.root / "base"
            base_root.mkdir(exist_ok=True)
            (base_root / "base.json").write_text(json.dumps(scan(base_root, base)))
            argv += ["--base-scan", str(base_root / "base.json"), "--base-root", str(base_root)]
        output = StringIO()
        with redirect_stdout(output):
            status = gate.main(argv, client_factory=(lambda: client) if client else None, today=today)
        return status, output.getvalue()

    def test_exit_status_follows_the_decision(self):
        status, output = self.run_main([package("parser", "2.0.0", vulnerability("GHSA-1000", "MODERATE"))])
        self.assertEqual(status, 1)
        self.assertIn("::error::GHSA-1000 blocks", output)
        self.assertIn("**blocks**", (self.root / "summary.md").read_text())
        status, output = self.run_main([package("parser", "1.0.0", vulnerability("GHSA-1000", "MODERATE"))])
        self.assertEqual(status, 0)
        self.assertIn("tracked in an issue", output)
        self.assertEqual(self.run_main([])[0], 0)

    def test_pull_request_mode_compares_with_the_base_and_writes_nothing(self):
        added = package("parser", "1.0.0", vulnerability("GHSA-1000", "LOW"))
        status, output = self.run_main([added], base=[])
        self.assertEqual(status, 1)
        self.assertIn("added by this pull request", output)
        self.assertEqual(self.run_main([added], base=[added])[0], 0)

    def test_exit_zero_reports_without_failing(self):
        client = FakeGitHub()
        status, output = self.run_main(
            [package("parser", "2.0.0", vulnerability("GHSA-1000", "MODERATE"))], "--write-issues", "--exit-zero",
            client=client,
        )
        self.assertEqual(status, 0)
        self.assertIn("::warning::GHSA-1000 blocks", output)

    def test_enforce_due_fails_past_due_issues(self):
        advisories = self.findings([package("parser", "1.0.0", vulnerability("GHSA-1000", "HIGH"))])
        body = gate.issue_body(advisories["GHSA-1000"], date(2026, 9, 1), date(2026, 10, 1))
        issue = {"number": 3, "state": "open", "body": body, "created_at": "2026-09-01T00:00:00Z"}
        found = [package("parser", "1.0.0", vulnerability("GHSA-1000", "HIGH"))]
        status, output = self.run_main(found, "--write-issues", "--enforce-due", client=FakeGitHub([issue]))
        self.assertEqual(status, 1)
        self.assertIn("::error::GHSA-1000 (#3) was due 2026-10-01", output)
        status, output = self.run_main(found, "--write-issues", client=FakeGitHub([issue]))
        self.assertEqual(status, 0)
        self.assertIn("::warning::GHSA-1000 (#3) was due", output)

    def test_unreadable_scan_fails(self):
        (self.root / "scan.json").write_text("{not json")
        output = StringIO()
        with redirect_stdout(output):
            status = gate.main(["--scan", str(self.root / "scan.json"), "--root", str(self.root)])
        self.assertEqual(status, 2)
        self.assertIn("::error::Cannot read the advisory scan", output.getvalue())

    def test_empty_scan_output_means_no_advisories(self):
        (self.root / "scan.json").write_text("")
        with redirect_stdout(StringIO()):
            self.assertEqual(gate.main(["--scan", str(self.root / "scan.json"), "--root", str(self.root)]), 0)

    def test_annotations_escape_workflow_commands(self):
        output = StringIO()
        with redirect_stdout(output):
            gate.annotate("error", "id%\r\n::warning::injected")
        self.assertEqual(output.getvalue(), "::error::id%25%0D%0A::warning::injected\n")


if __name__ == "__main__":
    unittest.main()
