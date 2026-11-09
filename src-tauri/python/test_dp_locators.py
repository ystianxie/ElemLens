"""Check the generated fixture locators against the actual installed DP parser."""
import json
from pathlib import Path
import unittest

from DrissionPage._functions.locator import get_loc
from lxml import html


class NativeLocatorTests(unittest.TestCase):
    def test_generated_locators_match_expected_elements(self):
        fixtures = json.loads((Path(__file__).resolve().parents[2] / 'tests' / 'dp-locators.json').read_text(encoding='utf-8'))
        for fixture in fixtures:
            with self.subTest(fixture=fixture['name']):
                engine, expression = get_loc(fixture['expression'])
                self.assertEqual(engine, 'xpath')
                root = html.fromstring(fixture['html'])
                # Limit the fixture to its main subtree; lxml may add html/body.
                matches = [node for node in root.xpath(expression) if node is root or root in node.iterancestors()]
                self.assertEqual([node.text_content() for node in matches], fixture['expected'])


if __name__ == '__main__':
    unittest.main()
