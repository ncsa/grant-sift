"""Who the signed-in person is, from what the proxy hands over.

Depending on the realm and the proxy's config, the email header carries a
real address or a bare NetID. Both have to work, so a move between realms
needs no code change.

Stdlib only:  python -m unittest discover tests
"""

import unittest
from unittest import mock

from grant_sift import auth, catalogue, profile, server


def _who(username="cwang138", email=""):
    return auth.Principal(username=username, email=email, authenticated=True)


class IsMe(unittest.TestCase):
    def setUp(self):
        org = dict(profile.PROFILE["org"], email_domain="illinois.edu")
        patch = mock.patch.dict(profile.PROFILE, {"org": org})
        patch.start()
        self.addCleanup(patch.stop)

    def test_real_email_matches_exactly(self):
        self.assertTrue(catalogue.is_me("pat@example.org", _who("pat", "Pat@Example.org")))

    def test_real_email_matches_a_sibling_address_of_ours(self):
        who = _who(email="cwang138@illinois.edu")
        self.assertTrue(catalogue.is_me("cwang138@ncsa.illinois.edu", who))

    def test_same_name_at_an_outside_domain_is_not_staff(self):
        who = _who("jdoe", "jdoe@gmail.com")
        self.assertFalse(catalogue.is_me("jdoe@illinois.edu", who))

    def test_our_netid_is_not_an_outside_contact(self):
        who = _who("jdoe", "jdoe@illinois.edu")
        self.assertFalse(catalogue.is_me("jdoe@gmail.com", who))

    def test_bare_netid_in_the_email_header(self):
        who = _who(email="cwang138")
        self.assertTrue(catalogue.is_me("cwang138@ncsa.illinois.edu", who))
        self.assertFalse(catalogue.is_me("cwang1380@illinois.edu", who))

    def test_username_only(self):
        self.assertTrue(catalogue.is_me("cwang138@illinois.edu", _who()))

    def test_real_email_wins_over_the_username(self):
        who = _who("cwang138", "someone@example.org")
        self.assertFalse(catalogue.is_me("cwang138@illinois.edu", who))

    def test_anonymous_is_nobody(self):
        self.assertFalse(catalogue.is_me("cwang138@illinois.edu", auth.ANONYMOUS))


class DigestAddress(unittest.TestCase):
    def setUp(self):
        org = dict(profile.PROFILE["org"], email_domain="illinois.edu")
        for patch in (mock.patch.dict(profile.PROFILE, {"org": org}),
                      mock.patch.object(auth, "MODE", "proxy")):
            patch.start()
            self.addCleanup(patch.stop)

    def test_real_email_is_used_as_is(self):
        who = _who("pat", "Pat@Example.org")
        self.assertEqual(server._identity_email(who, None), "pat@example.org")

    def test_bare_netid_gets_our_domain(self):
        self.assertEqual(server._identity_email(_who(email="cwang138"), None),
                         "cwang138@illinois.edu")

    def test_username_only_gets_our_domain(self):
        self.assertEqual(server._identity_email(_who(), None), "cwang138@illinois.edu")

    def test_a_requested_address_cannot_override_the_login(self):
        who = _who("pat", "pat@example.org")
        self.assertEqual(server._identity_email(who, "victim@example.org"), "pat@example.org")


if __name__ == "__main__":
    unittest.main()
