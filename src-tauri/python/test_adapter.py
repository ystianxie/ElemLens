"""Regression checks for rebinding saved recording scopes without playing actions."""
import io
import json
import unittest
from unittest.mock import Mock, patch

import adapter


class Document:
    def __init__(self, token, matches=()):
        self.token = token
        self.matches = list(matches)
        self.nodes = {}
        self.url = 'https://example.test/current'
        self.shadow_root = None
        self.queries = []
        self.tokens = None

    def run_js(self, script):
        return next(self.tokens) if self.tokens else self.token

    def ele(self, expression, timeout=0):
        return self.nodes.get(expression)

    def eles(self, expression, timeout=0):
        self.queries.append(expression)
        return self.matches


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.tab = Document('root-live')
        self.browser = Mock()
        self.browser.get_tab.return_value = self.tab
        self.tab.tab_id = 'tab'
        self.options = Mock()
        self.options.set_address.return_value = self.options
        self.options.existing_only.return_value = self.options
        self.opener = Mock()
        self.opener.open.side_effect = lambda *a, **k: io.BytesIO(json.dumps({'User-Agent':'HeadlessChrome/test'}).encode())
        self.patches = [patch('DrissionPage.Chromium',return_value=self.browser),
                        patch('DrissionPage.ChromiumOptions',return_value=self.options),
                        patch.object(adapter,'build_opener',return_value=self.opener)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def request(self, **changes):
        request = {'action':'recording_query','endpoint':'http://127.0.0.1:9222','targetId':'tab',
                   'context':{'documentToken':'root-live','steps':[]},'mode':'DP','expression':'@id=name'}
        request.update(changes)
        return adapter.dispatch(request)

    def test_rebinds_nested_frame_and_shadow_to_live_document(self):
        frame = Document('frame-live')
        host = Document('host')
        shadow = Document('frame-live',[Mock(run_js=Mock(return_value={'token':'element'}))])
        host.shadow_root = shadow
        frame.nodes['css:x-form'] = host
        self.tab.nodes['css:#child'] = frame
        steps = [{'kind':'frame','selector':'#child'},{'kind':'shadow','selector':'x-form'}]
        result = self.request(context={'documentToken':'root-live','steps':steps})
        self.assertEqual(result['context']['documentToken'],'frame-live')
        self.assertEqual(result['context']['steps'],steps)
        self.assertEqual(result['total'],1)
        self.assertEqual(shadow.queries,['@id=name'])
        self.options.headless.assert_called_once_with(True)
        self.browser.quit.assert_not_called()

    def test_legacy_query_still_rejects_old_document(self):
        with self.assertRaisesRegex(ValueError,'页面已刷新'):
            self.request(action='query',context={'documentToken':'old','steps':[]})

    def test_rebinds_saved_document_but_rejects_change_during_query(self):
        result = self.request(context={'documentToken':'old','steps':[]})
        self.assertEqual(result['context']['documentToken'],'root-live')
        self.tab.tokens = iter(['root-live','root-live','different'])
        with self.assertRaisesRegex(ValueError,'校验期间页面已变化'):
            self.request()

    def test_missing_frame_or_shadow_is_an_error_not_zero_matches(self):
        with self.assertRaisesRegex(ValueError,'宿主未找到'):
            self.request(context={'documentToken':'root-live','steps':[{'kind':'frame','selector':'#missing'}]})
        self.tab.nodes['css:x-form'] = Document('host')
        with self.assertRaisesRegex(ValueError,'Shadow Root 不可访问'):
            self.request(context={'documentToken':'root-live','steps':[{'kind':'shadow','selector':'x-form'}]})

    def test_counts_all_matches_but_limits_registered_elements(self):
        element = Mock(run_js=Mock(return_value={'token':'e'}))
        self.tab.matches = [element] * 201
        result = self.request(mode='CSS',expression='input')
        self.assertEqual(result['total'],201)
        self.assertEqual(len(result['matches']),200)
        self.assertTrue(result['truncated'])
        self.assertEqual(self.tab.queries,['css:input'])
        element.click.assert_not_called()
        element.input.assert_not_called()

    def test_rejects_scalar_results(self):
        self.tab.matches = 5
        with self.assertRaisesRegex(ValueError,'标量'):
            self.request()


if __name__ == '__main__':
    unittest.main()
