"""Explicit local-browser integration checks; launches and closes its own Chrome."""
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from DrissionPage import Chromium, ChromiumOptions


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        page = self.path.split('?', 1)[0] == '/'
        if page:
            script = "<script>fetch('/api/user?after_reload=1')</script>" if 'reload_test=1' in self.path else ''
            body = ('<html><body>ElemLens listener test</body>' + script + '</html>').encode()
        elif 'charset=gb18030' in self.path:
            body = '中文响应'.encode('gb18030')
        elif 'binary=1' in self.path:
            body = b'\x89PNG\x00'
        else:
            body = json.dumps({'ok': True, 'name': '中文', 'id': 9007199254740993}).encode()
        self.send_response(503 if 'error' in self.path else 200)
        content_type = 'text/html' if page else ('text/plain; charset=gb18030' if 'charset=gb18030' in self.path else 'image/png' if 'binary=1' in self.path else 'application/json')
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.do_GET()

    def log_message(self, *args):
        pass


@unittest.skipUnless(os.environ.get('ELEMLENS_BROWSER_TEST') == '1', '显式设置 ELEMLENS_BROWSER_TEST=1 执行独立 Chrome 验证')
class BrowserIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.profile = tempfile.TemporaryDirectory(prefix='elemlens-listener-test-')
        cls.chrome = subprocess.Popen([r'C:\Program Files\Google\Chrome\Application\chrome.exe',
            '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + cls.profile.name,
            '--no-first-run', '--no-default-browser-check', 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        port_file = Path(cls.profile.name) / 'DevToolsActivePort'
        for _ in range(100):
            if port_file.exists():
                break
            time.sleep(.1)
        cls.endpoint = '127.0.0.1:' + port_file.read_text().splitlines()[0]
        cls.browser = Chromium(ChromiumOptions(read_file=False).set_address(cls.endpoint).existing_only().headless())
        cls.tab = cls.browser.latest_tab
        cls.tab.get('http://127.0.0.1:' + str(cls.server.server_port))

    @classmethod
    def tearDownClass(cls):
        cls.browser.quit()
        cls.chrome.wait(timeout=10)
        cls.server.shutdown()
        cls.server.server_close()
        cls.profile.cleanup()

    def start_worker(self, **overrides):
        options = {'targets':['api/user','api/order'], 'count':1, 'timeout':5, 'fitCount':True, 'method':'ALL'}
        options.update(overrides)
        worker = subprocess.Popen([sys.executable, '-u', '-X', 'utf8', str(Path(__file__).with_name('network_listener.py'))], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        self.addCleanup(self.cleanup_worker, worker)
        worker.stdin.write(json.dumps({'endpoint':self.endpoint,'targetId':self.tab.tab_id,'options':options}) + '\n')
        worker.stdin.flush()
        events = queue.Queue()
        def read_events():
            for line in worker.stdout:
                events.put(json.loads(line))
        threading.Thread(target=read_events, daemon=True).start()
        ready = events.get(timeout=15)
        self.assertEqual(ready['kind'], 'ready', ready)
        return worker, events

    @staticmethod
    def cleanup_worker(worker):
        if worker.poll() is None:
            worker.kill()
        worker.wait(timeout=5)
        for stream in (worker.stdin, worker.stdout, worker.stderr):
            stream.close()

    def finished(self, worker, events):
        received = []
        while True:
            event = events.get(timeout=10)
            received.append(event)
            if event['kind'] in ('finished', 'error'):
                break
        worker.wait(timeout=5)
        self.assertEqual(worker.returncode, 0)
        self.assertEqual(received[-1]['kind'], 'finished', received)
        return received

    def test_single_capture_from_multiple_keywords_and_http_error(self):
        worker, events = self.start_worker()
        self.tab.run_js("fetch('/api/user?error=1')")
        received = self.finished(worker, events)
        self.assertEqual(received[0]['data']['status'], 503)
        self.assertEqual(received[0]['data']['targets'], ['api/user'])
        body = received[0]['data']['responseText']
        self.assertEqual(json.loads(body), {'ok': True, 'name': '中文', 'id': 9007199254740993})
        self.assertIn('中文', body)
        self.assertIn('application/json', received[0]['data']['responseType'])
        self.assertTrue(received[-1]['data']['accepted'])

    def test_response_text_charset_and_binary(self):
        for suffix, expected in [('charset=gb18030', '中文响应'), ('binary=1', None)]:
            with self.subTest(suffix=suffix):
                worker, events = self.start_worker()
                self.tab.run_js("fetch('/api/user?" + suffix + "')")
                received = self.finished(worker, events)
                self.assertEqual(received[0]['data']['responseText'], expected)
                if expected is None:
                    self.assertIn('二进制', received[0]['data']['responseType'])

    def test_same_keyword_can_satisfy_count(self):
        worker, events = self.start_worker(count=2)
        self.tab.run_js("fetch('/api/user?i=1'); fetch('/api/user?i=2')")
        received = self.finished(worker, events)
        self.assertEqual(received[-1]['data']['total'], 2)
        self.assertTrue(received[-1]['data']['metCount'])

    def test_strict_and_partial_timeout(self):
        for fit in (True, False):
            with self.subTest(fit=fit):
                worker, events = self.start_worker(count=3, timeout=1, fitCount=fit)
                self.tab.run_js("fetch('/api/user?partial=1')")
                received = self.finished(worker, events)
                self.assertEqual(received[-1]['data']['total'], 1)
                self.assertEqual(received[-1]['data']['reason'], 'timeout')
                self.assertEqual(received[-1]['data']['accepted'], not fit)

    def test_continuous_method_filter_and_manual_stop(self):
        worker, events = self.start_worker(count=None, timeout=None, method='POST')
        self.tab.run_js("fetch('/api/user?ignored=1'); fetch('/api/order', {method:'POST'})")
        captured = events.get(timeout=10)
        self.assertEqual(captured['kind'], 'packet', captured)
        self.assertEqual(captured['data']['method'], 'POST')
        worker.stdin.write('stop\n')
        worker.stdin.flush()
        received = self.finished(worker, events)
        self.assertEqual(received[-1]['data']['reason'], 'stopped')
        self.assertEqual(received[-1]['data']['total'], 1)

    def test_reload_keeps_listener_and_closed_tab_exits(self):
        self.tab.get('http://127.0.0.1:' + str(self.server.server_port) + '/?reload_test=1')
        worker, events = self.start_worker()
        self.tab.refresh()
        received = self.finished(worker, events)
        self.assertEqual(received[-1]['data']['total'], 1)
        other = self.browser.new_tab('http://127.0.0.1:' + str(self.server.server_port))
        original = self.tab
        self.__class__.tab = other
        try:
            worker, events = self.start_worker(timeout=None)
            other.close()
            event = events.get(timeout=10)
            self.assertEqual(event['kind'], 'error', event)
        finally:
            self.__class__.tab = original


if __name__ == '__main__':
    unittest.main()
