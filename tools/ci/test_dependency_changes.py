from contextlib import redirect_stdout
from io import StringIO
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import textwrap
import unittest
from unittest.mock import patch

import dependency_changes as changes
import github_api
import pnpm_lock


BASE = textwrap.dedent(
    """\
    importers:
      apps/web:
        dependencies:
          react:
            specifier: 19.0.0
            version: 19.0.0
          old-thing:
            specifier: 1.0.0
            version: 1.0.0
    snapshots:
      react@19.0.0:
        dependencies:
          scheduler: 1.0.0
      scheduler@1.0.0: {}
      old-thing@1.0.0: {}
    """
)

HEAD = textwrap.dedent(
    """\
    importers:
      apps/web:
        dependencies:
          react:
            specifier: 19.0.0
            version: 19.0.0
          charts:
            specifier: 2.0.0
            version: 2.0.0
      packages/ui:
        dependencies:
          react:
            specifier: 19.0.0
            version: 19.0.0
    snapshots:
      react@19.0.0:
        dependencies:
          scheduler: 1.0.0
      scheduler@1.0.0: {}
      charts@2.0.0:
        dependencies:
          renderer: 3.0.0
          scheduler: 1.0.0
      renderer@3.0.0:
        dependencies:
          math: 1.0.0
      math@1.0.0: {}
    """
)


class FakeGitHub:
    def __init__(self, comments=(), error=None):
        self.existing = list(comments)
        self.error = error
        self.calls = []

    def comments(self, number):
        if self.error:
            raise self.error
        self.calls.append(("comments", number))
        return self.existing

    def comment(self, number, body):
        self.calls.append(("comment", number, body))

    def update_comment(self, comment_id, body):
        self.calls.append(("update", comment_id, body))


class CompareTest(unittest.TestCase):
    def setUp(self):
        self.change = changes.compare(pnpm_lock.Lockfile(BASE), pnpm_lock.Lockfile(HEAD))

    def test_counts_added_and_removed_packages(self):
        self.assertEqual(self.change["added"], [("charts", "2.0.0"), ("math", "1.0.0"), ("renderer", "3.0.0")])
        self.assertEqual(self.change["removed"], [("old-thing", "1.0.0")])

    def test_counts_what_each_new_direct_dependency_brings(self):
        self.assertEqual(
            self.change["new_direct"],
            [
                # charts brings renderer, math, and the existing scheduler: two of them new.
                {"importer": "apps/web", "name": "charts", "total": 3, "new": 2},
                # A new package declaring a dependency is a new direct dependency too.
                {"importer": "packages/ui", "name": "react", "total": 1, "new": 0},
            ],
        )

    def test_render_states_the_totals_once(self):
        body = changes.render([self.change])
        self.assertTrue(body.startswith(changes.MARKER))
        self.assertIn("This change adds **3** packages and removes **1**.", body)
        self.assertIn("| `charts` | apps/web | 2 | 3 |", body)
        self.assertIn("`old-thing@1.0.0`", body)

    def test_unchanged_lockfiles(self):
        same = changes.compare(pnpm_lock.Lockfile(BASE), pnpm_lock.Lockfile(BASE))
        self.assertEqual((same["added"], same["removed"], same["new_direct"]), ([], [], []))
        self.assertIn("now match the base branch", changes.render([same]))

    def test_new_lockfile_counts_everything_as_added(self):
        change = changes.compare(pnpm_lock.Lockfile(""), pnpm_lock.Lockfile(BASE), "integrations/zapier/pnpm-lock.yaml")
        self.assertEqual(len(change["added"]), 3)
        self.assertEqual(change["new_direct"][0]["importer"], "apps/web")

    def test_root_importer_is_named_after_its_lockfile(self):
        self.assertEqual(changes.importer_label("pnpm-lock.yaml", "."), "the root")
        self.assertEqual(changes.importer_label("integrations/zapier/pnpm-lock.yaml", "."), "integrations/zapier")


class PublishTest(unittest.TestCase):
    def test_posts_once_then_edits(self):
        client = FakeGitHub()
        self.assertEqual(changes.publish(client, 5, "body", True), "posted")
        self.assertEqual(client.calls[-1], ("comment", 5, "body"))
        client = FakeGitHub([{"id": 9, "body": changes.MARKER + "\nold"}, {"id": 10, "body": "someone else"}])
        self.assertEqual(changes.publish(client, 5, changes.MARKER + "\nnew", True), "updated")
        self.assertEqual(client.calls[-1], ("update", 9, changes.MARKER + "\nnew"))
        self.assertEqual(changes.publish(client, 5, changes.MARKER + "\nold", True), "unchanged")

    def test_no_comment_when_nothing_changed_and_none_exists(self):
        client = FakeGitHub()
        self.assertEqual(changes.publish(client, 5, "body", False), "skipped")
        self.assertEqual([c[0] for c in client.calls], ["comments"])

    def test_existing_comment_is_updated_even_when_the_change_is_reverted(self):
        client = FakeGitHub([{"id": 9, "body": changes.MARKER + "\nold"}])
        self.assertEqual(changes.publish(client, 5, changes.MARKER + "\nmatch", False), "updated")


class MainTest(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.root = Path(self.directory.name)
        (self.root / "head").mkdir()
        (self.root / "base").mkdir()
        (self.root / "head" / "pnpm-lock.yaml").write_text(HEAD)
        (self.root / "base" / "pnpm-lock.yaml").write_text(BASE)
        (self.root / "event.json").write_text(json.dumps({"pull_request": {"number": 42}}))
        self.environment = {
            "GITHUB_EVENT_PATH": str(self.root / "event.json"),
            "GITHUB_STEP_SUMMARY": str(self.root / "summary.md"),
        }

    def tearDown(self):
        self.directory.cleanup()

    def run_main(self, *extra, client=None, environment=None):
        argv = ["--root", str(self.root / "head"), "--base-root", str(self.root / "base"), "--lockfile", "pnpm-lock.yaml"]
        output = StringIO()
        with redirect_stdout(output), patch.dict(os.environ, {**self.environment, **(environment or {})}):
            status = changes.main(argv + list(extra), client_factory=(lambda: client) if client else None)
        return status, output.getvalue()

    def test_reports_without_posting_by_default(self):
        status, output = self.run_main()
        self.assertEqual(status, 0)
        self.assertIn("adds **3**", output)
        self.assertNotIn(changes.MARKER, (self.root / "summary.md").read_text())

    def test_posts_to_the_pull_request(self):
        client = FakeGitHub()
        status, output = self.run_main("--post", client=client)
        self.assertEqual(status, 0)
        self.assertEqual(client.calls[-1][:2], ("comment", 42))
        self.assertIn("Comment posted", output)

    def test_a_refused_comment_warns_without_failing(self):
        client = FakeGitHub(error=github_api.GitHubError("403 from a fork"))
        status, output = self.run_main("--post", client=client)
        self.assertEqual(status, 0)
        self.assertIn("::warning::Could not post the dependency comment", output)

    def test_without_a_pull_request_nothing_is_posted(self):
        client = FakeGitHub()
        status, output = self.run_main("--post", client=client, environment={"GITHUB_EVENT_PATH": ""})
        self.assertEqual((status, client.calls), (0, []))
        self.assertIn("::warning::No pull request number", output)


if __name__ == "__main__":
    unittest.main()
