CREATE TABLE telemetry (
  install_id TEXT NOT NULL,
  week TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (install_id, week)
);
CREATE INDEX telemetry_week ON telemetry (week);

CREATE TABLE bug_reports (
  fingerprint TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  platform TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'filing', 'filed', 'review')),
  claim TEXT,
  issue_number INTEGER,
  issue_url TEXT,
  last_comment_day TEXT
);
CREATE TABLE bug_versions (
  fingerprint TEXT NOT NULL REFERENCES bug_reports (fingerprint),
  version TEXT NOT NULL,
  PRIMARY KEY (fingerprint, version)
);
CREATE TABLE bug_install_days (
  install_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (install_id, day)
);
CREATE TABLE bug_issue_days (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
