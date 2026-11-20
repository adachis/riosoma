from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
import tomllib
import unittest
from unittest.mock import patch

import check_advisory_ignores as checker


class AdvisoryIgnoresTest(unittest.TestCase):
    now = datetime(2026, 10, 30, tzinfo=timezone.utc)

    def check(self, fields):
        return checker.check_ignores(
            tomllib.loads('[[IgnoredVulns]]\nid = "GHSA-example"\n' + fields), self.now
        )

    def test_existing_toml_date_and_timestamp_formats(self):
        for expiry in ("2027-01-31", "2027-01-31T00:00:00Z", "2027-01-31T01:00:00+01:00"):
            with self.subTest(expiry=expiry):
                self.assertEqual(self.check(f'ignoreUntil = {expiry}\nreason = "Review upstream"'), ([], []))

    def test_missing_or_empty_reason(self):
        for reason in ("", 'reason = ""', 'reason = "  "', "reason = 1"):
            with self.subTest(reason=reason):
                errors, _ = self.check("ignoreUntil = 2027-01-31\n" + reason)
                self.assertEqual(len(errors), 1)
                self.assertIn("reason", errors[0])

    def test_missing_or_invalid_expiry(self):
        for expiry in ("", "ignoreUntil = 42", 'ignoreUntil = "tomorrow"', "ignoreUntil = 2026-11-01T00:00:00"):
            with self.subTest(expiry=expiry):
                errors, _ = self.check('reason = "Review upstream"\n' + expiry)
                self.assertEqual(len(errors), 1)
                self.assertIn("ignoreUntil", errors[0])

    def test_120_day_limit_is_inclusive(self):
        expiry = self.now + timedelta(days=120)
        self.assertEqual(self.check(f'ignoreUntil = {expiry.isoformat()}\nreason = "Review"'), ([], []))
        expiry += timedelta(seconds=1)
        errors, _ = self.check(f'ignoreUntil = {expiry.isoformat()}\nreason = "Review"')
        self.assertIn("more than 120 days", errors[0])

    def test_21_day_warning_boundary_is_inclusive(self):
        expiry = self.now + timedelta(days=21)
        errors, warnings = self.check(f'ignoreUntil = {expiry.isoformat()}\nreason = "Review"')
        self.assertEqual(errors, [])
        self.assertEqual(len(warnings), 1)
        expiry += timedelta(seconds=1)
        self.assertEqual(self.check(f'ignoreUntil = {expiry.isoformat()}\nreason = "Review"'), ([], []))

    def test_expired_or_expiring_now_fails(self):
        for expiry in (self.now, self.now - timedelta(seconds=1)):
            with self.subTest(expiry=expiry):
                errors, warnings = self.check(f'ignoreUntil = {expiry.isoformat()}\nreason = "Review"')
                self.assertIn("has expired", errors[0])
                self.assertEqual(warnings, [])

    def test_checks_every_ignore_and_reports_warnings_alongside_errors(self):
        config = tomllib.loads('''
[[IgnoredVulns]]
id = "first"
ignoreUntil = 2026-11-01T00:00:00Z
[[IgnoredVulns]]
id = "second"
reason = "Review"
ignoreUntil = 2026-11-02
''')
        errors, warnings = checker.check_ignores(config, self.now)
        self.assertEqual(len(errors), 1)
        self.assertEqual(len(warnings), 2)
        self.assertIn("first", warnings[0])
        self.assertIn("second", warnings[1])

    def test_no_ignores_is_valid(self):
        self.assertEqual(checker.check_ignores({}, self.now), ([], []))

    def test_malformed_ignore_collection_fails(self):
        for ignores in ({}, "bad", [1]):
            with self.subTest(ignores=ignores):
                errors, _ = checker.check_ignores({"IgnoredVulns": ignores}, self.now)
                self.assertTrue(errors)

    def test_annotation_escapes_workflow_commands(self):
        output = StringIO()
        with redirect_stdout(output):
            checker.annotation("warning", "id%\r\n::error::injected")
        self.assertEqual(
            output.getvalue(),
            "::warning file=osv-scanner.toml::id%25%0D%0A::error::injected\n",
        )

    def test_cli_reads_toml_and_sets_exit_status(self):
        with TemporaryDirectory(dir=Path(__file__).parent) as directory:
            config = Path(directory) / "osv-scanner.toml"
            for content, status, annotation in (
                ("", 0, ""),
                ('[[IgnoredVulns]]\nid = "missing-fields"', 1, "::error"),
                ("invalid = [", 1, "::error"),
            ):
                with self.subTest(content=content):
                    config.write_text(content)
                    output = StringIO()
                    with patch.object(checker, "CONFIGS", (config,)), redirect_stdout(output):
                        self.assertEqual(checker.main(), status)
                    self.assertIn(annotation, output.getvalue())
            config.unlink()
            with patch.object(checker, "CONFIGS", (config,)), redirect_stdout(StringIO()):
                self.assertEqual(checker.main(), 1)

    def test_cli_checks_every_config_and_names_the_failing_file(self):
        with TemporaryDirectory(dir=Path(__file__).parent) as directory:
            valid = Path(directory) / "osv-scanner.toml"
            nested = Path(directory) / "nested" / "osv-scanner.toml"
            nested.parent.mkdir()
            valid.write_text("")
            nested.write_text('[[IgnoredVulns]]\nid = "missing-fields"')
            output = StringIO()
            with (
                patch.object(checker, "ROOT", Path(directory)),
                patch.object(checker, "CONFIGS", (valid, nested)),
                redirect_stdout(output),
            ):
                self.assertEqual(checker.main(), 1)
            self.assertIn("::error file=nested/osv-scanner.toml::missing-fields", output.getvalue())
            self.assertNotIn("file=osv-scanner.toml", output.getvalue())

    def test_every_config_exists(self):
        for config in checker.CONFIGS:
            with self.subTest(config=config):
                self.assertTrue(config.is_file())


if __name__ == "__main__":
    unittest.main()
