#!/usr/bin/env bash
# Move the SQLite database off the NFS claim onto a Cinder block volume (#25).
#
# Usage:
#   ./scripts/k8s-migrate-db-to-cinder.sh [namespace]
#
# What it does, in order:
#   1. marks the old NFS claim "keep", so the helm upgrade that stops rendering
#      it does not delete it - it is the rollback;
#   2. creates the Cinder claim (RWO, csi-cinder-sc-retain);
#   3. scales the app to 0, so nothing writes while the copy runs;
#   4. copies the database with SQLite's online backup API, which carries any
#      WAL content across, then runs integrity_check and compares row counts.
#
# It leaves the app at 0 replicas. The helm upgrade that points the release
# at the new claim brings it back (the chart sets replicas: 1). If the copy
# fails, it scales the app back up on the old claim instead.
set -euo pipefail

NAMESPACE="${1:-grant-sift}"
DEPLOY="grant-sift"
OLD_CLAIM="grant-sift-data"
NEW_CLAIM="grant-sift-data-cinder"
STORAGE_CLASS="csi-cinder-sc-retain"
SIZE="2Gi"
DB="grant-sift.db"

# The app's own image, for Python's sqlite3. busybox has no sqlite, and a plain
# cp of a WAL database can miss committed pages still sitting in the -wal file.
IMAGE="$(kubectl -n "$NAMESPACE" get deploy/"$DEPLOY" \
  -o jsonpath='{.spec.template.spec.containers[0].image}')"
echo "namespace $NAMESPACE, image $IMAGE"

echo "keeping $OLD_CLAIM when helm stops managing it"
kubectl -n "$NAMESPACE" annotate pvc "$OLD_CLAIM" helm.sh/resource-policy=keep --overwrite

echo "creating $NEW_CLAIM ($STORAGE_CLASS, $SIZE)"
cat <<EOF | kubectl -n "$NAMESPACE" apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${NEW_CLAIM}
  labels:
    app.kubernetes.io/name: grant-sift
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: ${STORAGE_CLASS}
  resources:
    requests:
      storage: ${SIZE}
EOF

echo "stopping writes: scaling $DEPLOY to 0"
kubectl -n "$NAMESPACE" scale deploy/"$DEPLOY" --replicas=0
kubectl -n "$NAMESPACE" wait --for=delete pod -l "app.kubernetes.io/name=grant-sift" --timeout=120s || true

JOB_POD="grant-sift-db-migrate-$$"
restore_old() {
  echo "copy failed: bringing $DEPLOY back up on $OLD_CLAIM" >&2
  kubectl -n "$NAMESPACE" scale deploy/"$DEPLOY" --replicas=1
}
cleanup() {
  kubectl -n "$NAMESPACE" delete pod "$JOB_POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Runs as the app's uid so the new file is owned the way the app expects.
# Refuses to overwrite a database already on the new claim: a second run after
# the app has been writing there would otherwise roll it back to the NFS copy.
cat <<EOF | kubectl -n "$NAMESPACE" apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: ${JOB_POD}
  labels:
    app.kubernetes.io/name: grant-sift-db-migrate
spec:
  restartPolicy: Never
  securityContext:
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
  containers:
    - name: migrate
      image: ${IMAGE}
      command:
        - python
        - -c
        - |
          import os, sqlite3, sys
          src_path, dst_path = "/old/${DB}", "/new/${DB}"
          if os.path.exists(dst_path):
              sys.exit(f"{dst_path} already exists; not overwriting")
          src = sqlite3.connect(src_path)
          dst = sqlite3.connect(dst_path)
          src.backup(dst)
          ok = dst.execute("PRAGMA integrity_check").fetchone()[0]
          print("integrity_check:", ok)
          if ok != "ok":
              sys.exit("integrity check failed on the copy")
          tables = [r[0] for r in src.execute(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
          bad = []
          for t in tables:
              a = src.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
              b = dst.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
              print(f"{t:24} {a:>8} {b:>8}")
              if a != b:
                  bad.append(t)
          if bad:
              sys.exit(f"row counts differ: {bad}")
          dst.execute("PRAGMA journal_mode=WAL")
          dst.close(); src.close()
          print("size MB", round(os.path.getsize(dst_path) / 2**20, 1))
      volumeMounts:
        - name: old
          mountPath: /old
        - name: new
          mountPath: /new
  volumes:
    - name: old
      persistentVolumeClaim:
        claimName: ${OLD_CLAIM}
    - name: new
      persistentVolumeClaim:
        claimName: ${NEW_CLAIM}
EOF

echo "copying $OLD_CLAIM -> $NEW_CLAIM"
if ! kubectl -n "$NAMESPACE" wait "pod/${JOB_POD}" \
     --for=jsonpath='{.status.phase}'=Succeeded --timeout=300s; then
  kubectl -n "$NAMESPACE" logs "pod/${JOB_POD}" >&2 || true
  restore_old
  exit 1
fi
kubectl -n "$NAMESPACE" logs "pod/${JOB_POD}"

cat <<EOF

Copied. $DEPLOY is still at 0 replicas. Point the release at the new claim:

  helm upgrade --install grant-sift ./helm/grant-sift -n $NAMESPACE \\
    -f helm/grant-sift/values-software-dev.yaml \\
    -f helm/grant-sift/values-secrets.yaml

Then check it:

  kubectl -n $NAMESPACE exec deploy/$DEPLOY -- python run.py status

Rollback: set persistence.existingClaim to $OLD_CLAIM and run the same helm
upgrade. $OLD_CLAIM was not written to.
EOF
