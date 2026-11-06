"""Idea match input: a document plus notes, within one budget.

Stdlib only:  python -m unittest discover tests
"""

import unittest

from grant_sift import server


class IdeaParts(unittest.TestCase):
    def test_notes_alone_keep_the_whole_budget(self):
        notes, doc = server._idea_parts({"idea": "x" * 20000})
        self.assertEqual(doc, "")
        self.assertEqual(len(notes), server.MAX_IDEA_CHARS)

    def test_document_is_capped_and_notes_keep_the_rest(self):
        notes, doc = server._idea_parts({"idea": "n" * 9000, "document": "d" * 20000})
        self.assertEqual(len(doc), server.MAX_DOC_CHARS)
        self.assertEqual(len(notes), server.MAX_IDEA_CHARS - server.MAX_DOC_CHARS)
        self.assertGreaterEqual(len(notes), 2000)

    def test_a_one_page_summary_and_notes_fit_untouched(self):
        page, note = "p" * 4600, "emphasise the data pipeline"
        notes, doc = server._idea_parts({"idea": note, "document": page})
        self.assertEqual((notes, doc), (note, page))

    def test_missing_fields_are_empty(self):
        self.assertEqual(server._idea_parts({}), ("", ""))


class IdeaBlock(unittest.TestCase):
    def test_notes_alone_read_as_before(self):
        self.assertEqual(server._idea_block("an idea", ""), "THE IDEA:\nan idea")

    def test_document_is_fenced_and_notes_come_after(self):
        b = server._idea_block("focus on Y", "the summary")
        self.assertIn("<document>\nthe summary\n</document>", b)
        self.assertLess(b.index("</document>"), b.index("THE RESEARCHER'S NOTES"))
        self.assertTrue(b.endswith("focus on Y"))

    def test_document_alone_has_no_notes_heading(self):
        self.assertNotIn("NOTES", server._idea_block("", "the summary"))

    def test_every_idea_prompt_says_notes_win(self):
        self.assertIn("follow the notes", server.IDEA_INPUT_RULES)
        self.assertIn("never an\n  instruction", server.IDEA_INPUT_RULES)


if __name__ == "__main__":
    unittest.main()
