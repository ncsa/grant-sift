"""The Scoring panel: scoring_version, /api/scoring, per-record provenance (#66).

Stdlib only:  python -m unittest discover tests
"""

import os
import sqlite3
import tempfile
import unittest
from datetime import date, timedelta
from unittest import mock

from grant_sift import db, llm, pipeline, server, telemetry

LATER = (date.today() + timedelta(days=60)).isoformat()


def opp(conn, i):
    db.upsert_opportunity(conn, {
        "id": i, "source": "grants.gov", "title": f"Call {i}", "agency": "NSF",
        "url": f"https://example.org/{i}", "deadline": LATER,
        "synopsis": "Build one.", "raw": {}})


class Migration(unittest.TestCase):
    def test_adds_scoring_version_without_touching_existing_rows(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "old.db")
            # An assessments table as it was before #66 and #67.
            raw = sqlite3.connect(path)
            raw.execute("""CREATE TABLE assessments (
                opportunity_id TEXT PRIMARY KEY, score INTEGER, category TEXT,
                rationale TEXT, match_name TEXT, match_project TEXT,
                match_status TEXT, match_rationale TEXT, model TEXT,
                input_hash TEXT, assessed_at TEXT)""")
            raw.execute("INSERT INTO assessments VALUES ('c1', 64, 'ci_program', 'r', NULL, NULL,"
                        " NULL, NULL, 'glm-5.2', 'h', '2026-01-02T03:04:05+00:00')")
            raw.commit()
            raw.close()

            db.init(path)
            conn = db.connect(path)
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(assessments)")}
            self.assertTrue({"scoring_version", "fallback_for"} <= cols)
            row = dict(conn.execute("SELECT * FROM assessments").fetchone())
            conn.close()
            self.assertEqual((row["score"], row["model"], row["assessed_at"]),
                             (64, "glm-5.2", "2026-01-02T03:04:05+00:00"))
            self.assertIsNone(row["scoring_version"])
            self.assertIsNone(row["fallback_for"])


class Panel(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "t.db")
        db.init(self.path)
        conn = db.connect(self.path)
        for i in ("c1", "c2", "c3", "c4"):
            opp(conn, i)
        db.save_assessment(conn, "c1", {"score": 80}, "gemma", "h")             # before versioning
        db.save_assessment(conn, "c2", {"score": 70}, "gemma", "h", scoring_version=1)
        db.save_assessment(conn, "c3", {"score": 60}, "gemma", "h", scoring_version=1)
        db.save_assessment(conn, "c4", {"score": 50}, "qwen", "h",
                           fallback_for="gemma", scoring_version=1)
        conn.commit()
        conn.close()
        self.patches = [
            mock.patch.object(server, "_conn", lambda: db.connect(self.path)),
            mock.patch.object(server.auth, "principal", lambda r: None),
            mock.patch.object(server, "_roster_entries", lambda: [{}, {}, {}]),
            mock.patch.object(llm, "MODELS", ["gemma", "qwen"]),
            mock.patch.object(llm, "MODEL", "gemma"),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.dir.cleanup()

    def test_api_scoring(self):
        d = server.scoring(None)
        now = d["now"]
        self.assertEqual((now["model"], now["fallbacks"]), ("gemma", ["qwen"]))
        self.assertEqual(now["scoring_version"], llm.SCORING_VERSION)
        self.assertEqual(now["roster_size"], 3)
        self.assertIsNotNone(now["last_pass"])
        self.assertIn("thinking", now)
        self.assertEqual(d["live_total"], 4)
        by = {(b["model"], b["scoring_version"]): (b["count"], b["fallback"]) for b in d["breakdown"]}
        self.assertEqual(by, {("gemma", 1): (2, 0), ("gemma", None): (1, 0), ("qwen", 1): (1, 1)})
        self.assertEqual(d["breakdown"][0]["model"], "gemma")     # biggest first
        self.assertEqual(d["fallback_scored"]["count"], 1)
        self.assertTrue(d["axes"] and d["categories"] and d["label"])

    def test_no_model_call(self):
        with mock.patch.object(server.requests, "post", side_effect=AssertionError("called")):
            server.scoring(None)

    def test_catalogue_rows_carry_provenance(self):
        conn = db.connect(self.path)
        rows = {r["id"]: r for r in pipeline.catalogue_rows(conn, {})}
        conn.close()
        self.assertEqual((rows["c4"]["model"], rows["c4"]["scoring_version"],
                          rows["c4"]["fallback_for"]), ("qwen", 1, "gemma"))
        self.assertIsNone(rows["c1"]["scoring_version"])
        self.assertTrue(rows["c1"]["assessed_at"])

    def test_rollup_counts_by_version(self):
        conn = db.connect(self.path)
        telemetry.record_daily(conn)
        stats = {r["dim"]: r["value"] for r in telemetry.query_rows(
            conn, metric="assessed_by_scoring_version", since_days=None)}
        conn.close()
        self.assertEqual(stats, {"none": 1, "1": 3})


class AssessStampsTheVersion(unittest.TestCase):
    def test_assess_new_writes_scoring_version(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "t.db")
            db.init(path)
            conn = db.connect(path)
            opp(conn, "c1")
            conn.commit()
            with mock.patch.object(llm, "assess",
                                   lambda *a, **k: {"score": 70, "model": llm.MODEL}):
                pipeline.assess_new(conn, [], verbose=False)
            v = conn.execute("SELECT scoring_version FROM assessments").fetchone()[0]
            conn.close()
            self.assertEqual(v, llm.SCORING_VERSION)


if __name__ == "__main__":
    unittest.main()
