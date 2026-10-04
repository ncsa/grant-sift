#!/bin/sh
# Persist SQLite on /data (PVC in Kubernetes; the Deployment is its only writer).
set -eu

mkdir -p /data

export GRANT_SIFT_DB="${GRANT_SIFT_DB:-/data/grant-sift.db}"

if [ ! -f "${GRANT_SIFT_ROSTER:-/app/config/roster.yaml}" ]; then
    echo "warning: no roster at ${GRANT_SIFT_ROSTER:-/app/config/roster.yaml};" \
         "assess needs config/roster.yaml (see config/roster.example.yaml)" >&2
fi

exec "$@"
