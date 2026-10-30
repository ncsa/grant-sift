"""Report, then apply, the folding of duplicate listings (db.link_duplicates).

Dry run unless --apply. The dry run works on a throwaway copy, so it can be
pointed at a copy of the production database before the code that writes
duplicate_of is deployed:

    kubectl -n grant-sift cp <pod>:/data/grant-sift.db /tmp/prod.db
    python scripts/link_duplicates.py --db /tmp/prod.db

Every group is listed with the keys that joined it. The ones worth reading by
eye are flagged:

    BIG        more than three copies -- one bad key can chain unrelated calls
    URL-ONLY   joined by a link alone, no opportunity number
    TITLE      joined by title resemblance (an aggregator's copy, no key)
    UNLIKE     the members' titles share almost no words

With --apply it writes a backup next to the database, rebuilds every row's
keys and writes duplicate_of. Ingest does the same on every run, so --apply
is only needed to fold existing rows before the next run.
"""

import argparse
import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from grant_sift import db, pipeline  # noqa: E402


def _words(title):
    return set(db.title_core(title).split())


def flags(conn, group):
    keys = group["keys"]
    out = []
    if len(group["members"]) > 3:
        out.append("BIG")
    if any(k.startswith("title:") for k in keys):
        out.append("TITLE")
    elif not any(k.startswith(("num:", "gg:", "sam:")) for k in keys):
        out.append("URL-ONLY")
    titles = [r["title"] for r in conn.execute(
        f"SELECT title FROM opportunities WHERE id IN ({','.join('?' * len(group['members']))})",
        group["members"])]
    sets = [_words(t) for t in titles]
    common = set.intersection(*sets) if sets else set()
    smallest = min((len(s) for s in sets), default=0)
    if smallest and len(common) < 0.3 * smallest:
        out.append("UNLIKE")
    return out


def report(conn, groups, only_flagged):
    rows = {r["id"]: r for r in conn.execute(
        "SELECT id, source, title, deadline FROM opportunities")}
    groups = sorted(groups, key=lambda g: (-len(g["members"]), g["canonical"]))
    shown = 0
    for g in groups:
        f = flags(conn, g)
        if only_flagged and not f:
            continue
        shown += 1
        print(f"\n[{len(g['members'])}] {' '.join(f)}  keys: {', '.join(g['keys'][:6])}")
        for m in g["members"]:
            r = rows[m]
            mark = "*" if m == g["canonical"] else " "
            print(f"  {mark} {r['source'][:24]:24s} {r['deadline'] or 'rolling':10s} "
                  f"{m[:26]:26s} {r['title'][:90]}")
    dup = sum(len(g["members"]) - 1 for g in groups)
    by_flag = {}
    for g in groups:
        for f in flags(conn, g):
            by_flag[f] = by_flag.get(f, 0) + 1
    print(f"\n{len(groups)} calls listed more than once; {dup} copies would be hidden. "
          f"Shown above: {shown}. Flagged: {by_flag or 'none'}")
    print("* marks the copy that stays visible.")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--db", default=os.environ.get("GRANT_SIFT_DB", "grant-sift.db"))
    p.add_argument("--config", default="config")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--flagged", action="store_true", help="list only flagged groups")
    args = p.parse_args()

    sources = yaml.safe_load((Path(args.config) / "sources.yaml").read_text()) or {}
    aggregators = pipeline.aggregator_names(sources)
    print(f"aggregators: {', '.join(sorted(aggregators)) or 'none'}")

    if args.apply:
        backup = f"{args.db}.bak-{datetime.now():%Y%m%d-%H%M%S}"
        src = sqlite3.connect(args.db)
        src.backup(sqlite3.connect(backup))
        src.close()
        print(f"backup: {backup}")
        path = args.db
    else:
        tmp = tempfile.mkdtemp()
        path = os.path.join(tmp, "dry-run.db")
        src = sqlite3.connect(args.db)
        src.backup(sqlite3.connect(path))
        src.close()

    try:
        db.init(path)
        conn = db.connect(path)
        n = db.fill_missing_keys(conn, rebuild=True)
        print(f"keys computed for {n} rows")
        groups = db.link_duplicates(conn, aggregators, apply=args.apply)
        report(conn, groups, args.flagged)
        if args.apply:
            conn.commit()
            print("applied.")
        conn.close()
    finally:
        if not args.apply:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
