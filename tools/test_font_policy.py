import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import font_policy


class FontPolicyTests(unittest.TestCase):
    def test_removal_document_describes_the_shared_asset_bundle(self):
        with TemporaryDirectory(prefix='font-removals-', dir=Path(__file__).parent) as directory:
            font_policy.write_removals(directory)
            text = (Path(directory) / 'FONT-ASSET-REMOVALS.md').read_text()
        self.assertIn('Paths are relative to the theme asset bundle', text)
        self.assertIn('binary assets kept outside the repository', text)
        self.assertNotIn('~/Developer/', text)
        self.assertNotIn('riosoma-theme-assets', text)

    def test_removes_bundled_files_and_rewrites_their_stacks(self):
        css = '@font-face {font-family:"Anegra";src:url(../assets/fonts/Anegra.woff2)} :root {--font-display:"Anegra",Impact,sans-serif}'
        result = font_policy.rewrite(css, 'maximalist')
        self.assertNotIn('@font-face', result)
        self.assertNotIn('Anegra', result)
        self.assertIn('"Limelight",system-ui,sans-serif', result)

    def test_unknown_bundled_font_requires_review_even_if_family_is_open(self):
        with self.assertRaisesRegex(ValueError, 'Unreviewed bundled font'):
            font_policy.rewrite('@font-face {font-family:"DM Sans";src:url(marketplace.ttf)}', 'maximalist')

    def test_longer_aliases_are_rewritten_before_prefixes(self):
        css = ':root {--font-inline:"AD Monsante Inline","AD Monsante",serif}'
        result = font_policy.rewrite(css, 'art-deco')
        self.assertIn('"Monoton","Poiret One",serif', result)

    def test_texture_urls_and_variable_names_are_preserved(self):
        css = ':root {--Anegra-size:20px;--texture:url(../assets/Anegra.png);--font-display:"Anegra",sans-serif}'
        result = font_policy.rewrite(css, 'maximalist')
        self.assertIn('--Anegra-size:20px', result)
        self.assertIn('url(../assets/Anegra.png)', result)
        self.assertIn('"Limelight",sans-serif', result)

    def test_color_components_are_never_deduplicated(self):
        css = ':root {--surface:rgb(204,204,204);--ink:rgba(0,0,0,1);--font-mono:monospace,monospace}'
        result = font_policy.rewrite(css, 'maximalist')
        self.assertIn('rgb(204,204,204)', result)
        self.assertIn('rgba(0,0,0,1)', result)
        self.assertIn('--font-mono:monospace}', result)

    def test_canonical_alias_does_not_need_a_duplicate_stylesheet(self):
        self.assertIsNone(font_policy.stylesheet_url('jmds'))
        self.assertIn('family=Roboto', font_policy.stylesheet_url('industrial-retrofuturism'))


if __name__ == '__main__':
    unittest.main()
