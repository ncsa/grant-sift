"""The SAM.gov source (adapters.sam_gov) and its copies folding together.

Stdlib only:  python -m unittest discover tests
"""

import os
import tempfile
import unittest
from datetime import date, timedelta
from unittest import mock

import requests

from grant_sift import adapters, db, pipeline

SOON = (date.today() + timedelta(days=40)).isoformat()
KEY = "SAMKEY-not-a-real-one"

FIREFOX_ID = "182eab6ca77d465f931c6dc118b939ca"
FIREFOX = {
    "noticeId": FIREFOX_ID,
    "title": "Dynamic Rastering/scanning of Optical Signals and New Data Processing "
             "Architectures (FIREFOX)",
    "solicitationNumber": "HR001126S0007",
    "fullParentPathName": "DEPT OF DEFENSE.DEFENSE ADVANCED RESEARCH PROJECTS AGENCY (DARPA)."
                          "DEF ADVANCED RESEARCH PROJECTS AGCY",
    "fullParentPathCode": "097.97AE.HR0011",
    "postedDate": "2026-09-24",
    "type": "Solicitation", "baseType": "Solicitation",
    "archiveDate": "2026-12-09",
    "responseDeadLine": f"{SOON}T16:00:00-05:00",
    "naicsCode": "541715", "active": "Yes",
    "uiLink": f"https://sam.gov/opp/{FIREFOX_ID}/view",
    "description": f"https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid={FIREFOX_ID}",
}


def notice(**kw):
    return dict(FIREFOX, **kw)


# What the procurement side of an office looks like: none of it is a call.
PROCUREMENT = [
    notice(noticeId="a" * 32, title="Janitorial Services", naicsCode="561720"),
    notice(noticeId="b" * 32, title="Award: Office-wide BAA", type="Award Notice",
           baseType="Award Notice"),
    notice(noticeId="c" * 32, title="Research BAA (cancelled)", active="No"),
    notice(noticeId="d" * 32, title="Sources Sought: lab equipment", type="Sources Sought",
           baseType="Sources Sought"),
]

CFG = {
    "naics": ["5417"],
    "title_terms": ["BAA", "broad agency announcement", "research announcement", "ARA"],
    "queries": [{"name": "DARPA", "organizationName": "DEFENSE ADVANCED RESEARCH PROJECTS AGENCY"}],
}


class Resp:
    def __init__(self, status=200, body=None, text=""):
        self.status_code, self._body, self.text = status, body, text

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


def fake_sam(pages, descs=None, calls=None):
    """requests.get stand-in: search pages in order, descriptions by noticeid."""
    pages, descs = list(pages), descs or {}

    def get(url, params=None, **kw):
        if calls is not None:
            calls.append((url, dict(params or {})))
        if url == adapters.SAM_URL:
            return pages.pop(0)
        nid = params["noticeid"]
        if nid in descs:
            return Resp(body={"description": descs[nid]})
        return Resp(404, text='{"error":"Description not found"}')
    return get


def search(*notices, total=None):
    return Resp(body={"totalRecords": len(notices) if total is None else total,
                      "opportunitiesData": list(notices)})


class Adapter(unittest.TestCase):
    def read(self, *pages, cfg=CFG, budget=8, calls=None):
        client = adapters.SamClient(KEY, budget)
        with mock.patch.object(adapters.requests, "get", fake_sam(pages, calls=calls)):
            return adapters.sam_gov(cfg, client), client

    def test_record_shape(self):
        (rec,), _ = self.read(search(FIREFOX))
        self.assertEqual(rec["id"], f"sam:{FIREFOX_ID}")
        self.assertEqual(rec["source"], "sam.gov")
        self.assertEqual(rec["agency"], "DARPA")
        self.assertEqual(rec["url"], f"https://sam.gov/opp/{FIREFOX_ID}/view")
        self.assertEqual(rec["deadline"], SOON)
        self.assertEqual(rec["raw"]["number"], "HR001126S0007")
        self.assertIn("num:HR001126S0007", db.call_keys(rec))
        self.assertIn(f"sam:{FIREFOX_ID}", db.call_keys(rec))

    def test_procurement_is_filtered_out(self):
        recs, _ = self.read(search(FIREFOX, *PROCUREMENT))
        self.assertEqual([r["external_id"] for r in recs], [FIREFOX_ID])

    def test_title_lets_a_non_rd_naics_through(self):
        ona = notice(noticeId="e" * 32, naicsCode="541990",
                     title="FY27 Communications and Networking Applied Research Announcement (ARA)")
        recs, _ = self.read(search(ona))
        self.assertEqual(len(recs), 1)
        # Whole words only: "ARA" is not "parachute".
        recs, _ = self.read(search(notice(noticeId="f" * 32, naicsCode="336413",
                                          title="Parachute assemblies")))
        self.assertEqual(recs, [])

    def test_archive_date_stands_in_for_a_missing_deadline(self):
        (rec,), _ = self.read(search(notice(responseDeadLine=None)))
        self.assertEqual(rec["deadline"], "2026-12-09")

    def test_path_match_narrows_a_query(self):
        cfg = dict(CFG, queries=[{"name": "ONR", "organizationCode": "N00014",
                                  "match": "OFFICE OF NAVAL RESEARCH"}])
        recs, _ = self.read(search(FIREFOX), cfg=cfg)
        self.assertEqual(recs, [])

    def test_one_request_per_query_with_the_window(self):
        calls = []
        self.read(search(FIREFOX), calls=calls)
        (url, params), = calls
        self.assertEqual(params["organizationName"], "DEFENSE ADVANCED RESEARCH PROJECTS AGENCY")
        self.assertEqual(params["limit"], 1000)
        self.assertEqual(params["api_key"], KEY)
        posted_from = date(*map(int, reversed_mdY(params["postedFrom"])))
        self.assertEqual((date.today() - posted_from).days, 364)

    def test_more_than_a_page_is_refused_not_truncated(self):
        with self.assertRaisesRegex(RuntimeError, "over one page"):
            self.read(search(FIREFOX, total=1001))

    def test_no_key_fails_loudly(self):
        with self.assertRaisesRegex(RuntimeError, "GRANT_SIFT_SAM_API_KEY"):
            adapters.SamClient("", 8)

    def test_key_never_reaches_an_error_message(self):
        client = adapters.SamClient(KEY, 8)
        boom = requests.ConnectionError(f"Max retries exceeded with url: /search?api_key={KEY}")
        with mock.patch.object(adapters.requests, "get", side_effect=boom):
            with self.assertRaises(RuntimeError) as cm:
                adapters.sam_gov(CFG, client)
        self.assertNotIn(KEY, str(cm.exception))
        self.assertIsNone(cm.exception.__cause__)
        echo = Resp(403, text=f'{{"error": "API_KEY_INVALID {KEY}"}}')
        with mock.patch.object(adapters.requests, "get", return_value=echo):
            with self.assertRaises(RuntimeError) as cm:
                adapters.SamClient(KEY, 8).detail(FIREFOX_ID)
        self.assertNotIn(KEY, str(cm.exception))

    def test_rate_limit_spends_the_budget(self):
        client = adapters.SamClient(KEY, 8)
        with mock.patch.object(adapters.requests, "get", return_value=Resp(429)):
            with self.assertRaisesRegex(RuntimeError, "rate limit"):
                client.detail(FIREFOX_ID)
        with self.assertRaises(adapters.SamBudgetSpent):
            client.detail(FIREFOX_ID)

    def test_description(self):
        client = adapters.SamClient(KEY, 8)
        get = fake_sam([], {FIREFOX_ID: "<p>DARPA seeks <b>optical</b> rastering.</p>"})
        with mock.patch.object(adapters.requests, "get", get):
            self.assertEqual(client.detail(FIREFOX_ID), {"synopsis": "DARPA seeks optical rastering."})
            self.assertEqual(client.detail("0" * 32), {})      # 404: no description


def reversed_mdY(s):
    m, d, y = s.split("/")
    return y, m, d


# The Research Board's copy of FIREFOX, as it is stored: a workspace link to
# the notice and a title that names no solicitation number.
IRB = {"id": "fnd:firefox", "source": "Illinois Research Board", "agency": "Illinois Research Board",
       "title": "Grants for Research on Dynamic Rastering/scanning of Optical Signals and "
                "Development of New Data Processing Architectures (FIREFOX)",
       "url": f"https://sam.gov/workspace/contract/opp/{FIREFOX_ID}/view",
       "page_url": "https://research.illinois.edu/rfp/firefox", "deadline": "2026-11-09",
       "synopsis": "DARPA is funding research into optical rastering.", "raw": {}}


class Keys(unittest.TestCase):
    def test_sam_url_shapes_agree(self):
        want = f"sam:{FIREFOX_ID}"
        for u in (f"https://sam.gov/opp/{FIREFOX_ID}/view",
                  f"https://sam.gov/workspace/contract/opp/{FIREFOX_ID}/view",
                  f"https://beta.sam.gov/opp/{FIREFOX_ID}/view",
                  f"https://sam.gov/opp/{FIREFOX_ID.upper()}",
                  f"https://sam.gov/opp/{FIREFOX_ID}/view?index=opp&page=1"):
            self.assertEqual(db._url_key(u), want, u)

    def test_other_sam_pages_are_plain_urls(self):
        self.assertEqual(db._url_key("https://sam.gov/search/?index=opp"), "url:sam.gov/search?index=opp")


class Folding(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        path = os.path.join(self.dir.name, "t.db")
        db.init(path)
        self.conn = db.connect(path)
        db.record_source_run(self.conn, "sam.gov", "api", adapters.SAM_URL, True, 1)
        db.record_source_run(self.conn, "Illinois Research Board", "listing", "", True, 1)

    def tearDown(self):
        self.conn.close()
        self.dir.cleanup()

    def add(self, *recs):
        for r in recs:
            db.upsert_opportunity(self.conn, dict(r))
            db.save_keys(self.conn, r["id"], db.call_keys(r))

    def dup_of(self, opp_id):
        return self.conn.execute("SELECT duplicate_of FROM opportunities WHERE id = ?",
                                 (opp_id,)).fetchone()["duplicate_of"]

    def test_research_board_copy_folds_onto_sam(self):
        client = adapters.SamClient(KEY, 8)
        with mock.patch.object(adapters.requests, "get", fake_sam([search(FIREFOX)])):
            (sam,) = adapters.sam_gov(CFG, client)
        self.add(IRB, sam)
        groups = db.link_duplicates(self.conn, {"Illinois Research Board"})
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["canonical"], sam["id"])
        self.assertEqual(self.dup_of(IRB["id"]), sam["id"])
        self.assertIn(f"sam:{FIREFOX_ID}", groups[0]["keys"])

    def test_notice_id_is_not_an_umbrella(self):
        # A presolicitation retitled when it becomes the solicitation is still
        # one notice; its id joins whatever the titles say.
        sam = {"id": f"sam:{FIREFOX_ID}", "source": "sam.gov", "deadline": SOON,
               "title": "Optical Rastering", "url": f"https://sam.gov/opp/{FIREFOX_ID}/view"}
        other = dict(IRB, title="Something retitled entirely")
        self.add(sam, other)
        self.assertEqual(len(db.link_duplicates(self.conn, {"Illinois Research Board"})), 1)


class Ingest(unittest.TestCase):
    """sam.gov through pipeline.ingest: budget, caching and cadence."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        path = os.path.join(self.dir.name, "t.db")
        db.init(path)
        self.conn = db.connect(path)
        self.env = mock.patch.dict(os.environ, {"GRANT_SIFT_SAM_API_KEY": KEY})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.conn.close()
        self.dir.cleanup()

    def ingest(self, get, budget):
        sources = {"sam_gov": dict(CFG, enabled=True, cadence="weekly", max_requests=budget)}
        with mock.patch.object(adapters.requests, "get", get):
            return pipeline.ingest(self.conn, sources, verbose=False)

    def three(self):
        return [notice(noticeId=f"{i}" * 32, title=f"Office-wide BAA {i}") for i in (1, 2, 3)]

    def test_descriptions_take_what_the_searches_leave(self):
        descs = {n["noticeId"]: f"About call {n['title']}." for n in self.three()}
        calls = []
        stats = self.ingest(fake_sam([search(*self.three())], descs, calls), budget=3)
        self.assertEqual(len(calls), 3)                    # 1 search + 2 descriptions
        self.assertEqual(stats["new"], 3)
        self.assertEqual(stats["enriched"], 2)
        self.assertEqual(stats["detail_deferred"], 1)
        # The deferred one is not cached as a failure, so the next run reads it.
        self.assertIsNone(db.detail_cached(self.conn, f"sam:{'3' * 32}"))
        self.assertIsNotNone(db.detail_cached(self.conn, f"sam:{'1' * 32}"))
        row = self.conn.execute("SELECT synopsis, agency FROM opportunities WHERE id = ?",
                                (f"sam:{'1' * 32}",)).fetchone()
        self.assertEqual(row["synopsis"], "About call Office-wide BAA 1.")
        self.assertEqual(row["agency"], "DARPA")
        src = self.conn.execute("SELECT kind, last_error FROM sources WHERE name = 'sam.gov'").fetchone()
        self.assertEqual(src["kind"], "api")
        self.assertIsNone(src["last_error"])

    def test_weekly_cadence_spends_nothing_in_between(self):
        self.ingest(fake_sam([search(*self.three())]), budget=8)
        calls = []
        self.ingest(fake_sam([], calls=calls), budget=8)
        self.assertEqual(calls, [])

    def test_missing_key_is_a_failed_run(self):
        os.environ["GRANT_SIFT_SAM_API_KEY"] = ""
        self.ingest(fake_sam([]), budget=8)
        src = self.conn.execute("SELECT last_error FROM sources WHERE name = 'sam.gov'").fetchone()
        self.assertIn("GRANT_SIFT_SAM_API_KEY", src["last_error"])


if __name__ == "__main__":
    unittest.main()
