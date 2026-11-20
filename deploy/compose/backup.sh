#!/bin/sh
# Backups for the Compose backup profile, run inside the postgres image.
#   riosoma-backup schedule       dump every day at BACKUP_TIME (UTC), the service's default
#   riosoma-backup once           dump now and exit
#   riosoma-backup restore FILE   replace the database's contents with a dump from /backups
# Each dump is a pg_dump custom-format archive of the whole database, written under a temporary
# name and renamed when complete, so a file named riosoma-*.dump is always a whole one.  Dumps older
# than BACKUP_KEEP_DAYS days are removed after each successful run.
set -eu
set -o pipefail
umask 077

dir=/backups
url=${BACKUP_DATABASE_URL:-}
time=${BACKUP_TIME:-03:00}
keep=${BACKUP_KEEP_DAYS:-14}

fail() {
  echo "riosoma-backup: $*" >&2
  exit 1
}

case $time in
  [01][0-9]:[0-5][0-9] | 2[0-3]:[0-5][0-9]) ;;
  *) fail "BACKUP_TIME must be HH:MM in 24-hour time, not $time" ;;
esac
case $keep in
  '' | *[!0-9]* | 0) fail 'BACKUP_KEEP_DAYS must be a whole number of days, 1 or more' ;;
esac
[ -n "$url" ] || fail 'set RIOSOMA_DATABASE_URL, or BACKUP_DATABASE_URL, in .env'

backup() {
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  partial="$dir/.riosoma-$stamp.dump.partial"
  if pg_dump --format=custom --dbname="$url" --file="$partial"; then
    mv "$partial" "$dir/riosoma-$stamp.dump"
    echo "riosoma-backup: wrote riosoma-$stamp.dump ($(du -h "$dir/riosoma-$stamp.dump" | cut -f1))"
  else
    rm -f "$partial"
    echo 'riosoma-backup: pg_dump failed, and older backups were kept' >&2
    return 1
  fi
  # -mtime +N matches files at least N+1 whole days old, so this keeps the last $keep days.
  find "$dir" -maxdepth 1 -type f -name 'riosoma-*.dump' -mtime "+$((keep - 1))" -print -delete |
    sed 's/^/riosoma-backup: removed /'
}

restore() {
  file="$dir/$(basename "${1:-}")"
  [ -f "$file" ] || fail "no backup named ${1:-} in $dir"
  connected=$(psql --dbname="$url" --tuples-only --no-align --command \
    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND application_name LIKE 'riosoma%'")
  [ "$connected" = 0 ] || fail 'Riosoma is still connected.  Stop it first: docker compose stop riosoma'
  # Drop every schema the dump holds, so tables a newer release added don't outlive the restore.
  for schema in $(pg_restore --list "$file" | awk '$4 == "SCHEMA" && $5 == "-" { print $6 }'); do
    psql --dbname="$url" --quiet -v ON_ERROR_STOP=1 \
      --command 'SET client_min_messages = warning' --command "DROP SCHEMA IF EXISTS \"$schema\" CASCADE"
  done
  # A newer client writes SET transaction_timeout, which servers before PostgreSQL 17 don't know.
  pg_restore --clean --if-exists --no-owner --file=- "$file" |
    sed '/^SET transaction_timeout = /d' |
    psql --dbname="$url" --quiet --single-transaction -v ON_ERROR_STOP=1 >/dev/null
  echo "riosoma-backup: restored $(basename "$file")"
}

case ${1:-schedule} in
  once)
    backup
    ;;
  restore)
    restore "${2:-}"
    ;;
  schedule)
    trap 'exit 0' INT TERM
    echo "riosoma-backup: backing up daily at $time UTC, keeping $keep days"
    while :; do
      now=$(date -u +%s)
      next=$(date -u -d "$(date -u +%Y-%m-%d) $time" +%s)
      [ "$next" -gt "$now" ] || next=$((next + 86400))
      sleep $((next - now)) &
      wait $!
      backup || true
    done
    ;;
  *)
    fail "unknown command $1 (use schedule, once, or restore FILE)"
    ;;
esac
