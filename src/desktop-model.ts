export type DesktopBackend = 'uia' | 'win32';
export type Criteria = Record<string, string | number>;
export type DesktopLocator = {version: 1; name: string; backend: DesktopBackend; window: Criteria; path: Criteria[]; metadata: Record<string, unknown>};
export type Rectangle = {left: number; top: number; right: number; bottom: number};
export type DesktopElement = {token?: string; title: string; text: string; class_name: string; auto_id: string; control_type: string; control_id: number | null; process: number; process_name?: string; handle: number; visible: boolean; enabled: boolean; checked: boolean | null; rectangle: Rectangle};
export type DesktopCapture = {element: DesktopElement; window: DesktopElement; ancestry: DesktopElement[]; locator: DesktopLocator | null; warning: string};
export type ConditionRow = {field: string; value: string; checked: boolean};
export type DesktopDraft = {name: string; window: ConditionRow[]; path: ConditionRow[][]; metadata: Record<string, unknown>};
export type DesktopResult = {total: number; matches: DesktopElement[]; truncated: boolean};
export type DesktopHistory = {id: number; capturedAt: string; backend: DesktopBackend; capture: DesktopCapture; draft: DesktopDraft};
export type DesktopFailure = {kind: string; message: string};

export function desktopFailure(error: unknown): DesktopFailure {
    if (error && typeof error === 'object' && 'message' in error) return {kind: String('kind' in error ? error.kind : 'ProviderError'), message: String(error.message)};
    return {kind: 'ProviderError', message: String(error)};
}
export function conditionRows(condition: Criteria, backend: DesktopBackend, window = false): ConditionRow[] {
    const fields = window ? ['process_name', 'title', 'class_name'] : backend === 'uia' ? ['auto_id', 'control_type', 'title', 'class_name'] : ['control_id', 'title', 'class_name'];
    if ('title_re' in condition) fields[fields.indexOf('title')] = 'title_re';
    for (const key of Object.keys(condition)) if (!fields.includes(key)) fields.push(key);
    return fields.map(field => ({field, value: String(condition[field] ?? ''), checked: field in condition}));
}
export function draftFromLocator(locator: DesktopLocator): DesktopDraft {
    return {name: locator.name, window: conditionRows(locator.window, locator.backend, true), path: locator.path.map(item => conditionRows(item, locator.backend)), metadata: locator.metadata};
}
export function draftFromCapture(capture: DesktopCapture, backend: DesktopBackend): DesktopDraft {
    if (capture.locator) return draftFromLocator(capture.locator);
    const root = capture.window;
    const window: Criteria = {};
    if (root.process_name) window.process_name = root.process_name;
    if (root.title) window.title = root.title;
    if (root.class_name) window.class_name = root.class_name;
    return {name: capture.element.title || '未命名元素', window: conditionRows(window, backend, true), metadata: {},
        path: capture.ancestry.slice(1).map(item => conditionRows({}, backend).map(row => ({...row, value: String(item[row.field as keyof DesktopElement] ?? ''), checked: false})))};
}
export function buildDesktopLocator(draft: DesktopDraft, backend: DesktopBackend): {locator: DesktopLocator | null; error: string} {
    function criteria(rows: ConditionRow[], label: string): Criteria {
        const result: Criteria = {};
        for (const row of rows.filter(row => row.checked)) {
            if (!row.value) throw new Error(label + '：' + row.field + ' 不能为空');
            if (row.field in result) throw new Error(label + '：条件重复');
            if (['control_id', 'process', 'handle'].includes(row.field)) {
                if (!/^\d+$/.test(row.value) || !Number.isSafeInteger(Number(row.value))) throw new Error(label + '：' + row.field + ' 必须是非负整数');
                result[row.field] = Number(row.value);
            } else result[row.field] = row.value;
        }
        if (!Object.keys(result).length) throw new Error(label + '：至少勾选一项条件');
        if (backend === 'win32' && ('auto_id' in result || 'control_type' in result)) throw new Error('Win32 不支持 auto_id / control_type');
        return result;
    }
    try { return {locator: {version: 1, name: draft.name, backend, window: criteria(draft.window, '窗口'), path: draft.path.map((rows, index) => criteria(rows, '路径第 ' + (index + 1) + ' 层')), metadata: draft.metadata}, error: ''}; }
    catch (error) { return {locator: null, error: desktopFailure(error).message}; }
}
function pythonValue(value: unknown): string {
    if (value === null) return 'None';
    if (typeof value === 'boolean') return value ? 'True' : 'False';
    if (typeof value === 'string') return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return '[' + value.map(pythonValue).join(', ') + ']';
    return '{' + Object.entries(value as Record<string, unknown>).map(([key, item]) => pythonValue(key) + ': ' + pythonValue(item)).join(', ') + '}';
}
export function desktopCode(locator: DesktopLocator): string {
    return 'from desktop_automation import Desktop, Locator\n\nlocator = Locator.from_dict(' + pythonValue(locator) + ')\n\nwith Desktop(backend=' + pythonValue(locator.backend) + ') as desktop:\n    element = desktop.ele(locator)\n';
}
export function appendDesktopHistory(records: DesktopHistory[], record: DesktopHistory): DesktopHistory[] { return [...records, record].slice(-30); }
export function highlightReason(element: Pick<DesktopElement, 'rectangle' | 'visible'>): string {
    const r = element.rectangle;
    if (!element.visible) return '元素当前隐藏，无法高亮';
    if (!r || r.right <= r.left || r.bottom <= r.top) return '元素没有有效矩形，无法高亮';
    return '';
}
