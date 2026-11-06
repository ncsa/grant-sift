"""Falling back to another model when the primary is down (#67).

Stdlib only:  python -m unittest discover tests
"""

import argparse
import os
import tempfile
import unittest
from datetime import date, timedelta
from unittest import mock

from fastapi import HTTPException

from grant_sift import db, llm, pipeline, server, telemetry

LATER = (date.today() + timedelta(days=60)).isoformat()
PRIMARY, BACKUP = "gemma-4-31b-it", "qwen3.8-flash"
DOWN = "No healthy endpoints for model gemma-4-31b-it"
REPLY = '{"score": 72, "category": "ci_program", "rationale": "r"}'


class Resp:
    """Just enough of a requests.Response."""

    def __init__(self, status, text="", content=None):
        self.status_code = status
        self.text = text
        self._content = content

    def json(self):
        return {"choices": [{"message": {"content": self._content or ""},
                             "finish_reason": "length"}], "usage": {}}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


def gateway(answers):
    """A fake requests.post: answers[model] is a Resp, or a list consumed in
    turn. Records which models were asked."""
    asked = []

    def post(url, headers=None, json=None, timeout=None):
        m = json["model"]
        asked.append(m)
        a = answers[m]
        return a.pop(0) if isinstance(a, list) else a
    return post, asked


class Classify(unittest.TestCase):
    def test_what_counts_as_down(self):
        self.assertTrue(llm.is_unavailable(503, DOWN))
        self.assertTrue(llm.is_unavailable(502, "no healthy upstream"))
        self.assertTrue(llm.is_unavailable(404, '{"error": "model gemma-x not found"}'))
        self.assertTrue(llm.is_unavailable(404, "Unknown model: foo"))

    def test_what_does_not(self):
        self.assertFalse(llm.is_unavailable(503, "out of coins"))
        self.assertFalse(llm.is_unavailable(429, DOWN))       # rate limit, whatever it says
        self.assertFalse(llm.is_unavailable(402, "insufficient balance"))
        self.assertFalse(llm.is_unavailable(400, "bad request"))
        self.assertFalse(llm.is_unavailable(404, "Not Found"))  # wrong path, not a model
        self.assertFalse(llm.is_unavailable(500, "internal error"))

    def test_model_list(self):
        self.assertEqual(llm._model_list("", "x"), ["x"])
        self.assertEqual(llm._model_list(None, None), [llm.DEFAULT_MODEL])
        self.assertEqual(llm._model_list(" a, b ,a,", "x"), ["a", "b"])


class Pipeline(unittest.TestCase):
    """llm._post, as assess and extraction use it."""

    def setUp(self):
        llm.reset_down()
        self.patches = [mock.patch.object(llm, "MODELS", [PRIMARY, BACKUP]),
                        mock.patch.object(llm, "MODEL", PRIMARY),
                        mock.patch.object(llm, "API_KEY", "k"),
                        mock.patch.object(llm.time, "sleep", lambda s: None)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        llm.reset_down()

    def run_post(self, answers):
        post, asked = gateway(answers)
        with mock.patch.object(llm.requests, "post", post):
            return llm._post([], "sys"), asked

    def test_down_falls_back_without_retrying_the_dead_model(self):
        (out, used), asked = self.run_post({PRIMARY: Resp(503, DOWN), BACKUP: Resp(200, content="hi")})
        self.assertEqual((out, used), ("hi", BACKUP))
        self.assertEqual(asked, [PRIMARY, BACKUP])

    def test_a_down_model_is_skipped_for_a_while(self):
        self.run_post({PRIMARY: Resp(503, DOWN), BACKUP: Resp(200, content="hi")})
        (_, used), asked = self.run_post({PRIMARY: Resp(200, content="up"), BACKUP: Resp(200, content="hi")})
        self.assertEqual(used, BACKUP)
        self.assertEqual(asked, [BACKUP])            # primary not asked again yet

    def test_unknown_model_falls_back(self):
        (_, used), _ = self.run_post({PRIMARY: Resp(404, "model not found"),
                                      BACKUP: Resp(200, content="hi")})
        self.assertEqual(used, BACKUP)

    def test_budget_429_4xx_do_not_fall_back(self):
        for resp in (Resp(402, "out of coins"), Resp(429, "slow down"),
                     Resp(400, "bad request"), Resp(503, "insufficient credit")):
            llm.reset_down()
            post, asked = gateway({PRIMARY: resp, BACKUP: Resp(200, content="hi")})
            with mock.patch.object(llm.requests, "post", post):
                with self.assertRaises(RuntimeError):
                    llm._post([], "sys")
            self.assertEqual(set(asked), {PRIMARY}, resp.text)

    def test_truncation_does_not_fall_back(self):
        post, asked = gateway({PRIMARY: Resp(200, content=""), BACKUP: Resp(200, content="hi")})
        with mock.patch.object(llm.requests, "post", post):
            with self.assertRaises(llm.TruncatedResponse):
                llm._post([], "sys")
        self.assertEqual(asked, [PRIMARY])

    def test_all_down(self):
        post, _ = gateway({PRIMARY: Resp(503, DOWN), BACKUP: Resp(503, "no healthy endpoint")})
        with mock.patch.object(llm.requests, "post", post):
            with self.assertRaises(llm.AllModelsDown):
                llm._post([], "sys")

    def test_assess_says_which_model_answered(self):
        post, _ = gateway({PRIMARY: Resp(503, DOWN), BACKUP: Resp(200, content=REPLY)})
        with mock.patch.object(llm.requests, "post", post):
            r = llm.assess({"title": "t"}, "roster")
        self.assertEqual((r["score"], r["model"]), (72, BACKUP))


class AssessRun(unittest.TestCase):
    """assess_new flags what a backup scored; --rescore-fallback clears it."""

    def setUp(self):
        llm.reset_down()
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "t.db")
        db.init(self.path)
        self.conn = db.connect(self.path)
        for i in ("c1", "c2"):
            db.upsert_opportunity(self.conn, {
                "id": i, "source": "grants.gov", "title": f"Call {i}", "agency": "NSF",
                "url": f"https://example.org/{i}", "deadline": LATER,
                "synopsis": "Build one.", "raw": {}})
        self.conn.commit()
        self.patches = [mock.patch.object(llm, "MODELS", [PRIMARY, BACKUP]),
                        mock.patch.object(llm, "MODEL", PRIMARY),
                        mock.patch.object(llm, "API_KEY", "k"),
                        mock.patch.object(llm.time, "sleep", lambda s: None)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.conn.close()
        self.dir.cleanup()
        llm.reset_down()

    def assess(self, answers, **kw):
        post, asked = gateway(answers)
        with mock.patch.object(llm.requests, "post", post):
            n = pipeline.assess_new(self.conn, [], verbose=False, **kw)
        return n, asked

    def test_backup_scores_are_flagged_and_traced(self):
        n, _ = self.assess({PRIMARY: Resp(503, DOWN), BACKUP: Resp(200, content=REPLY)})
        self.assertEqual(n, 2)
        rows = self.conn.execute("SELECT model, fallback_for FROM assessments").fetchall()
        self.assertEqual({tuple(r) for r in rows}, {(BACKUP, PRIMARY)})
        fb = db.fallback_scored(self.conn)
        self.assertEqual(fb["count"], 2)
        self.assertEqual(fb["by_model"], [{"model": BACKUP, "instead_of": PRIMARY, "count": 2}])
        ev = self.conn.execute("SELECT primary_model, used_model, path FROM llm_events").fetchall()
        self.assertEqual([tuple(r) for r in ev], [(PRIMARY, BACKUP, "assess")] * 2)

        telemetry.record_daily(self.conn)
        stats = {(r["metric"], r["dim"]): r["value"]
                 for r in telemetry.query_rows(self.conn, since_days=None)}
        self.assertEqual(stats[("assessed_by_model", BACKUP)], 2)
        self.assertEqual(stats[("llm_fallback_count", f"{PRIMARY}|{BACKUP}|assess")], 2)
        self.assertEqual(stats[("fallback_scored_live", "")], 2)
        self.assertEqual(stats[("fallback_scored_share", "")], 1.0)

    def test_primary_scores_are_not_flagged(self):
        self.assess({PRIMARY: Resp(200, content=REPLY), BACKUP: Resp(200, content=REPLY)})
        self.assertEqual(db.fallback_scored(self.conn)["count"], 0)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM llm_events").fetchone()[0], 0)

    def test_rescore_fallback_uses_the_primary_only(self):
        import run
        self.assess({PRIMARY: Resp(503, DOWN), BACKUP: Resp(200, content=REPLY)})
        llm.reset_down()
        args = argparse.Namespace(config="config", limit=50, rescore_fallback=True)

        # Primary still down: nothing changes, and the backup is not paid again.
        post, asked = gateway({PRIMARY: Resp(503, DOWN), BACKUP: Resp(200, content=REPLY)})
        with mock.patch.object(llm.requests, "post", post), \
                mock.patch("builtins.print"):
            run.cmd_assess(self.conn, args)
        self.assertNotIn(BACKUP, asked)
        self.assertEqual(db.fallback_scored(self.conn)["count"], 2)

        # Back up: both re-scored on it, and the flag clears.
        llm.reset_down()
        post, asked = gateway({PRIMARY: Resp(200, content=REPLY), BACKUP: Resp(200, content=REPLY)})
        with mock.patch.object(llm.requests, "post", post), \
                mock.patch("builtins.print"):
            run.cmd_assess(self.conn, args)
        self.assertEqual(asked, [PRIMARY, PRIMARY])
        self.assertEqual(db.fallback_scored(self.conn)["count"], 0)
        self.assertEqual({r[0] for r in self.conn.execute("SELECT model FROM assessments")},
                         {PRIMARY})


class Requests(unittest.TestCase):
    """The request path: Ask and Idea match through server._complete."""

    def setUp(self):
        llm.reset_down()
        self.dir = tempfile.TemporaryDirectory()
        path = os.path.join(self.dir.name, "t.db")
        db.init(path)
        self.path = path
        self.patches = [mock.patch.object(llm, "MODELS", [PRIMARY, BACKUP]),
                        mock.patch.object(llm, "MODEL", PRIMARY),
                        mock.patch.object(llm, "API_KEY", "k"),
                        mock.patch.object(server, "_conn", lambda: db.connect(path))]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.dir.cleanup()
        llm.reset_down()

    def shared(self):
        return {"base_url": llm.BASE_URL, "api_key": "k", "model": PRIMARY, "own": False}

    def complete(self, gw, answers):
        post, asked = gateway(answers)
        with mock.patch.object(server.requests, "post", post):
            content, _ = server._complete(gw, [{"role": "user", "content": "q"}], 100)
        return content, asked

    def test_shared_key_falls_back_and_says_so(self):
        gw = self.shared()
        content, asked = self.complete(gw, {PRIMARY: Resp(503, DOWN), BACKUP: Resp(200, content="hi")})
        self.assertEqual((content, asked), ("hi", [PRIMARY, BACKUP]))
        self.assertEqual(server._answered(gw, "idea"), {"model": BACKUP, "fallback": PRIMARY})
        conn = db.connect(self.path)
        ev = conn.execute("SELECT primary_model, used_model, path FROM llm_events").fetchall()
        conn.close()
        self.assertEqual([tuple(r) for r in ev], [(PRIMARY, BACKUP, "idea")])

    def test_no_fallback_no_event(self):
        gw = self.shared()
        self.complete(gw, {PRIMARY: Resp(200, content="hi"), BACKUP: Resp(200, content="x")})
        self.assertEqual(server._answered(gw, "ask"), {"model": PRIMARY, "fallback": None})
        conn = db.connect(self.path)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM llm_events").fetchone()[0], 0)
        conn.close()

    def test_shared_key_budget_and_429_do_not_fall_back(self):
        for resp in (Resp(402, "out of coins"), Resp(429, "slow down"), Resp(400, "bad")):
            llm.reset_down()
            with self.assertRaises(HTTPException):
                self.complete(self.shared(), {PRIMARY: resp, BACKUP: Resp(200, content="hi")})

    def test_all_down_is_a_503(self):
        with self.assertRaises(HTTPException) as cm:
            self.complete(self.shared(), {PRIMARY: Resp(503, DOWN), BACKUP: Resp(503, DOWN)})
        self.assertEqual(cm.exception.status_code, 503)

    def test_own_key_never_falls_back(self):
        gw = {"base_url": "https://openrouter.ai/api/v1", "api_key": "mine",
              "model": "their/model", "own": True}
        post, asked = gateway({"their/model": Resp(503, DOWN), PRIMARY: Resp(200, content="x"),
                               BACKUP: Resp(200, content="x")})
        with mock.patch.object(server.requests, "post", post):
            with self.assertRaises(HTTPException) as cm:
                server._complete(gw, [{"role": "user", "content": "q"}], 100)
        self.assertEqual(asked, ["their/model"])
        self.assertIn("down", cm.exception.detail)
        self.assertFalse(llm.is_down("their/model"))


if __name__ == "__main__":
    unittest.main()
