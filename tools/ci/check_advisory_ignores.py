"""Keep OSV exceptions short-lived and announce their review window in Actions."""

from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
import sys
import tomllib


ROOT = Path(__file__).resolve().parents[2]
# osv-scanner reads the configuration beside each lockfile it scans, so every folder with its own
# lockfile and exceptions keeps its own file.
CONFIGS = (ROOT / "osv-scanner.toml", ROOT / "integrations/n8n/osv-scanner.toml")


def check_ignores(config, now):
    errors = []
    warnings = []
    ignores = config.get("IgnoredVulns", [])
    if not isinstance(ignores, list):
        return ["IgnoredVulns must be an array of tables"], warnings

    for index, ignore in enumerate(ignores, 1):
        if not isinstance(ignore, dict):
            errors.append(f"Ignore {index} must be a table")
            continue
        label = ignore.get("id", f"Ignore {index}")
        reason = ignore.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            errors.append(f"{label}: a nonempty reason is required")

        expiry = ignore.get("ignoreUntil")
        # TOML local dates expire at midnight UTC, as they do in osv-scanner.
        if isinstance(expiry, date) and not isinstance(expiry, datetime):
            expiry = datetime.combine(expiry, time(), timezone.utc)
        if not isinstance(expiry, datetime) or expiry.tzinfo is None:
            errors.append(f"{label}: ignoreUntil must be a TOML date or a timestamp with a timezone")
            continue

        remaining = expiry - now
        if remaining <= timedelta(0):
            errors.append(f"{label}: ignoreUntil has expired ({expiry.isoformat()})")
        elif remaining > timedelta(days=120):
            errors.append(f"{label}: ignoreUntil is more than 120 days away ({expiry.isoformat()})")
        elif remaining <= timedelta(days=21):
            warnings.append(f"{label}: ignore expires at {expiry.isoformat()}; review it within 21 days")

    return errors, warnings


def annotation(level, message, file="osv-scanner.toml"):
    escaped = str(message).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    print(f"::{level} file={file}::{escaped}")


def main():
    failed = False
    for path in CONFIGS:
        file = path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path.name
        try:
            with path.open("rb") as source:
                config = tomllib.load(source)
            errors, warnings = check_ignores(config, datetime.now(timezone.utc))
        except (OSError, ValueError) as error:
            errors, warnings = [f"Cannot read {file}: {error}"], []
        for warning in warnings:
            annotation("warning", warning, file)
        for error in errors:
            annotation("error", error, file)
        failed = failed or bool(errors)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
