#!/bin/sh
set -e

cloud-sql-proxy "${CLOUD_SQL_INSTANCE}" &

# Wait for proxy to open the local port
until nc -z 127.0.0.1 5432 2>/dev/null; do
  sleep 0.5
done

exec bun src/index.ts --production --no-env-file
