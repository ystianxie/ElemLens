"""One request per process; stdout is a single UTF-8 JSON response."""
import contextlib
import importlib.metadata
import json
import sys
import traceback
from urllib.request import ProxyHandler, build_opener



def find_elements(context, mode, expression):
    if mode not in ('CSS', 'XPath', 'DP') or not expression.strip():
        raise ValueError('请填写有效的定位表达式和模式')
    locator = expression if mode == 'DP' else mode.lower() + ':' + expression
    matches = context.eles(locator, timeout=0)
    if not isinstance(matches, (list, tuple)):
        raise ValueError('该表达式返回标量而非元素，无法高亮')
    return matches


def check_descendant(element, parent_token):
    if not hasattr(element, 'run_js'):
        raise ValueError('该表达式包含非元素结果，无法高亮')
    if parent_token and not element.run_js(
            'return window.__elemlens_v1.isWithin(this, ' + json.dumps(parent_token) + ');'):
        raise ValueError('表达式超出当前父级范围，或跨越了 iframe / Shadow Root 上下文；请使用内部后代的相对定位')


def register_element(element, parent_token=None):
    return element.run_js('const info=window.__elemlens_v1.register(this, ' + json.dumps(parent_token) +
                          "); if (this.type === 'password') delete info.attributes.value; return info;")


def dispatch(request):
    from DrissionPage import Chromium, ChromiumOptions
    version = importlib.metadata.version('DrissionPage')
    if request['action'] == 'check':
        return {'version': version, 'python': sys.executable}
    options = ChromiumOptions(read_file=False).set_address(request['endpoint'].removeprefix('http://')).existing_only()
    # Match the existing browser mode: DP otherwise restarts a headless browser.
    opener = build_opener(ProxyHandler({}))
    with opener.open(request['endpoint'].rstrip('/') + '/json/version', timeout=5) as response:
        browser_info = json.load(response)
    options.headless('headless' in browser_info.get('User-Agent', '').lower())
    # Never launch, navigate or close a user's browser from this adapter.
    browser = Chromium(options)
    tab = browser.get_tab(request['targetId'])
    if not tab or tab.tab_id != request['targetId']:
        raise ValueError('所选标签页已关闭，请重新选择')
    rebind = request['action'] == 'recording_query'
    root_token = tab.run_js('return window.__elemlens_v1?.documentToken;')
    scope_target = request['context'].get('targetId', request['targetId'])
    context = tab if scope_target == request['targetId'] else browser.get_tab(scope_target)
    if not context or context.tab_id != scope_target:
        raise ValueError('定位上下文所属文档已关闭，请重新捕获')
    for index, step in enumerate(request['context']['steps'], 1):
        node = context.ele('css:' + step['selector'], timeout=0)
        if not node:
            raise ValueError(f'第 {index} 层上下文宿主未找到：{step["selector"]}，请重新捕获')
        if step['kind'] == 'shadow':
            context = node.shadow_root
            if not context:
                raise ValueError(f'第 {index} 层 Shadow Root 不可访问：{step["selector"]}')
        else:
            context = node
    token = context.run_js('return window.__elemlens_v1?.documentToken;')
    if not token or (not rebind and token != request['context']['documentToken']):
        raise ValueError('页面已刷新或定位上下文发生变化，请重新捕获')
    # Keep the document/ShadowRoot separate from the ordinary element chain.
    document_context = context
    parents = []
    parent_token = None
    for index, parent in enumerate(request['context'].get('parents', []), 1):
        matches = find_elements(context, parent['mode'], parent['expression'])
        if len(matches) != 1:
            raise ValueError(f'第 {index} 层父级匹配到 {len(matches)} 个元素，必须唯一；请返回该层重新校验')
        context = matches[0]
        check_descendant(context, parent_token)
        info = register_element(context)
        parent_token = info['token']
        parents.append({**parent, 'token': parent_token})
    output = []
    matches = []
    if request['action'] != 'resolve_scope':
        matches = find_elements(context, request['mode'], request['expression'])
        for index, element in enumerate(matches):
            check_descendant(element, parent_token)
            if index < 200:
                output.append(register_element(element, parent_token))
    if document_context.run_js('return window.__elemlens_v1?.documentToken;') != token or (
            rebind and tab.run_js('return window.__elemlens_v1?.documentToken;') != root_token):
        raise ValueError('校验期间页面已变化，请重试')
    result_context = {**request['context'], 'documentToken': token}
    if parents:
        result_context['parents'] = parents
    return {'matches': output, 'total': len(matches), 'truncated': len(matches) > 200,
            'engine': 'DrissionPage ' + version, 'context': result_context, 'pageUrl': tab.url}


def main():
    try:
        request = json.loads(sys.stdin.readline())
        with contextlib.redirect_stdout(sys.stderr):
            result = dispatch(request)
        response = {'ok': True, 'result': result}
    except Exception as error:
        response = {'ok': False, 'error': str(error) or type(error).__name__}
        traceback.print_exc(file=sys.stderr)
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + '\n')
    sys.stdout.flush()


if __name__ == '__main__':
    main()
