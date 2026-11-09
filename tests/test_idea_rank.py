"""Idea match: the rank pass picks the call, in the same request as the search (#73).

Stdlib only:  python -m unittest discover tests
"""

import json
import os
import tempfile
import unittest
from datetime import date, timedelta
from unittest import mock

from grant_sift import db, server

LATER = (date.today() + timedelta(days=60)).isoformat()


class Parse(unittest.TestCase):
    def test_object_reply_in_fences(self):
        raw = '```json\n{"recommendation": "Go for A.", "calls": [{"id": "A", "affinity": "88", "why": "w"}]}\n```'
        d = server._focus_obj(raw)
        self.assertEqual(d["recommendation"], "Go for A.")
        self.assertEqual(server._focus_calls(d, {"A"}), [{"id": "A", "affinity": 88, "why": "w"}])

    def test_bare_array_still_yields_calls_and_no_recommendation(self):
        # The {...} search would find the first call inside the array; that
        # must not be mistaken for the reply.
        d = server._focus_obj('Here: [{"id": "A", "affinity": 55, "why": "w"}]')
        self.assertNotIn("recommendation", d)
        self.assertEqual([c["id"] for c in server._focus_calls(d, {"A"})], ["A"])

    def test_invented_ids_and_bad_affinity_are_dropped(self):
        d = {"calls": [{"id": "Z", "affinity": 90}, {"id": "A", "affinity": "high"},
                       {"id": "B", "affinity": 140}, "junk"]}
        self.assertEqual(server._focus_calls(d, {"A", "B"}),
                         [{"id": "B", "affinity": 100, "why": ""}])

    def test_unparseable_is_empty(self):
        self.assertEqual(server._focus_obj("no idea"), {})

    def test_rank_prompt_asks_for_the_recommendation(self):
        self.assertIn(server.RECOMMENDATION_SPEC, server.FOCUS_RANK_SYSTEM)
        self.assertIn("Drop anything under 40", server.FOCUS_RANK_SYSTEM)

    def test_rescore_is_gone(self):
        # Editing the idea no longer re-ranks the old matches: an edit can
        # change what is being looked for, so it takes a fresh match.
        self.assertFalse(hasattr(server, "rescore"))
        self.assertFalse(any(getattr(r, "path", "") == "/api/rescore" for r in server.app.routes))


class FocusEndpoint(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        path = os.path.join(self.dir.name, "t.db")
        db.init(path)
        conn = db.connect(path)
        for i, title in (("c1", "Data pipelines"), ("c2", "Coastal sensors")):
            db.upsert_opportunity(conn, {
                "id": i, "source": "grants.gov", "title": title, "agency": "NSF",
                "url": f"https://example.org/{i}", "deadline": LATER,
                "synopsis": "Build one.", "raw": {}})
            db.save_assessment(conn, i, {"score": 70, "summary": f"Funds {title}."}, "m", "h")
        conn.commit()
        conn.close()
        server._corpus_cache.clear()
        self.calls = []

        def fake_post(gw, system, user, max_tokens):
            self.calls.append(system)
            if system.startswith("You match"):
                return json.dumps([{"id": "c1", "why": "x"}, {"id": "c2", "why": "y"}]), {}
            return json.dumps({"recommendation": "Write for c1; c2 if the deadline slips.",
                               "pick": {"id": "c1", "reason": "It funds  the pipeline."},
                               "runner_up": {"id": "c9", "if": "made up"},
                               "calls": [{"id": "c2", "affinity": 61, "why": "b"},
                                         {"id": "c1", "affinity": 85, "why": "a"}]}), {}

        self.patches = [
            mock.patch.object(server, "_conn", lambda: db.connect(path)),
            mock.patch.object(server, "_focus_post", fake_post),
            mock.patch.object(server, "_gateway", lambda p: {"model": "m"}),
            mock.patch.object(server, "_rate_limit", lambda *a, **k: None),
            mock.patch.object(server, "_client", lambda r: "t"),
            mock.patch.object(server.auth, "require_user", lambda r: None),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        server._corpus_cache.clear()
        self.dir.cleanup()

    def test_one_rank_call_returns_scores_and_the_pick(self):
        out = server.focus(None, {"idea": "a data pipeline"})
        self.assertEqual([r["id"] for r in out["results"]], ["c1", "c2"])
        self.assertEqual(out["recommendation"], "Write for c1; c2 if the deadline slips.")
        self.assertEqual(out["pick"], {"id": "c1", "reason": "It funds the pipeline."})
        # c9 was never kept, so it is no runner-up.
        self.assertIsNone(out["runner_up"])
        ranks = [s for s in self.calls if s.startswith("You are scoring")]
        self.assertEqual(len(ranks), 1)
        self.assertEqual(set(out["timing_ms"]), {"search", "rank", "total"})
        self.assertTrue(all(isinstance(v, int) for v in out["timing_ms"].values()))


class FocusChoiceTest(unittest.TestCase):
    def test_choice_needs_a_kept_id(self):
        self.assertEqual(server._focus_choice({"id": " A ", "if": "x"}, {"A"}, "if"), {"id": "A", "if": "x"})
        self.assertIsNone(server._focus_choice({"id": "B", "if": "x"}, {"A"}, "if"))
        self.assertIsNone(server._focus_choice("A", {"A"}, "if"))
        self.assertIsNone(server._focus_choice(None, {"A"}, "if"))


if __name__ == "__main__":
    unittest.main()
