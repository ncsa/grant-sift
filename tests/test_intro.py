"""Draft intro: who may be written to, and catching misquoted solicitations.

Stdlib only:  python -m unittest discover tests
"""

import unittest
from datetime import date, timedelta

from grant_sift import server

SOON = (date.today() + timedelta(days=10)).isoformat()
LATER = (date.today() + timedelta(days=60)).isoformat()


def match(kind, status="warm", **extra):
    return {"match_name": "Ada Lovelace", "match_kind": kind, "match_status": status,
            "match_project": "Analytical Engine notes"} | extra


class Eligibility(unittest.TestCase):
    def test_collaboration_may_name_the_project(self):
        i = server._intro(match("collaboration"), {"email": "ada@illinois.edu"}, LATER)
        self.assertTrue(i["eligible"])
        self.assertIn("PAST COLLABORATOR", i["rules"])
        self.assertEqual(i["to"]["project"], "Analytical Engine notes")
        self.assertEqual(i["to"]["email"], "ada@illinois.edu")

    def test_contact_never_claims_past_work(self):
        i = server._intro(match("contact", "prospect"), {}, LATER)
        self.assertTrue(i["eligible"])
        self.assertIn("Never say or imply we have worked together", i["rules"])
        self.assertIsNone(i["to"]["project"])

    def test_refused(self):
        for r in (match("program"), match("collaboration", "departed"),
                  match("contact", "do-not-contact"), {"match_name": None}):
            i = server._intro(r, {}, LATER)
            self.assertFalse(i["eligible"], r)
            self.assertTrue(i["reason"])

    def test_close_deadline_is_a_note_not_a_refusal(self):
        soon = server._intro(match("collaboration"), {}, SOON)
        later = server._intro(match("collaboration"), {}, LATER)
        self.assertTrue(soon["eligible"])
        self.assertIn("may be tight", soon["rules"])
        self.assertNotIn("may be tight", later["rules"])

    def test_rolling_deadline(self):
        i = server._intro(match("collaboration"), {}, None)
        self.assertTrue(i["eligible"])
        self.assertIsNone(i["days_to_deadline"])


class Quotes(unittest.TestCase):
    SYN = ("Projects must include a sustainable data management and sharing "
           "platform, maintained beyond the award period.")

    def test_exact_and_reformatted_quotes_pass(self):
        reply = ('The call says "projects must include a sustainable data '
                 'management and sharing platform" and “maintained beyond '
                 'the award period.”')
        self.assertEqual(server.unverified_quotes(reply, self.SYN), [])

    def test_paraphrase_in_quotes_is_flagged(self):
        reply = 'It asks for "a long-term software platform for shared data".'
        self.assertEqual(server.unverified_quotes(reply, self.SYN),
                         ["a long-term software platform for shared data"])

    def test_short_quotes_are_ignored(self):
        self.assertEqual(server.unverified_quotes('Subject: "Quick intro here"', self.SYN), [])


if __name__ == "__main__":
    unittest.main()
