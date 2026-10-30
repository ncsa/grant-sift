"""Remove Illinois Research Board records stored before it became a listing rule.

Until 5877cb0 the UIUC featured-funding page was a plain foundation page, so
every call it yielded got id fnd:synthetic_id(<listing url>, <title>). The
listing rule reads each /rfp/ page instead and keys on THAT url, so the old
records are never refreshed or replaced and show up beside the new ones.

Matches on the exact old id, recomputed from the title, so nothing the listing
rule wrote can be caught. Records with feedback are kept: the calibration
corpus cannot be re-fetched (same rule as db.prune_expired).

Dry run unless --apply. With --apply it first writes a backup next to the db.
Stdlib only, so it runs in the deployed pod without the new code:

    kubectl -n grant-sift exec -i deploy/grant-sift -- python - < scripts/clean_legacy_uiuc.py
    kubectl -n grant-sift exec -i deploy/grant-sift -- python - --apply < scripts/clean_legacy_uiuc.py
"""

import hashlib
import os
import sqlite3
import sys
from datetime import datetime

SOURCE = "Illinois Research Board"
LISTING = "https://research.illinois.edu/find-funding/featured-funding-opportunities"


def synthetic_id(source_url, program_name):
    # Copy of grant_sift.db.synthetic_id / hash_text, so this needs no import.
    name = "".join(c.lower() for c in program_name if c.isalnum() or c.isspace())
    name = " ".join(name.split())
    joined = "\x1f".join([source_url, name])
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:20]


def main():
    apply = "--apply" in sys.argv[1:]
    path = os.environ.get("GRANT_SIFT_DB", "grant-sift.db")
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        "SELECT id, title, deadline FROM opportunities WHERE source = ?", (SOURCE,)
    ).fetchall()
    legacy = [r for r in rows if r["id"] == f"fnd:{synthetic_id(LISTING, r['title'])}"]
    with_feedback = {
        r["opportunity_id"]
        for r in conn.execute(
            "SELECT DISTINCT opportunity_id FROM feedback WHERE opportunity_id IN (%s)"
            % ",".join("?" * len(legacy)),
            [r["id"] for r in legacy],
        )
    } if legacy else set()
    drop = [r for r in legacy if r["id"] not in with_feedback]

    print(f"db: {path}")
    print(f"{SOURCE}: {len(rows)} records, {len(legacy)} legacy, "
          f"{len(with_feedback)} kept for feedback, {len(drop)} to delete")
    for r in drop:
        print(f"  {r['deadline'] or '----------'}  {r['title'][:90]}")

    if not apply:
        print("dry run; pass --apply to delete")
        return
    if not drop:
        return

    backup = f"{path}.bak-{datetime.now():%Y%m%d-%H%M%S}"
    with sqlite3.connect(backup) as dst:
        conn.backup(dst)
    print(f"backup: {backup}")

    ids = [r["id"] for r in drop]
    marks = ",".join("?" * len(ids))
    with conn:
        conn.execute(f"DELETE FROM assessments WHERE opportunity_id IN ({marks})", ids)
        n = conn.execute(f"DELETE FROM opportunities WHERE id IN ({marks})", ids).rowcount
    print(f"deleted {n}")


if __name__ == "__main__":
    main()
