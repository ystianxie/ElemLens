"""A long-lived DrissionPage listener; stdin controls stop, stdout streams JSON."""
import contextlib
import json
import inspect
import os
import sys
import threading
import time
import traceback
from email.message import Message
from urllib.request import urlopen
from datetime import datetime, timezone

OUTPUT = sys.stdout


def emit(kind, data):
    OUTPUT.write(json.dumps({'kind': kind, 'data': data}, ensure_ascii=False) + '\n')
    OUTPUT.flush()


def response_content(packet):
    """DP already handles HTTP decompression/base64; normalize its body for copying."""
    result = {'responseType': '无响应' if packet.is_failed else '未知',
              'responseText': None, 'responseError': ''}
    if packet.is_failed:
        result['responseError'] = '请求失败，未获取到 Response'
        return result
    try:
        response = packet.response
        headers = response.headers or {}
        content_type = next((str(v) for k, v in headers.items() if k.lower() == 'content-type'), '')
        mime = content_type.split(';', 1)[0].strip().lower()
        result['responseType'] = content_type or '未提供 Content-Type'
        body = response.body
        if isinstance(body, bytes):
            textual = (not mime or mime.startswith('text/') or 'json' in mime or 'xml' in mime
                       or mime in ('application/javascript', 'application/x-javascript', 'application/x-www-form-urlencoded'))
            if not textual:
                result['responseType'] = '二进制 · ' + result['responseType']
                result['responseError'] = '二进制响应，无法作为文本复制'
                return result
            header = Message()
            header['content-type'] = content_type
            body = body.decode(header.get_content_charset() or 'utf-8-sig')
        elif isinstance(getattr(response, 'raw_body', None), str):
            # Keep JSON null/scalars and raw text instead of DP's optional SSE conversion.
            body = response.raw_body
        if body is None:
            body = ''
        if isinstance(body, str):
            try:
                value = json.loads(body)
            except (ValueError, TypeError):
                text, kind = body, '文本' if body else '空响应'
            else:
                text, kind = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), 'JSON'
        else:
            text, kind = json.dumps(body, ensure_ascii=False, indent=2, allow_nan=False), 'JSON'
        result.update(responseType=kind + ' · ' + result['responseType'], responseText=text)
    except Exception as error:
        result['responseError'] = '无法读取 Response 文本：' + str(error)
    return result


def listen(tab, options, stopped, send=emit, clock=time.monotonic):
    targets = options['targets']
    count = options.get('count')
    timeout = options.get('timeout')
    fit_count = options.get('fitCount', True)
    total = 0
    listener = tab.listen
    try:
        if 'targets' in inspect.signature(listener.start).parameters:
            listener.start(targets=targets, method=True if options['method'] == 'ALL' else options['method'])
        else:
            # The configured DrissionPage 5 beta names this argument urls and
            # omits the method filter; filter returned packets below instead.
            listener.start(urls=targets)
        started = clock()
        deadline = None if timeout is None else started + timeout
        send('ready', {})
        while True:
            if stopped.is_set():
                reason = 'stopped'
                break
            remaining = None if deadline is None else deadline - clock()
            if remaining is not None and remaining <= 0:
                reason = 'timeout'
                break
            # Short waits keep manual stop responsive. Aggregate count/fit_count at
            # the session level so partial captures remain visible even on failure.
            packet = listener.wait(count=1, timeout=min(.15, remaining) if remaining is not None else .15,
                                   fit_count=True, raise_err=False)
            if not packet:
                continue
            if options['method'] != 'ALL' and packet.method != options['method']:
                continue
            total += 1
            failed = bool(packet.is_failed)
            send('packet', {
                'index': total,
                'capturedAt': int(datetime.now(timezone.utc).timestamp() * 1000),
                'targets': [target for target in targets if target in packet.url],
                'url': packet.url,
                'method': packet.method,
                'status': None if failed else packet.response.status,
                'failed': failed,
                'error': str(getattr(packet.fail_info, 'errorText', '连接失败')) if failed else '',
                **response_content(packet),
            })
            if count is not None and total >= count:
                reason = 'complete'
                break
        matched_count = count is not None and total >= count
        accepted = matched_count or (reason == 'timeout' and not fit_count and total > 0)
        result = {'reason': reason, 'total': total, 'accepted': accepted,
                  'metCount': matched_count, 'elapsed': round(clock() - started, 2)}
    finally:
        listener.stop()
    send('finished', result)


def main():
    try:
        initial = bytearray()
        while not initial.endswith(b'\n'):
            part = os.read(sys.stdin.fileno(), 1)
            if not part:
                raise ValueError('监听启动参数缺失')
            initial.extend(part)
        request = json.loads(initial)
        stopped = threading.Event()

        def control():
            pending = b''
            while True:
                part = os.read(sys.stdin.fileno(), 1024)
                if not part:
                    stopped.set()
                    return
                pending += part
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    if line.strip() == b'stop':
                        stopped.set()
                        return

        threading.Thread(target=control, daemon=True).start()
        with contextlib.redirect_stdout(sys.stderr):
            from DrissionPage import Chromium, ChromiumOptions
            endpoint = request['endpoint'].removeprefix('http://')
            with urlopen('http://' + endpoint + '/json/version', timeout=5) as response:
                info = json.load(response)
            # Match the existing browser mode: DP may otherwise restart a
            # headless browser even when existing_only is set.
            options = (ChromiumOptions(read_file=False).set_address(endpoint).existing_only()
                       .headless('HeadlessChrome' in info.get('User-Agent', '')))
            browser = Chromium(options)
            tab = browser.get_tab(request['targetId'])
            if not tab or tab.tab_id != request['targetId']:
                raise ValueError('所选标签页已关闭，请重新选择')
            listen(tab, request['options'], stopped)
    except Exception as error:
        emit('error', {'message': str(error) or type(error).__name__})
        traceback.print_exc(file=sys.stderr)


if __name__ == '__main__':
    main()
