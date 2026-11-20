"""Keep CI reports on the runner even when GitHub artifact storage is full."""

import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path
import re
import tarfile
import time


def keep_report(source: Path, reports: Path, name: str, now: datetime) -> Path | None:
    reports.mkdir(parents=True, exist_ok=True)
    cutoff = (now - timedelta(days=14)).timestamp()
    for archive in reports.glob('*.tar.gz'):
        if archive.stat().st_mtime < cutoff:
            archive.unlink()
    if not source.exists():
        print(f'No report at {source}')
        return None
    label = re.sub(r'[^A-Za-z0-9_.-]', '-', name)
    archive = reports / f'{now:%Y%m%dT%H%M%SZ}-{label}-{time.time_ns()}.tar.gz'
    partial = archive.with_suffix('.tmp')
    try:
        with tarfile.open(partial, 'w:gz') as output:
            output.add(source, arcname=source.name)
        partial.rename(archive)
    finally:
        partial.unlink(missing_ok=True)
    print(f'Kept report at {archive}')
    return archive


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('name')
    args = parser.parse_args()
    keep_report(args.source, Path.home() / 'riosoma-ci/reports', args.name, datetime.now(timezone.utc))


if __name__ == '__main__':
    main()
