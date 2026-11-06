"""config/profile.yaml: the shipped defaults reproduce the rules that used to
be written in code, and a malformed profile fails loudly.

Stdlib only:  python -m unittest discover tests
"""

import itertools
import unittest
from datetime import date, timedelta
from pathlib import Path

import yaml

from grant_sift import catalogue, llm, pipeline, profile

ROOT = Path(__file__).resolve().parent.parent


def _score(r):
    s = r["score"]
    return s if isinstance(s, (int, float)) else 0


def _within(deadline, days):
    if not deadline:
        return False
    try:
        return date.fromisoformat(deadline) <= date.today() + timedelta(days=days)
    except ValueError:
        return False


# The rules as they were hardcoded in pipeline.py and catalogue.py.
OLD_FEEDS = {
    "ci-programs":  lambda r: r["category"] == "ci_program" and _score(r) >= 60,
    "embedded":     lambda r: r["category"] in ("embedded_software", "domain_subaward") and _score(r) >= 65,
    "foundations":  lambda r: r["source"] != "grants.gov" and _score(r) >= 60,
    "closing-soon": lambda r: _within(r["deadline"], 30) and _score(r) >= 60,
    "roster-match": lambda r: r["match_name"] and _score(r) >= 60,
}
OLD_LABELS = {
    "closing-soon": "Closing within 30 days",
    "roster-match": "Matches a past collaborator",
    "ci-programs": "CI / research-software programs",
    "embedded": "Domain / embedded calls",
    "foundations": "Foundations (non-NSF / non-grants.gov)",
}
OLD_CHIPS = {
    "embedded": lambda o: o["category"] in ("embedded_software", "domain_subaward"),
    "ci": lambda o: o["category"] == "ci_program",
    "foundation": lambda o: o["source"] != "grants.gov",
}


def rows():
    today = date.today()
    deadlines = [None, "", "not a date", (today - timedelta(days=3)).isoformat(),
                 (today + timedelta(days=30)).isoformat(),
                 (today + timedelta(days=31)).isoformat()]
    cats = [None, "ci_program", "embedded_software", "domain_subaward",
            "sustainability", "not_relevant"]
    for cat, score, src, dl, match in itertools.product(
            cats, [None, "x", 0, 59, 60, 64, 65, 90], ["grants.gov", "nsf", "sam.gov"],
            deadlines, [None, "", "Ada"]):
        yield {"category": cat, "score": score, "source": src,
               "deadline": dl, "match_name": match}


class Defaults(unittest.TestCase):
    def test_feed_ids_order_and_labels_unchanged(self):
        self.assertEqual(list(pipeline.FEEDS),
                         ["ci-programs", "embedded", "foundations", "closing-soon", "roster-match"])
        self.assertEqual(pipeline.FEED_LABELS, OLD_LABELS)

    def test_feeds_match_the_old_rules(self):
        for r in rows():
            for fid, old in OLD_FEEDS.items():
                self.assertEqual(bool(pipeline.FEEDS[fid](r)), bool(old(r)), (fid, r))

    def test_chips_match_the_old_rules(self):
        for r in rows():
            for cid, old in OLD_CHIPS.items():
                self.assertEqual(bool(catalogue.FILTERS[cid](r, {})), bool(old(r)), (cid, r))

    def test_scoring_prompt_unchanged(self):
        """The RSE instance's stored scores were judged against this exact
        prompt; the default profile must rebuild it byte for byte."""
        fixture = (ROOT / "tests/fixtures/assess_system_rse.txt").read_text()
        self.assertEqual(llm.ASSESS_SYSTEM, fixture)
        self.assertEqual(llm.AXES, ("software_depth", "data_management", "compute_intensity",
                                    "sustainability", "partner_need"))
        self.assertEqual(llm.CATCH_ALL, "not_relevant")
        self.assertEqual(profile.PROFILE["scoring"]["label"], "RSE relevance")

    def test_wording(self):
        g = profile.PROFILE["group"]
        self.assertIn("Research Software Engineering", g["tagline"])
        self.assertEqual(g["match_phrase"], "match a past collaborator")


class Validation(unittest.TestCase):
    BASE = {
        "org": {"name": "O", "email_domain": "o.edu", "contact_email": "a@o.edu"},
        "group": {"tagline": "t", "description": "d", "match_phrase": "m"},
        "scoring": {"label": "L", "prompt": "P", "guide": "80-100  good",
                    "categories": [{"id": "a", "description": "A"},
                                   {"id": "none", "description": "rest"}]},
    }

    def parse(self, **kw):
        return profile.parse(self.BASE | kw)

    def test_rule_category_must_be_a_scoring_category(self):
        with self.assertRaisesRegex(profile.ProfileError, "not a scoring category"):
            self.parse(call_types=[{"id": "x", "label": "X", "category": ["ci_program"]}])

    def test_scoring_and_org_required(self):
        for key in ("org", "scoring"):
            with self.assertRaisesRegex(profile.ProfileError, key):
                profile.parse({k: v for k, v in self.BASE.items() if k != key})

    def test_no_axes_leaves_them_out_of_the_prompt(self):
        text = llm.build_assess_system(self.parse()["scoring"])
        self.assertNotIn('"axes"', text)
        self.assertIn('  "a"                 A', text)
        self.assertIn("  80-100  good", text)

    def test_typo_is_an_error_not_a_match_all(self):
        with self.assertRaisesRegex(profile.ProfileError, "unknown key"):
            self.parse(digests=[{"id": "a", "label": "A", "min_scor": 60}])

    def test_duplicate_id(self):
        with self.assertRaisesRegex(profile.ProfileError, "duplicate"):
            self.parse(call_types=[{"id": "a", "label": "A"}, {"id": "a", "label": "B"}])

    def test_bad_values(self):
        for bad in ({"min_score": "60"}, {"has_match": "yes"}, {"category": [1]}):
            with self.assertRaises(profile.ProfileError):
                self.parse(digests=[{"id": "a", "label": "A"} | bad])

    def test_group_required(self):
        with self.assertRaisesRegex(profile.ProfileError, "group.tagline"):
            profile.parse(self.BASE | {"group": {"description": "d", "match_phrase": "m"}})

    def test_has_match_false_and_source(self):
        p = self.parse(digests=[{"id": "a", "label": "A", "has_match": False,
                                 "source": ["nsf"]}])
        t = p["digests"][0]["test"]
        self.assertTrue(t({"match_name": None, "source": "nsf"}))
        self.assertFalse(t({"match_name": "Ada", "source": "nsf"}))
        self.assertFalse(t({"match_name": None, "source": "nih"}))


class RosterContactKey(unittest.TestCase):
    def test_legacy_ncsa_contact_still_resolves(self):
        old = {"name": "Ada", "ncsa_contact": ["Bo"]}
        new = {"name": "Ada", "our_contact": ["Bo"]}
        for e in (old, new):
            out = pipeline.normalise([e], ROOT / "tests")
            self.assertEqual([p["name"] for p in out[0]["our_contact"]], ["Bo"])
            self.assertNotIn("ncsa_contact", out[0])

    def test_new_key_wins(self):
        e = pipeline.upgrade_entry({"ncsa_contact": ["Old"], "our_contact": ["New"]})
        self.assertEqual(e["our_contact"], ["New"])


class ShippedProfiles(unittest.TestCase):
    def test_every_shipped_profile_loads(self):
        for path in sorted((ROOT / "config").glob("profile*.yaml")):
            with self.subTest(path.name):
                p = profile.parse(yaml.safe_load(path.read_text()))
                text = llm.build_assess_system(p["scoring"])
                for c in p["scoring"]["categories"]:
                    self.assertIn(f'"{c["id"]}"', text)

    def test_general_profile_has_no_rse_wording(self):
        text = (ROOT / "config/profile.general.yaml").read_text()
        body = "\n".join(ln for ln in text.splitlines()
                         if not ln.lstrip().startswith("#")
                         and not ln.lstrip().startswith(("contact_email", "name:", "email_domain")))
        for word in ("RSE", "research software", "cyberinfrastructure", "HPC"):
            self.assertNotIn(word, body)


if __name__ == "__main__":
    unittest.main()
