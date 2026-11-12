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


class ScopedElement(Document):
    def __init__(self, token, matches=(), inside=None):
        super().__init__(token, matches)
        self.inside = inside
        self.scripts = []

    def run_js(self, script):
        self.scripts.append(script)
        if '.isWithin(' in script:
            return self.inside is not None and json.dumps(self.inside) in script
        if '.register(' in script:
            return {'token': self.token, 'tag': 'div', 'css': ':scope > div', 'xpath': './div'}
        return self.token


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


    def scoped_chain(self):
        leaf = ScopedElement('leaf', inside='inner')
        inner = ScopedElement('inner', [leaf], inside='outer')
        outer = ScopedElement('outer', [inner])
        self.tab.matches = [outer]
        context = {'documentToken':'root-live','steps':[], 'parents':[
            {'mode':'CSS','expression':'#orders','token':'old-outer'},
            {'mode':'DP','expression':'tag:article@@data-id=42','token':'old-inner'}]}
        return context, outer, inner, leaf

    def test_queries_inside_each_unique_parent_and_returns_fresh_tokens(self):
        context, outer, inner, leaf = self.scoped_chain()
        result = self.request(action='query', context=context, mode='XPath', expression='./button')
        self.assertEqual(self.tab.queries, ['css:#orders'])
        self.assertEqual(outer.queries, ['tag:article@@data-id=42'])
        self.assertEqual(inner.queries, ['xpath:./button'])
        self.assertEqual(result['total'], 1)
        self.assertEqual([p['token'] for p in result['context']['parents']], ['outer', 'inner'])
        self.assertEqual([p['token'] for p in context['parents']], ['old-outer', 'old-inner'])
        self.assertTrue(any('.register(this, "inner")' in script for script in leaf.scripts))

    def test_resolves_scope_for_capture_without_requiring_a_child_expression(self):
        context, outer, inner, _ = self.scoped_chain()
        result = self.request(action='resolve_scope', context=context, mode='', expression='')
        self.assertEqual(result['context']['parents'][-1]['token'], 'inner')
        self.assertEqual(inner.queries, [])
        self.assertEqual(result['matches'], [])

    def test_reports_the_exact_parent_that_is_missing_or_no_longer_unique(self):
        context, outer, inner, _ = self.scoped_chain()
        outer.matches = []
        with self.assertRaisesRegex(ValueError, '第 2 层父级匹配到 0'):
            self.request(context=context)
        outer.matches = [inner, inner]
        with self.assertRaisesRegex(ValueError, '第 2 层父级匹配到 2'):
            self.request(context=context)
        self.tab.matches = []
        with self.assertRaisesRegex(ValueError, '第 1 层父级匹配到 0'):
            self.request(action='resolve_scope',context=context)

    def test_rejects_escaping_xpath_and_cross_context_parent_or_result(self):
        context, _, inner, leaf = self.scoped_chain()
        inner.inside = None
        with self.assertRaisesRegex(ValueError, '超出当前父级范围'):
            self.request(context=context)
        inner.inside = 'outer'
        leaf.inside = None
        with self.assertRaisesRegex(ValueError, '超出当前父级范围'):
            self.request(context=context,mode='XPath',expression='ancestor::*')
        inner.matches = [inner]
        with self.assertRaisesRegex(ValueError, '超出当前父级范围'):
            self.request(context=context,mode='XPath',expression='.')

    def test_validates_scoped_results_past_the_display_limit(self):
        context, _, inner, leaf = self.scoped_chain()
        inner.matches = [leaf] * 200 + [ScopedElement('outside')]
        with self.assertRaisesRegex(ValueError, '超出当前父级范围'):
            self.request(context=context)

    def test_rejects_document_change_while_resolving_parent_chain(self):
        context, _, _, _ = self.scoped_chain()
        self.tab.tokens = iter(['root-live', 'root-live', 'changed'])
        with self.assertRaisesRegex(ValueError, '校验期间页面已变化'):
            self.request(action='resolve_scope', context=context)


if __name__ == '__main__':
    unittest.main()
