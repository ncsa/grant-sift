"""Folding copies of one call listed by several sources (db.link_duplicates).

Stdlib only:  python -m unittest discover tests
"""

import json
import os
import tempfile
import unittest
from datetime import date, timedelta

from grant_sift import catalogue, db, pipeline

SOON = (date.today() + timedelta(days=40)).isoformat()
PAST = (date.today() - timedelta(days=40)).isoformat()

NIH_URL = "https://grants.nih.gov/grants/guide/rfa-files/RFA-OD-24-011.html"
AGGREGATORS = {"CURIOSS", "Illinois Research Board"}

# The three listings of NIH RFA-OD-24-011 that prompted this, as stored.
GG = {"id": "gg:355439", "source": "grants.gov", "agency": "HHS-NIH11",
      "title": "NIH Research Software Engineer (RSE) Award (R50 Clinical Trials Not Allowed)",
      "url": "https://grants.gov/search-results-detail/355439", "deadline": SOON,
      "synopsis": "The purpose of this NOFO is to provide salary support for RSEs. " * 5,
      "raw": {"number": "RFA-OD-24-011"}}
CURIOSS = {"id": "fnd:curioss", "source": "CURIOSS", "agency": "CURIOSS",
           "title": "NIH Research Software Engineer (RSE) Award",
           "url": NIH_URL, "deadline": SOON, "synopsis": "Salary support.",
           "raw": {"url": NIH_URL}}
IRB_PAGE = "https://research.illinois.edu/rfp/grants-support-research-software-engineers"
IRB = {"id": "fnd:irb", "source": "Illinois Research Board", "page_url": IRB_PAGE,
       "agency": "National Institutes of Health",
       "title": "Grants to Support Research Software Engineers Developing Software "
                "and Tools for Biomedical and/or Behavioral Health",
       "url": NIH_URL, "deadline": SOON, "synopsis": "RSE support.", "raw": {"url": NIH_URL}}


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        path = os.path.join(self.dir.name, "t.db")
        db.init(path)
        self.conn = db.connect(path)
        for name, kind in (("grants.gov", "api"), ("CURIOSS", "page"),
                           ("Illinois Research Board", "listing"), ("Wellcome", "sitemap")):
            db.record_source_run(self.conn, name, kind, "", True, 1)

    def tearDown(self):
        self.conn.close()
        self.dir.cleanup()

    def add(self, *recs):
        for r in recs:
            db.upsert_opportunity(self.conn, dict(r))
            db.save_keys(self.conn, r["id"], db.call_keys(r))

    def link(self):
        return db.link_duplicates(self.conn, AGGREGATORS)

    def dup_of(self, opp_id):
        return self.conn.execute("SELECT duplicate_of FROM opportunities WHERE id = ?",
                                 (opp_id,)).fetchone()["duplicate_of"]


class TitleCore(unittest.TestCase):
    def test_nih_suffix_is_stripped(self):
        a = db.title_core(GG["title"], GG["agency"])
        b = db.title_core(CURIOSS["title"], CURIOSS["agency"])
        self.assertEqual(a, b)
        self.assertEqual(db.title_core("Planning Grants (R21/R33 Clinical Trial Optional)"),
                         db.title_core("Planning Grants"))
        self.assertEqual(db.title_core("Career Award (K99)"), "career award")

    def test_abbreviations_spelled_one_way(self):
        # CURIOSS and grants.gov on NSF 26-513, 2026-10-30.
        a = db.title_core("NSF State and Regional Artificial Intelligence Infrastructure Hubs",
                          "CURIOSS")
        b = db.title_core("U.S. National Science Foundation State and Regional "
                          "Artificial Intelligence Infrastructure Hubs:", "NSF")
        self.assertTrue(db.same_call(a, b))
        self.assertEqual(db.title_core("Super Intelligence (SI) Supplements"),
                         db.title_core("Superintelligence (SI) Supplements"))
        self.assertEqual(db.title_core("AI for Science"),
                         db.title_core("Artificial Intelligence for Science"))
        # A word that merely contains the letters is left alone.
        self.assertIn("aims", db.title_core("Program Aims"))

    def test_other_parentheticals_kept(self):
        self.assertIn("frr", db.title_core("Foundational Research in Robotics (FRR)"))
        self.assertIn("2026", db.title_core("Small Grants (2026)"))


class CallKeys(unittest.TestCase):
    def test_nih_number_from_url_and_grants_gov_number(self):
        self.assertIn("num:RFAOD24011", db.call_keys(GG))
        self.assertIn("num:RFAOD24011", db.call_keys(CURIOSS))
        self.assertIn("gg:355439", db.call_keys(GG))

    def test_nsf_forms_agree(self):
        a = db.call_keys({"title": "Cyberinfrastructure (NSF 24-569)", "url": ""})
        b = db.call_keys({"title": "x", "url": "https://www.nsf.gov/pubs/2024/nsf24569/nsf24569.htm"})
        self.assertIn("num:NSF24569", a)
        self.assertIn("num:NSF24569", b)

    def test_grants_gov_url_schemes_agree(self):
        old = db.call_keys({"title": "x", "url": "https://www.grants.gov/view-opportunity.html?oppId=355439"})
        self.assertIn("gg:355439", old)

    def test_not_from_synopsis_or_notices(self):
        keys = db.call_keys({"title": "Notice NOT-OD-25-001",
                             "synopsis": "See companion PAR-25-123.", "url": ""})
        self.assertEqual(keys, set())

    def test_model_junk_is_not_a_number(self):
        for junk in ("2", "Cycle 7", "N/A", "TBD"):
            self.assertEqual(db.call_keys({"title": "x", "url": "", "raw": {"opportunity_number": junk}}),
                             set(), junk)
        self.assertIn("num:HHS2025ACF0001",
                      db.call_keys({"title": "x", "url": "", "raw": {"number": "HHS-2025-ACF-0001"}}))

    def test_truncated_stored_raw(self):
        row = {"title": "x", "url": "", "raw": json.dumps({"number": "DE-FOA-0003647",
                                                           "pad": "y" * 30000})[:20000]}
        self.assertIn("num:DEFOA0003647", db.call_keys(row))

    def test_front_page_and_tracking(self):
        self.assertEqual(db.call_keys({"title": "x", "url": "https://www.nih.gov/"}), set())
        a = db.call_keys({"title": "x", "url": "https://Foo.org/call/?utm_source=a&id=3"})
        b = db.call_keys({"title": "x", "url": "http://www.foo.org/call?id=3"})
        self.assertEqual(a, b)


class Linking(Base):
    def test_three_listings_fold_to_the_funders(self):
        self.add(GG, CURIOSS, IRB)
        groups = self.link()
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["canonical"], GG["id"])
        self.assertEqual(self.dup_of(CURIOSS["id"]), GG["id"])
        self.assertEqual(self.dup_of(IRB["id"]), GG["id"])
        self.assertIsNone(self.dup_of(GG["id"]))

    def test_order_does_not_matter(self):
        self.add(IRB, CURIOSS)
        self.link()
        self.assertIsNone(self.dup_of(CURIOSS["id"]) and self.dup_of(IRB["id"]))
        self.add(GG)
        self.link()
        self.assertEqual(self.dup_of(CURIOSS["id"]), GG["id"])
        self.assertEqual(self.dup_of(IRB["id"]), GG["id"])

    def test_live_copy_wins_over_closed_funder_copy(self):
        self.add(dict(GG, deadline=PAST), IRB)
        self.link()
        self.assertEqual(self.dup_of(GG["id"]), IRB["id"])

    def test_umbrella_number_joins_nothing(self):
        roses = {"source": "grants.gov", "agency": "NASA", "url": "", "deadline": SOON,
                 "raw": {"number": "NNH25ZDA001N"}}
        self.add(dict(roses, id="gg:1", title="ROSES 2025: C.2 Solar System Science"),
                 dict(roses, id="gg:2", title="ROSES 2025: A.17 Hydrosphere"))
        self.assertEqual(self.link(), [])

    def test_forecast_and_posting_share_a_number(self):
        rec = {"source": "grants.gov", "agency": "NSF", "url": "", "deadline": SOON,
               "title": "Cyberinfrastructure for Sustained Scientific Innovation",
               "raw": {"number": "NSF 24-569"}}
        self.add(dict(rec, id="gg:10"), dict(rec, id="gg:11", synopsis="longer " * 20))
        self.link()
        self.assertEqual(self.dup_of("gg:10"), "gg:11")

    def test_hub_page_joins_nothing(self):
        page = "https://wellcome.org/grant-funding/schemes"
        self.add({"id": "fnd:w1", "source": "Wellcome", "title": "Discovery Awards", "url": page},
                 {"id": "fnd:w2", "source": "Wellcome", "title": "Career Development Awards", "url": page},
                 {"id": "fnd:c1", "source": "CURIOSS", "title": "Wellcome Discovery Awards", "url": page})
        self.assertEqual(self.link(), [])

    def test_title_fallback_only_for_aggregators(self):
        gg = {"id": "gg:363065", "source": "grants.gov", "agency": "DOE", "url": "",
              "title": "Improved Oil and Gas Recovery and Produced Water Management Technologies"}
        irb = {"id": "fnd:oil", "source": "Illinois Research Board", "agency": "DOE", "url": "",
               "title": "Grants for Research on Improved Oil and Gas Recovery and "
                        "Produced Water Management Technologies"}
        other = dict(irb, id="fnd:oil2", source="Wellcome")
        self.add(gg, irb, other)
        self.link()
        self.assertEqual(self.dup_of("fnd:oil"), "gg:363065")
        self.assertIsNone(self.dup_of("fnd:oil2"))

    def test_nsf_bare_grants_gov_number(self):
        # NSF 26-512 as grants.gov and the Research Board listed it, 2026-10-30.
        gg = {"id": "gg:363268", "source": "grants.gov", "agency": "NSF", "url":
              "https://grants.gov/search-results-detail/363268", "deadline": SOON,
              "title": "Unlocking Dataset Value for AI-Enabled Scientific Discovery (AI Datasets)",
              "raw": {"number": "26-512", "agencyCode": "NSF"}}
        irb = {"id": "fnd:aid", "source": "Illinois Research Board", "deadline": SOON,
               "agency": "National Science Foundation",
               "title": "Grants for Using AI to Unlock New Insights from Existing "
                        "Scientific Datasets (AI Datasets)",
               "url": "https://www.nsf.gov/funding/opportunities/ai-datasets-unlocking-"
                      "dataset-value-ai-enabled-scientific-discovery/nsf26-512/solicitation#awd_info"}
        self.assertIn("num:NSF26512", db.call_keys(gg))
        self.assertNotIn("num:26512", db.call_keys(dict(gg, raw={"number": "26-512"})))
        self.add(gg, irb)
        self.link()
        self.assertEqual(self.dup_of("fnd:aid"), "gg:363268")

    def test_number_borrowed_from_a_linked_pdf(self):
        # Neither NOAA's nor AFRL's scheme is a pattern; grants.gov's number is.
        pdf = "https://files.simpler.grants.gov/opportunities/84c7/attachments/d563/"
        gg = {"id": "gg:1", "source": "grants.gov", "agency": "DOD-AFOSR", "url": "",
              "deadline": SOON, "raw": {"number": "NOFOAFRLAFOSR20260001"},
              "title": "Fiscal Year 2027 Defense University Research Instrumentation Program (DURIP)"}
        irb = {"id": "fnd:duirp", "source": "Illinois Research Board", "deadline": SOON,
               "title": "Defense University Research Instrumentation Program (DUIRP)",
               "url": pdf + "NOFOAFRLAFOSR20260001.pdf"}
        near = dict(irb, id="fnd:near", url=pdf + "NOFOAFRLAFOSR202600012.pdf")
        self.add(gg, irb, near)
        self.link()
        self.assertEqual(self.dup_of("fnd:duirp"), "gg:1")
        self.assertIsNone(self.dup_of("fnd:near"))

    def test_short_numbers_borrow_nothing(self):
        gg = {"id": "gg:2", "source": "grants.gov", "agency": "DOS", "url": "",
              "deadline": SOON, "title": "Public Diplomacy Grants", "raw": {"number": "2301"}}
        irb = {"id": "fnd:s", "source": "Illinois Research Board", "deadline": SOON,
               "title": "Something Else Entirely", "url": "https://example.org/2301"}
        self.add(gg, irb)
        self.assertEqual(self.link(), [])

    def test_unlinking_when_the_key_goes(self):
        self.add(GG, CURIOSS)
        self.link()
        # Title too: an aggregator's copy with no key still joins on title.
        moved = dict(CURIOSS, url="https://curioss.org/something-else", raw={},
                     title="Open Source Program Office Seed Grants")
        db.save_keys(self.conn, moved["id"], db.call_keys(moved))
        db.upsert_opportunity(self.conn, moved)
        self.link()
        self.assertIsNone(self.dup_of(CURIOSS["id"]))

    def test_live_filter_hides_duplicates(self):
        self.add(GG, CURIOSS)
        self.link()
        ids = [r["id"] for r in self.conn.execute(f"SELECT o.id FROM opportunities o WHERE {db.LIVE}")]
        self.assertEqual(ids, [GG["id"]])
        self.assertEqual(db.canonical_id(self.conn, CURIOSS["id"]), GG["id"])


class Catalogue(Base):
    def test_also_listed_and_verdict_carry_over(self):
        self.add(GG, IRB)
        self.link()
        db.save_assessment(self.conn, GG["id"], {"score": 80, "category": "ci_program"}, "m", "h")
        self.conn.execute("INSERT INTO feedback (opportunity_id, verdict, aspect, created_at) "
                          "VALUES (?, 'down', 'score', ?)", (IRB["id"], db.now()))
        rows = pipeline.catalogue_rows(self.conn, {})
        self.assertEqual([r["id"] for r in rows], [GG["id"]])
        self.assertEqual(rows[0]["also_listed"],
                         [{"source": "Illinois Research Board", "url": IRB_PAGE,
                           "deadline": SOON}])
        self.assertEqual(rows[0]["human"]["verdict"], "down")


class ListingPages(Base):
    def test_also_listed_falls_back_to_the_source_url(self):
        listing = "https://curioss.org/resources/funding-opportunities/"
        db.record_source_run(self.conn, "CURIOSS", "page", listing, True, 1)
        self.add(GG, CURIOSS)
        self.conn.execute("UPDATE opportunities SET page_url = NULL WHERE id = ?", (CURIOSS["id"],))
        self.link()
        db.save_assessment(self.conn, GG["id"], {"score": 80, "category": "ci_program"}, "m", "h")
        row = pipeline.catalogue_rows(self.conn, {})[0]
        self.assertEqual(row["also_listed"][0]["url"], listing)

    def test_source_kind_and_url_stay_current(self):
        db.record_source_run(self.conn, "CURIOSS", "feed", "https://curioss.org/feed.xml", True, 1)
        db.record_source_run(self.conn, "CURIOSS", "page", "https://curioss.org/list/", True, 1)
        r = self.conn.execute("SELECT kind, url FROM sources WHERE name = 'CURIOSS'").fetchone()
        self.assertEqual(tuple(r), ("page", "https://curioss.org/list/"))

    def test_page_recovered_from_the_synthetic_id(self):
        page = "https://research.illinois.edu/rfp/some-call"
        title = "Grants for Some Call"
        self.add({"id": f"fnd:{db.synthetic_id(page, title)}", "source": "Illinois Research Board",
                  "title": title, "url": NIH_URL})
        self.conn.execute("UPDATE opportunities SET page_url = NULL")
        db.page_changed(self.conn, "https://research.illinois.edu/rfp/other", "x")
        db.page_changed(self.conn, page, "y")
        self.assertEqual(db.fill_page_urls(self.conn), 1)
        self.assertEqual(self.conn.execute("SELECT page_url FROM opportunities").fetchone()[0], page)


class SoonestDeadline(Base):
    """PAR-27-003: grants.gov holds the announcement's expiry, the Research
    Board the next receipt date. The call is as urgent as the sooner one."""

    LATER = (date.today() + timedelta(days=900)).isoformat()
    SOONER = (date.today() + timedelta(days=20)).isoformat()

    def setUp(self):
        super().setUp()
        self.gg = dict(GG, deadline=self.LATER)
        self.irb = dict(IRB, deadline=self.SOONER)
        self.add(self.gg, self.irb)
        self.link()
        db.save_assessment(self.conn, GG["id"], {"score": 70, "category": "ci_program"}, "m", "h")

    def test_next_due(self):
        self.assertEqual(db.next_due(self.conn),
                         {GG["id"]: (self.SOONER, "Illinois Research Board")})

    def test_card_shows_and_sorts_by_the_sooner_date(self):
        other = {"id": "gg:9", "source": "grants.gov", "title": "Unrelated Call",
                 "url": "", "deadline": (date.today() + timedelta(days=60)).isoformat()}
        self.add(other)
        db.save_assessment(self.conn, "gg:9", {"score": 99, "category": "ci_program"}, "m", "h")
        rows = pipeline.catalogue_rows(self.conn, {})
        self.assertEqual([r["id"] for r in rows], [GG["id"], "gg:9"])
        self.assertEqual(rows[0]["deadline"], self.SOONER)
        self.assertEqual(rows[0]["deadline_from"], "Illinois Research Board")
        self.assertEqual(rows[0]["listed_deadline"], self.LATER)
        self.assertIsNone(rows[1]["deadline_from"])

    def test_closing_soon_digest_sees_it(self):
        items = pipeline.build_digest(self.conn, "closing-soon", respect_sent_log=False)
        self.assertEqual([i["id"] for i in items], [GG["id"]])
        self.assertIn("(per Illinois Research Board)",
                      pipeline.render_digest("closing-soon", items, []))

    def test_closed_or_later_copies_change_nothing(self):
        self.conn.execute("UPDATE opportunities SET deadline = ? WHERE id = ?", (PAST, IRB["id"]))
        self.assertEqual(db.next_due(self.conn), {})
        self.conn.execute("UPDATE opportunities SET deadline = ? WHERE id = ?",
                          ((date.today() + timedelta(days=1000)).isoformat(), IRB["id"]))
        self.assertEqual(db.next_due(self.conn), {})

    def test_date_range_matches_any_listings_date(self):
        later_round = (date.today() + timedelta(days=100)).isoformat()
        self.add(dict(IRB, id="fnd:irb2", deadline=later_round,
                      page_url=IRB_PAGE + "-round-2"))
        self.link()
        rows = catalogue.load(self.conn, {})

        def hits(lo, hi):
            return [o["id"] for o in catalogue.search(
                self.conn, rows, None, deadline_from=lo, deadline_to=hi)]
        around = lambda d: ((date.fromisoformat(d) - timedelta(days=1)).isoformat(),
                            (date.fromisoformat(d) + timedelta(days=1)).isoformat())
        self.assertEqual(hits(*around(self.SOONER)), [GG["id"]])      # the shown date
        self.assertEqual(hits(*around(later_round)), [GG["id"]])     # the second round
        self.assertEqual(hits(*around(self.LATER)), [GG["id"]])      # grants.gov's own
        self.assertEqual(hits(*around((date.today() + timedelta(days=300)).isoformat())), [])

    def test_funder_filter_and_counts_include_folded_copies(self):
        rows = catalogue.load(self.conn, {})
        hits = catalogue.search(self.conn, rows, None, funder="Illinois Research Board")
        self.assertEqual([o["id"] for o in hits], [GG["id"]])
        self.assertEqual([o["id"] for o in catalogue.search(self.conn, rows, None, funder="NIH")],
                         [GG["id"]])
        funders = {f["name"]: f["count"] for f in catalogue.facets(self.conn, rows)["funders"]}
        self.assertEqual(funders.get("Illinois Research Board"), 1)

    def test_rolling_funder_copy_takes_a_stated_date(self):
        self.conn.execute("UPDATE opportunities SET deadline = NULL WHERE id = ?", (GG["id"],))
        self.assertEqual(db.next_due(self.conn)[GG["id"]][0], self.SOONER)


if __name__ == "__main__":
    unittest.main()
