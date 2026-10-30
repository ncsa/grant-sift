"""Reading grants.gov whole (adapters.grants_gov).

Stdlib only:  python -m unittest discover tests
"""

import unittest
from unittest import mock

from grant_sift import adapters


def _page(total, ids):
    resp = mock.Mock()
    resp.json.return_value = {"data": {"hitCount": total, "oppHits": [
        {"id": i, "number": f"N-{i}", "title": f"Call {i}", "agencyCode": "NSF"} for i in ids]}}
    return resp


class GrantsGov(unittest.TestCase):
    def test_pages_until_the_reported_total(self):
        pages = [_page(5, [1, 2]), _page(5, [3, 4]), _page(5, [5])]
        with mock.patch.object(adapters.requests, "post", side_effect=pages) as post:
            recs = adapters.grants_gov(rows=2)
        self.assertEqual([r["id"] for r in recs], [f"gg:{i}" for i in range(1, 6)])
        self.assertEqual([c.kwargs["json"]["startRecordNum"] for c in post.call_args_list], [0, 2, 4])
        self.assertTrue(all(c.kwargs["json"]["keyword"] == "" for c in post.call_args_list))

    def test_a_short_pull_raises(self):
        pages = [_page(5, [1, 2]), _page(5, [])]
        with mock.patch.object(adapters.requests, "post", side_effect=pages):
            with self.assertRaisesRegex(RuntimeError, "2 of 5"):
                adapters.grants_gov(rows=2)


if __name__ == "__main__":
    unittest.main()
