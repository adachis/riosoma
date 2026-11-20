from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import tarfile
from tempfile import TemporaryDirectory
import unittest

from keep_report import keep_report


class KeepReportTest(unittest.TestCase):
    def test_preserves_complete_report_and_prunes_only_expired_archives(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            reports = root / 'reports'
            reports.mkdir()
            source = root / 'playwright-report'
            (source / 'data').mkdir(parents=True)
            (source / 'index.html').write_text('report')
            (source / 'data/trace.zip').write_bytes(b'trace')
            now = datetime.now(timezone.utc)
            old = reports / 'old.tar.gz'
            old.touch()
            expired = (now - timedelta(days=15)).timestamp()
            os.utime(old, (expired, expired))
            recent = reports / 'recent.tar.gz'
            recent.touch()
            archive = keep_report(source, reports, 'nightly-firefox-42-1', now)
            self.assertFalse(old.exists())
            self.assertTrue(recent.exists())
            with tarfile.open(archive) as saved:
                self.assertEqual(saved.extractfile('playwright-report/index.html').read(), b'report')
                self.assertEqual(saved.extractfile('playwright-report/data/trace.zip').read(), b'trace')
            self.assertTrue((source / 'data/trace.zip').exists())
            self.assertNotEqual(archive, keep_report(source, reports, 'nightly-firefox-42-1', now))

    def test_missing_report_still_prunes_and_does_not_fail(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.assertIsNone(keep_report(root / 'missing', root / 'reports', 'ci', datetime.now(timezone.utc)))
            self.assertEqual(list((root / 'reports').iterdir()), [])


if __name__ == '__main__':
    unittest.main()
