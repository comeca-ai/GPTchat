import unittest

from discover_rfb import DAV_ROOT, dav_url, parse_dav_entries


DAV_FIXTURE = """<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/public.php/dav/files/token/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
  <d:response><d:href>/public.php/dav/files/token/2026-09/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
  <d:response><d:href>/public.php/dav/files/token/2026-09/Estabelecimentos0.zip</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response>
</d:multistatus>
"""


class DiscoverRfbTest(unittest.TestCase):
    def test_parse_dav_multistatus(self):
        self.assertEqual(
            parse_dav_entries(DAV_FIXTURE),
            [
                {"name": "token", "is_collection": True},
                {"name": "2026-09", "is_collection": True},
                {"name": "Estabelecimentos0.zip", "is_collection": False},
            ],
        )

    def test_download_url_preserves_snapshot_and_filename(self):
        self.assertEqual(
            dav_url("2026-09/Qualificações.zip", directory=False),
            DAV_ROOT + "2026-09/Qualifica%C3%A7%C3%B5es.zip",
        )


if __name__ == "__main__":
    unittest.main()
