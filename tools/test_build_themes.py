import unittest

from build_themes import stable_color_precision


class ThemePrecisionTests(unittest.TestCase):
    def test_platform_variants_emit_the_same_color(self):
        mac = 'oklab(0.2516 -0.00333183 -0.0248514 / 0.76)'
        linux = 'oklab(0.2516 -0.00333182 -0.0248514 / 0.76)'
        expected = 'oklab(0.2516 -0.00333 -0.02485 / 0.76)'
        self.assertEqual(stable_color_precision(mac), expected)
        self.assertEqual(stable_color_precision(linux), expected)

    def test_css_and_manifest_values_match_without_mutating_check_inputs(self):
        color = 'oklab(0.986764 -0.00415047 0.000755558 / 0.740001)'
        original = {'legibility': [{'--rio-aa-text-muted': color}], 'count': 3}
        rounded = stable_color_precision(original)
        expected = 'oklab(0.98676 -0.00415 0.00076 / 0.74)'
        self.assertEqual(rounded['legibility'][0]['--rio-aa-text-muted'], expected)
        self.assertEqual(original['legibility'][0]['--rio-aa-text-muted'], color)
        self.assertEqual(rounded['count'], 3)
        css = f'--rio-aa-text-muted: {color};'
        self.assertEqual(stable_color_precision(css), f'--rio-aa-text-muted: {expected};')
        self.assertEqual(stable_color_precision(rounded), rounded)

    def test_tiny_components_do_not_emit_negative_zero(self):
        self.assertEqual(stable_color_precision('oklab(1 -1e-8 1e-8 / 1)'), 'oklab(1 0 0 / 1)')

    def test_other_values_are_preserved(self):
        value = 'rgb(12, 34, 56); --tint: 0.12345678%; #abcdef'
        self.assertEqual(stable_color_precision(value), value)


if __name__ == '__main__':
    unittest.main()
