import threading
import unittest
from types import SimpleNamespace
from network_listener import listen, response_content


def packet(url='https://example.test/api/user', method='GET', failed=False):
    return SimpleNamespace(url=url, method=method, is_failed=failed,
                           response=SimpleNamespace(status=200), fail_info=SimpleNamespace(errorText='net::ERR_FAILED'))


class FakeListener:
    def __init__(self, packets, clock):
        self.packets = list(packets)
        self.clock = clock
        self.stopped = False

    def start(self, targets, method):
        self.targets, self.method = targets, method

    def wait(self, **kwargs):
        self.clock[0] += kwargs['timeout']
        return self.packets.pop(0) if self.packets else False

    def stop(self):
        self.stopped = True


class ListenerTests(unittest.TestCase):
    def run_session(self, packets, count=1, timeout=None, fit=True, method='ALL', stop_after=None, beta=False):
        now = [0.0]
        listener = FakeListener(packets, now)
        if beta:
            listener.start = lambda urls: setattr(listener, 'targets', urls)
        stopped = threading.Event()
        events = []
        def send(kind, data):
            events.append((kind, data))
            if kind == 'packet' and stop_after and data['index'] >= stop_after:
                stopped.set()
        listen(SimpleNamespace(listen=listener), {'targets':['api/user','api/order'], 'count':count,
               'timeout':timeout, 'fitCount':fit, 'method':method}, stopped, send, lambda: now[0])
        self.assertTrue(listener.stopped)
        self.assertEqual(events[0][0], 'ready')
        return events

    def test_single_stops_after_one_of_many_keywords(self):
        events = self.run_session([packet(), packet()])
        self.assertEqual([kind for kind, _ in events], ['ready', 'packet', 'finished'])
        self.assertTrue(events[-1][1]['metCount'])

    def test_count_is_total_not_each_keyword(self):
        events = self.run_session([packet(), packet(), packet()], count=3)
        self.assertEqual(events[-1][1]['total'], 3)
        self.assertTrue(events[-1][1]['accepted'])

    def test_fit_count_only_affects_timeout_acceptance(self):
        for fit in (True, False):
            events = self.run_session([packet(), packet()], count=3, timeout=.5, fit=fit)
            self.assertEqual(events[-1][1]['reason'], 'timeout')
            self.assertEqual(events[-1][1]['total'], 2)
            self.assertEqual(events[-1][1]['accepted'], not fit)
            self.assertFalse(events[-1][1]['metCount'])
            self.assertEqual(len([e for e in events if e[0] == 'packet']), 2)

    def test_unlimited_wait_still_waits_for_count_with_fit_false(self):
        events = self.run_session([packet(), packet(), packet()], count=3, fit=False)
        self.assertEqual(events[-1][1]['reason'], 'complete')
        self.assertEqual(events[-1][1]['total'], 3)

    def test_empty_timeout_is_not_accepted(self):
        events = self.run_session([], count=3, timeout=.3, fit=False)
        self.assertFalse(events[-1][1]['accepted'])

    def test_continuous_manual_stop_keeps_captures(self):
        events = self.run_session([packet(), packet(), packet()], count=None, stop_after=2)
        self.assertEqual(events[-1][1]['reason'], 'stopped')
        self.assertEqual(events[-1][1]['total'], 2)

    def test_beta_method_filter_and_failed_request(self):
        events = self.run_session([packet(method='OPTIONS'), packet(method='POST', failed=True)], method='POST', beta=True)
        captured = events[1][1]
        self.assertEqual(captured['method'], 'POST')
        self.assertTrue(captured['failed'])
        self.assertIsNone(captured['status'])
        self.assertIn('ERR_FAILED', captured['error'])

    def test_listener_cleanup_on_disconnect(self):
        now = [0.0]
        listener = FakeListener([], now)
        def disconnected(**kwargs):
            raise RuntimeError('标签页已断开')
        listener.wait = disconnected
        with self.assertRaisesRegex(RuntimeError, '断开'):
            listen(SimpleNamespace(listen=listener), {'targets':['api/user'],'count':1,'timeout':None,'fitCount':True,'method':'ALL'}, threading.Event(), lambda *args: None)
        self.assertTrue(listener.stopped)



class ResponseTests(unittest.TestCase):
    def content(self, body, content_type='application/json', raw_body=None):
        response = SimpleNamespace(body=body, raw_body=raw_body, headers={'Content-Type': content_type})
        return response_content(SimpleNamespace(is_failed=False, response=response))

    def test_json_chinese_and_large_integer_are_valid_json(self):
        value = {'name': '中文', 'id': 9007199254740993, 'ok': True, 'empty': None}
        result = self.content(value)
        self.assertEqual(__import__('json').loads(result['responseText']), value)
        self.assertIn('中文', result['responseText'])
        self.assertTrue(result['responseType'].startswith('JSON'))

    def test_raw_json_escapes_null_and_empty_response(self):
        result = self.content({'name': '中文'}, raw_body=r'{"name":"\u4e2d\u6587"}')
        self.assertIn('中文', result['responseText'])
        self.assertEqual(self.content(None, raw_body='null')['responseText'], 'null')
        self.assertEqual(self.content(None, raw_body='')['responseText'], '')

    def test_utf8_and_declared_charset_bytes(self):
        for encoding in ('utf-8', 'gb18030'):
            result = self.content('中文内容'.encode(encoding), 'text/plain; charset=' + encoding)
            self.assertEqual(result['responseText'], '中文内容')
        result = self.content(b'{"ok":true}')
        self.assertEqual(__import__('json').loads(result['responseText']), {'ok': True})

    def test_binary_and_bad_encoding_do_not_produce_fake_text(self):
        binary = self.content(b'\x89PNG\x00', 'image/png')
        self.assertIsNone(binary['responseText'])
        self.assertIn('二进制', binary['responseType'])
        invalid = self.content(b'\xff', 'text/plain; charset=utf-8')
        self.assertIsNone(invalid['responseText'])
        self.assertIn('无法读取', invalid['responseError'])

    def test_failed_request_needs_no_response(self):
        result = response_content(SimpleNamespace(is_failed=True))
        self.assertIsNone(result['responseText'])
        self.assertEqual(result['responseType'], '无响应')

    def test_body_read_error_does_not_discard_packet(self):
        class BrokenResponse:
            headers = {'content-type': 'application/json'}
            @property
            def body(self):
                raise ValueError('response unavailable')
        result = response_content(SimpleNamespace(is_failed=False, response=BrokenResponse()))
        self.assertIsNone(result['responseText'])
        self.assertIn('response unavailable', result['responseError'])

if __name__ == '__main__':
    unittest.main()
