#!/bin/sh
set -e

# The /app/data volume is mounted as root — ensure appuser can write to it
mkdir -p /app/data/downloads
chown -R appuser:appgroup /app/data

exec su-exec appuser node index.js
