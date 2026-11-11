import {useEffect, useRef, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {open, save} from '@tauri-apps/plugin-dialog';
import {hideCaptureWindow, previewWithHiddenWindow, type RestoreCaptureWindow} from './capture-window';
import {appendDesktopHistory, buildDesktopLocator, desktopCode, desktopFailure, draftFromCapture, draftFromLocator, highlightReason,
    type DesktopBackend, type DesktopCapture, type DesktopDraft, type DesktopElement, type DesktopFailure, type DesktopHistory, type DesktopLocator, type DesktopResult} from './desktop-model';
let generationClock = Date.now();
let recordClock = 0;
type NativeEvent = {kind: 'capture' | 'cancel'; session: string; sequence: number; x: number; y: number};
export function useDesktop({active, python, available, hideWindow}: {active: boolean; python: string; available: boolean; hideWindow: boolean}) {
    const [backend, setBackend] = useState<DesktopBackend>('uia');
    const [ready, setReady] = useState(false), [status, setStatus] = useState('尚未检测桌面环境');
    const [busy, setBusy] = useState(''), [error, setError] = useState<DesktopFailure | null>(null);
    const [windows, setWindows] = useState<DesktopElement[]>([]), [root, setRoot] = useState<string | null>(null);
    const [children, setChildren] = useState<Record<string, DesktopElement[]>>({}), [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [selected, setSelected] = useState<DesktopElement | null>(null), [draft, setDraft] = useState<DesktopDraft | null>(null);
    const [result, setResult] = useState<DesktopResult | null>(null), [capturing, setCapturing] = useState(false);
    const [history, setHistory] = useState<DesktopHistory[]>([]), [historyId, setHistoryId] = useState<number | null>(null);
    const [warning, setWarning] = useState(''), [notice, setNotice] = useState(''), [copied, setCopied] = useState(false);
    const generation = useRef(0), revision = useRef(0), captureSession = useRef<string | null>(null);
    const busyRef = useRef(false), historyIdRef = useRef<number | null>(null), pendingHistory = useRef<DesktopHistory | null>(null);
    const mounted = useRef(true), activeRef = useRef(active); activeRef.current = active;
    const pendingImport = useRef<DesktopLocator | null>(null), environment = useRef('');
    const [ancestry, setAncestry] = useState<DesktopElement[]>([]);
    const readingCapture = useRef(false);
    const captureWindowRestore = useRef<RestoreCaptureWindow | null>(null);
    async function restoreCaptureWindow(restore = captureWindowRestore.current) {
        if (restore !== captureWindowRestore.current) return;
        captureWindowRestore.current = null;
        if (restore) {
            try { await restore(); }
            catch (e) { if (mounted.current) setError(desktopFailure(e)); }
        }
    }
    const nativeHandler = useRef<(event: NativeEvent) => void>(() => {});
    const built = draft ? buildDesktopLocator(draft, backend) : {locator: null, error: ''};
    const code = built.locator ? desktopCode(built.locator) : '';

    async function request<T>(request: Record<string, unknown>, g = generation.current): Promise<T> {
        return invoke<T>('desktop_request', {python, backend, generation: g, request});
    }
    function current(g: number) { return mounted.current && generation.current === g; }
    async function run(label: string, task: (g: number) => Promise<void>) {
        if (busyRef.current) return;
        const g = generation.current; busyRef.current = true; setBusy(label); setError(null); setNotice('');
        try { await task(g); }
        catch (e) { if (current(g)) setError(desktopFailure(e)); }
        finally { if (current(g) && !readingCapture.current) { busyRef.current = false; setBusy(''); } }
    }
    function invalidate() { revision.current++; setResult(null); setCopied(false); setError(null); setNotice('未校验'); }
    function updateDraft(next: DesktopDraft) {
        invalidate(); setDraft(next);
        const id = historyIdRef.current;
        if (id !== null) setHistory(records => records.map(record => record.id === id ? {...record, draft: next} : record));
    }
    async function clearNative(g = generation.current, retire = false) {
        const restore = captureWindowRestore.current;
        captureSession.current = null; setCapturing(false);
        try {
            if (available) await invoke('desktop_capture', {active: false, generation: g, session: '', retire}).catch(() => {});
        } finally { await restoreCaptureWindow(restore); }
    }
    function restore(record: DesktopHistory) {
        invalidate(); historyIdRef.current = record.id; setHistoryId(record.id);
        setDraft(record.draft); setSelected(record.capture.element); setWarning(record.capture.warning);
        setNotice('历史属性快照；校验将根据当前条件重新查找');
    }
    async function connect(g: number) {
        busyRef.current = true; setBusy('检测桌面环境'); setReady(false); setError(null); setNotice(''); setStatus('正在检测桌面环境');
        try {
            const info = await request<{version: string}>({action: 'check'}, g);
            if (!current(g)) return;
            const items = await request<DesktopElement[]>({action: 'windows'}, g);
            if (!current(g)) return;
            setWindows(items); setReady(true); setStatus('desktop-automation-runtime ' + info.version);
            if (pendingHistory.current) { restore(pendingHistory.current); pendingHistory.current = null; }
            if (pendingImport.current) { setDraft(draftFromLocator(pendingImport.current)); pendingImport.current = null; setNotice('已导入 · 未校验'); }
        } catch (e) { if (current(g)) { const failure = desktopFailure(e); setError(failure); setStatus(failure.message); } }
        finally { if (current(g)) { busyRef.current = false; setBusy(''); } }
    }
    function check() {
        const old = generation.current; void clearNative(old, true);
        generation.current = ++generationClock; revision.current++;
        setWindows([]); setChildren({}); setExpanded(new Set()); setRoot(null); setAncestry([]); setResult(null);
        return connect(generation.current);
    }
    useEffect(() => {
        const old = generation.current; void clearNative(old);
        revision.current++; setResult(null);
        if (!active) { generation.current = ++generationClock; busyRef.current = false; setBusy(''); return; }
        const key = python + ':' + backend;
        if (environment.current && environment.current !== key) {
            setDraft(null); setSelected(null); setWarning(''); historyIdRef.current = null; setHistoryId(null);
        }
        environment.current = key;
        const g = ++generationClock; generation.current = g;
        busyRef.current = false; readingCapture.current = false; setBusy(''); setReady(false);
        setWindows([]); setChildren({}); setExpanded(new Set()); setRoot(null); setAncestry([]); setError(null);
        if (!available || !python.trim()) { setStatus('请在设置中选择桌面 Python 环境'); return; }
        const timer = window.setTimeout(() => void connect(g), 400);
        return () => { window.clearTimeout(timer); void clearNative(g, true); };
    }, [active, python, backend, available]);
    useEffect(() => {
        mounted.current = true;
        if (!available) return;
        const removeNative = listen<NativeEvent>('desktop-native', event => nativeHandler.current(event.payload));
        const removeStopped = listen<number>('desktop-worker-stopped', event => {
            if (event.payload !== generation.current) return;
            invalidate(); setReady(false); setStatus('工作进程已退出，请重新检测'); setNotice('工作进程已退出，捕获已取消；请重新检测环境'); void clearNative();
        });
        return () => { mounted.current = false; void clearNative(); void removeNative.then(fn => fn()); void removeStopped.then(fn => fn()); };
    }, [available]);

    async function highlight(element: DesktopElement, session: string | null = null, sequence = 0, g = generation.current, duration = session ? 600 : 2000) {
        const reason = highlightReason(element);
        if (reason) { if (!session) setNotice(reason); return; }
        await invoke('desktop_highlight', {generation: g, rectangle: element.rectangle, session, sequence, duration});
    }
    function acceptCapture(capture: DesktopCapture) {
        const next = draftFromCapture(capture, backend); const id = ++recordClock;
        invalidate(); setSelected(capture.element); setDraft(next); setWarning(capture.warning);
        setWindows(items => [capture.window, ...items.filter(item => item.token !== capture.window.token)]);
        setRoot(capture.window.token!); setAncestry(capture.ancestry);
        if (root !== capture.window.token) { setChildren({}); setExpanded(new Set()); }
        setHistory(records => appendDesktopHistory(records, {id, capturedAt: new Date().toLocaleTimeString(), backend, capture, draft: next}));
        historyIdRef.current = id; setHistoryId(id); setNotice('已捕获 · 未校验');
    }
    async function displayCapture(capture: DesktopCapture, g: number, session: string | null = null, sequence = 0) {
        acceptCapture(capture);
        await highlight(capture.element, session, sequence, g, 2000);
        if (session) await restoreCaptureWindow();
        // An incomplete provider hierarchy is diagnostic data only. Expanding
        // it automatically can repeat the same error after a successful capture.
        if (!capture.locator) return;
        // Read only the selected ancestry. Keep siblings visible and reveal the
        // captured leaf without recursively scanning the rest of the application.
        const parents = capture.ancestry.length > 1 ? capture.ancestry.slice(0, -1) : [capture.window];
        for (const parent of parents) {
            if (!current(g) || !activeRef.current) return;
            const token = parent.token!;
            const items = await request<DesktopElement[]>({action: 'children', token}, g);
            if (!current(g) || !activeRef.current) return;
            setChildren(previous => ({...previous, [token]: items}));
            setExpanded(previous => new Set(previous).add(token));
        }
    }
    nativeHandler.current = event => {
        if (!activeRef.current || event.session !== captureSession.current) return;
        const g = generation.current;
        if (event.kind === 'cancel') { void clearNative(g); setNotice('捕获已取消'); return; }
        readingCapture.current = true; setCapturing(false); setBusy('读取捕获元素'); busyRef.current = true;
        void request<DesktopCapture | null>({action: 'point', x: event.x, y: event.y, capture: true}, g).then(async capture => {
            if (!current(g) || captureSession.current !== event.session || !activeRef.current) return;
            if (!capture) { setNotice('觅元自身窗口不作为捕获目标'); return; }
            await displayCapture(capture, g, event.session, event.sequence);
        }).catch(e => { if (current(g)) setError(desktopFailure(e)); }).finally(async () => {
            if (captureSession.current === event.session) await restoreCaptureWindow();
            if (current(g)) { readingCapture.current = false; captureSession.current = null; busyRef.current = false; setBusy(''); }
        });
    };
    function startCapture() { return run('开始捕获', async g => {
        invalidate(); const session = g + '-' + (++recordClock); captureSession.current = session;
        setCapturing(true); setNotice('鼠标悬停显示控件红框，Ctrl＋左键锁定，Esc 取消');
        try {
            captureWindowRestore.current = await hideCaptureWindow(hideWindow);
            await invoke('desktop_capture', {active: true, generation: g, session});
        }
        catch (e) { captureSession.current = null; setCapturing(false); await restoreCaptureWindow(); throw e; }
    }); }
    function refresh() { return run('刷新窗口', async g => {
        const items = await request<DesktopElement[]>({action: 'windows'}, g);
        if (!current(g)) return;
        setWindows(items); setRoot(null); setChildren({}); setExpanded(new Set()); setAncestry([]); invalidate();
    }); }
    function selectWindow(item: DesktopElement) {
        setRoot(item.token!); setChildren({}); setExpanded(new Set());
        return inspect(item);
    }
    function inspect(item: DesktopElement) { return run('读取元素', async g => {
        const capture = await request<DesktopCapture>({action: 'inspect', token: item.token}, g);
        if (current(g)) await displayCapture(capture, g);
    }); }
    function expand(item: DesktopElement) {
        const token = item.token!;
        if (expanded.has(token)) { setExpanded(previous => { const next = new Set(previous); next.delete(token); return next; }); return; }
        return run('读取子控件', async g => {
            const items = await request<DesktopElement[]>({action: 'children', token}, g);
            if (!current(g)) return;
            setChildren(previous => ({...previous, [token]: items})); setExpanded(previous => new Set(previous).add(token));
        });
    }
    function validate() { return run('校验定位条件', async g => {
        if (!built.locator) return;
        return previewWithHiddenWindow(hideWindow, async () => {
            const edit = revision.current; setResult(null);
            const actual = await request<DesktopResult>({action: 'query', locator: built.locator}, g);
            if (!current(g) || edit !== revision.current || !activeRef.current) return;
            setResult(actual);
            if (actual.total === 1) { setSelected(actual.matches[0]); await highlight(actual.matches[0], null, 0, g, 5000); }
            if (!current(g) || edit !== revision.current || !activeRef.current) return;
            setNotice(actual.total === 0 ? '未匹配' : actual.total === 1 ? (highlightReason(actual.matches[0]) || '唯一匹配，请核对高亮和实际属性') : '多个匹配，请补充条件或选择结果查看');
        });
    }); }
    function selectResult(item: DesktopElement) { return run('高亮匹配元素', async g => {
        setSelected(item);
        await previewWithHiddenWindow(hideWindow, () => highlight(item, null, 0, g, 5000));
    }); }
    function restoreHistory(record: DesktopHistory) {
        if (record.backend !== backend) { pendingHistory.current = record; setBackend(record.backend); }
        else restore(record);
    }
    function importFile() { return run('导入元素文件', async g => {
        const file = await open({multiple: false, filters: [{name: '元素定位文件', extensions: ['json']}]});
        if (typeof file !== 'string' || !current(g)) return;
        const locator = await request<DesktopLocator>({action: 'load', path: file}, g);
        if (!current(g)) return;
        const next = draftFromLocator(locator); invalidate(); historyIdRef.current = null; setHistoryId(null); setSelected(null); setWarning('');
        if (locator.backend !== backend) {
            pendingImport.current = locator;
            setBackend(locator.backend);
        } else setDraft(next);
        setNotice('已导入 · 未校验');
    }); }
    function exportFile() { return run('导出元素文件', async g => {
        if (!built.locator) return;
        const file = await save({defaultPath: (draft?.name.replace(/[<>:"/\\|?*]/g, '_') || '桌面元素') + '.json', filters: [{name: '元素定位文件', extensions: ['json']}]});
        if (!file || !current(g)) return;
        await request({action: 'save', path: file, locator: built.locator}, g);
        if (current(g)) setNotice('元素文件已导出：' + file);
    }); }
    function copyCode() { return run('复制定位代码', async () => {
        if (!code) return;
        try { await navigator.clipboard.writeText(code); }
        catch {
            const area = document.createElement('textarea'); area.value = code; document.body.appendChild(area); area.select();
            try { if (!document.execCommand('copy')) throw new Error('复制失败，请从代码预览手动复制'); }
            finally { area.remove(); }
        }
        setCopied(true);
    }); }
    return {backend, setBackend, ready, status, busy, error, setError, windows, root, children, expanded, selected, draft, result, capturing, history, historyId,
        warning, notice, copied, ancestry, locator: built.locator, draftError: built.error, code, updateDraft, check, refresh, selectWindow, inspect, expand, validate,
        startCapture, cancelCapture: async () => { await clearNative(); setNotice('捕获已取消'); }, selectResult, restoreHistory, importFile, exportFile, copyCode};
}
export type DesktopController = ReturnType<typeof useDesktop>;
