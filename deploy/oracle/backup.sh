#!/bin/sh
# Daily copy of the catalogue database. Installed to /etc/cron.daily by setup.sh. Keeps 14 days.
set -e
DB=/var/lib/muhallareads/muhallareads.db
DIR=/var/backups/muhallareads
[ -f "$DB" ] || exit 0
mkdir -p "$DIR"
OUT="$DIR/muhallareads-$(date +%F).db"
sqlite3 "$DB" ".backup '$OUT'"
chgrp adm "$OUT" && chmod 640 "$OUT"
find "$DIR" -name 'muhallareads-*.db' -mtime +14 -delete
