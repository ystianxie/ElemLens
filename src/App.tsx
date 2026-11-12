import {useCallback, useEffect, useRef, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {launchBrowser} from './browser-launch';
import {FreezeHelp} from './FreezeHelp';
import {listen} from '@tauri-apps/api/event';
import {open} from '@tauri-apps/plugin-dialog';
import {
    ArrowRight,
    Braces,
    Check,
    ChevronDown,
    ChevronRight,
    CircleDot,
    Code2,
    Copy,
    Crosshair,
    ExternalLink,
    Eraser,
    FolderOpen,
    Snowflake,
    Layers,
    Monitor,
    MousePointer2,
    Play,
    Plus,
    RefreshCw,
    Radio,
    Search,
    Settings2,
    Square,
    Unplug,
    X
} from 'lucide-react';
import type {Browser, Capture, Context, ElementInfo, QueryResult, Settings, Tab} from './types';
import {defaultDpConditions, dpCode, type DpCondition, dpQuickLocator, locator} from './codegen';
import {DpLocatorBuilder} from './DpLocatorBuilder';
import {Titlebar} from './Titlebar';
import {DetailsResizer} from './DetailsResizer';
import {ElementGeometryPanel} from './ElementGeometryPanel';
import {NetworkDetails, NetworkPanel} from './NetworkPanel';
import type {NetworkPacket} from './network';
import {CaptureHistory} from './CaptureHistory';
import {useDesktop} from './useDesktop';
import {DesktopSources, DesktopPanel, DesktopDetails} from './DesktopWorkspace';
import {useRecording} from './useRecording';
import {RecordingPanel, RecordingDetails} from './RecordingPanel';
import {appendCapture, isLiveCapture, saveCaptureConditions, type CaptureRecord} from './capture-history';
import {hideCaptureWindow, previewWithHiddenWindow, type RestoreCaptureWindow} from './capture-window';

const desktop = '__TAURI_INTERNALS__' in window;
const emptySettings: Settings = {python: '', browser: '', desktopPython: '', hideCaptureWindow: true};
export default function App() {
    const [browsers, setBrowsers] = useState<Browser[]>([]), [tabs, setTabs] = useState<Tab[]>([]);
    const [address, setAddress] = useState('127.0.0.1:9222'), [browser, setBrowser] = useState<Browser | null>(null), [tab, setTab] = useState<Tab | null>(null);
    const [settings, setSettings] = useState<Settings>(emptySettings), [showSettings, setShowSettings] = useState(false), [pythonStatus, setPythonStatus] = useState('');
    const [pythonReady, setPythonReady] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
    const [capturing, setCapturing] = useState(false), [capture, setCapture] = useState<Capture | null>(null), [result, setResult] = useState<QueryResult | null>(null), [selected, setSelected] = useState<ElementInfo | null>(null);
    const [freezePhase, setFreezePhase] = useState<'idle' | 'armed' | 'frozen'>('idle');
    const [context, setContext] = useState<Context | null>(null), [mode, setMode] = useState('CSS'), [expression, setExpression] = useState(''), [copied, setCopied] = useState('');
    const [browsersExpanded, setBrowsersExpanded] = useState(true);
    const [workMode, setWorkMode] = useState<'elements' | 'network' | 'recording' | 'desktop'>('elements');
    const [networkPacket, setNetworkPacket] = useState<NetworkPacket | null>(null);
    const [captureHistory, setCaptureHistory] = useState<CaptureRecord[]>([]);
    const [activeCaptureRecord, setActiveCaptureRecord] = useState<CaptureRecord | null>(null);
    const nextCaptureId = useRef(0), currentTab = useRef<Tab | null>(null);
    // Queries change the selected preview, but DP edits still belong to this capture.
    const editingCaptureId = useRef<number | null>(null);
    const [dpConditions, setDpConditions] = useState<DpCondition[]>([]);
    const [codeClick, setCodeClick] = useState(true), [codeInput, setCodeInput] = useState(false), [inputText, setInputText] = useState('');
    const captureWindowRestore = useRef<RestoreCaptureWindow | null>(null);
    const restoreCaptureWindow = useCallback(async () => {
        const restore = captureWindowRestore.current;
        captureWindowRestore.current = null;
        if (restore) await restore();
    }, []);
    const reportWindowRestore = () => {
        void restoreCaptureWindow().catch(e => setError(String(e)));
    };
    const recorder = useRecording({
        endpoint: browser?.endpoint ?? '',
        target: tab?.id ?? '',
        title: tab?.title ?? '',
        url: tab?.url ?? ''
    }, () => {
        setCapturing(false);
        reportWindowRestore();
    }, {
        python: settings.python,
        ready: pythonReady,
        capturing: capturing || freezePhase !== 'idle',
        hideCaptureWindow: settings.hideCaptureWindow
    });
    const desk = useDesktop({
        active: workMode === 'desktop',
        python: settings.desktopPython?.trim() || settings.python,
        available: desktop,
        hideWindow: settings.hideCaptureWindow
    });
    const current = useRef({endpoint: '', target: ''}), generation = useRef(0), pythonGeneration = useRef(0),
        working = useRef(false);
    const execute = useCallback(async (label: string, task: () => Promise<void>) => {
        if (working.current) return;
        working.current = true;
        setBusy(label);
        setError('');
        setNotice('');
        try {
            await task();
        } catch (e) {
            setError(String(e));
        } finally {
            working.current = false;
            setBusy('');
        }
    }, []);
    const clearPage = () => {
        reportWindowRestore();
        currentTab.current = null;
        editingCaptureId.current = null;
        setActiveCaptureRecord(null);
        setContext(null);
        setCapture(null);
        setResult(null);
        setSelected(null);
        setCapturing(false);
        setFreezePhase('idle');
    };
    useEffect(() => {
        if (!desktop) return;
        let disposed = false;
        const unlisten = listen<{
            endpoint: string;
            targetId: string;
            kind: string;
            data: unknown
        }>('browser-event', ({payload: event}) => {
            if (disposed || event.endpoint !== current.current.endpoint || event.targetId !== current.current.target) return;
            if (['capture', 'cancel', 'disconnected', 'error'].includes(event.kind)) reportWindowRestore();
            if (event.kind === 'freeze') {
                const phase = event.data as 'idle' | 'armed' | 'frozen';
                setFreezePhase(phase);
                if (phase !== 'armed') reportWindowRestore();
                setNotice(phase === 'frozen' ? '浮窗已冻结，可捕获元素或校验；完成后请解除冻结' : phase === 'armed' ? '展开浮窗，按 Alt + 鼠标左键确认冻结，Esc 取消' : '已解除或取消冻结');
            } else if (event.kind === 'capture') {
                const value = event.data as Capture;
                const rows = defaultDpConditions(value.element);
                const record: CaptureRecord = {
                    id: ++nextCaptureId.current,
                    capturedAt: Date.now(),
                    source: {...current.current, generation: generation.current},
                    pageTitle: currentTab.current?.title ?? '',
                    pageUrl: currentTab.current?.url ?? '',
                    capture: value,
                    dpConditions: rows
                };
                editingCaptureId.current = record.id;
                setCaptureHistory(previous => appendCapture(previous, record));
                setActiveCaptureRecord(record);
                setCapture(value);
                setContext(value.context);
                setSelected(value.element);
                setResult(null);
                setCapturing(false);
                setMode('DP');
                setDpConditions(rows);
                setExpression(dpQuickLocator(rows).expression);
                setCopied('');
                setNotice('已捕获元素，勾选属性即可生成 DP 定位表达式');
            } else if (event.kind === 'cancel') {
                setCapturing(false);
                setNotice('捕获已取消');
            } else if (event.kind === 'invalidated') {
                generation.current++;
                editingCaptureId.current = null;
                setActiveCaptureRecord(null);
                setContext(null);
                setCapture(null);
                setResult(null);
                setSelected(null);
            } else if (event.kind === 'disconnected') {
                generation.current++;
                current.current = {endpoint: '', target: ''};
                clearPage();
                setTab(null);
                setError('浏览器或标签页已断开，请重新选择标签页');
            } else if (event.kind === 'capture-rejected') {
                setNotice(String(event.data));
            } else if (event.kind === 'error') {
                setError(String(event.data));
                setCapturing(false);
            }
        });
        invoke<Settings>('load_settings').then(async value => {
            if (disposed) return;
            setSettings({...emptySettings, ...value});
            if (value.python) {
                const g = ++pythonGeneration.current;
                try {
                    const info = await invoke<{ version: string }>('check_python', {python: value.python});
                    if (!disposed && g === pythonGeneration.current) {
                        setPythonStatus('DrissionPage ' + info.version);
                        setPythonReady(true);
                    }
                } catch (e) {
                    if (!disposed && g === pythonGeneration.current) {
                        setPythonStatus(String(e));
                        setPythonReady(false);
                    }
                }
            }
        }).catch(e => {
            if (!disposed) setError(String(e));
        });
        return () => {
            disposed = true;
            void restoreCaptureWindow().catch(() => {
            });
            void unlisten.then(fn => fn());
        };
    }, []);

    async function connect(address: string) {
        await recorder.finish();
        generation.current++;
        current.current = {endpoint: '', target: ''};
        clearPage();
        setTab(null);
        setTabs([]);
        setBrowser(null);
        await invoke('disconnect');
        const found = await invoke<Browser>('inspect_browser', {address});
        setBrowser(found);
        setAddress(found.endpoint);
        current.current = {endpoint: found.endpoint, target: ''};
        setBrowsers(previous => [...previous.filter(b => b.endpoint !== found.endpoint), found]);
        setTabs(await invoke<Tab[]>('list_tabs', {address: found.endpoint}));
        setBrowsersExpanded(false);
        setNotice('已连接浏览器，请选择一个标签页');
    }

    async function chooseTab(value: Tab) {
        if (!browser) return;
        await recorder.finish();
        generation.current++;
        clearPage();
        setTab(null);
        current.current = {endpoint: browser.endpoint, target: value.id};
        try {
            await invoke('select_tab', {address: browser.endpoint, targetId: value.id});
            currentTab.current = value;
            setTab(value);
            setNotice('标签页已就绪，点击开始捕获');
        } catch (e) {
            current.current.target = '';
            throw e;
        }
    }

    async function checkPython() {
        const g = ++pythonGeneration.current;
        setPythonReady(false);
        setPythonStatus('正在检测…');
        await invoke('save_settings', {settings});
        try {
            const info = await invoke<{ version: string }>('check_python', {python: settings.python});
            if (g !== pythonGeneration.current) return;
            setPythonStatus('DrissionPage ' + info.version);
            setPythonReady(true);
            setNotice('Python 环境已保存并可用');
        } catch (e) {
            if (g === pythonGeneration.current) setPythonStatus(String(e));
            throw e;
        }
    }

    async function pickExecutable(kind: 'python' | 'browser' | 'desktopPython') {
        const value = await open({
            multiple: false,
            directory: false,
            title: kind !== 'browser' ? '选择虚拟环境 Scripts/python.exe' : '选择 Chrome 或 Edge',
            filters: [{name: '可执行文件', extensions: ['exe']}]
        });
        if (typeof value === 'string') {
            setSettings(s => ({...s, [kind]: value}));
            if (kind === 'python') {
                pythonGeneration.current++;
                setPythonReady(false);
                setPythonStatus('请检测并保存环境');
            }
        }
    }

    async function launch() {
        let path = settings.browser;
        if (!path) {
            const paths = await invoke<string[]>('browser_paths');
            path = paths[0] ?? '';
        }
        if (!path) {
            setShowSettings(true);
            throw Error('请先在设置中选择 Chrome 或 Edge 的可执行文件');
        }
        await invoke('save_settings', {settings: {...settings, browser: path}});
        setSettings(s => ({...s, browser: path}));
        const endpoint = await launchBrowser(path, address);
        await connect(endpoint);
    }

    async function runQuery() {
        if (activeCaptureRecord && !isLiveCapture(activeCaptureRecord, {
            ...current.current,
            generation: generation.current
        })) {
            throw Error('正在查看历史快照，请重新捕获元素后校验');
        }
        return previewWithHiddenWindow(settings.hideCaptureWindow, async () => {
            setActiveCaptureRecord(null);
            const g = generation.current;
            setResult(null);
            setSelected(null);
            const scope = context ?? await invoke<Context>('root_context');
            const value = await invoke<QueryResult>('query', {
                python: settings.python,
                context: scope,
                mode,
                expression
            });
            if (g !== generation.current) return;
            setContext(value.context);
            setResult(value);
            setSelected(value.matches[0] ?? null);
            await invoke('highlight', {context: value.context, tokens: value.matches.map(e => e.token), scroll: false});
            setNotice(value.total ? `已通过 ${value.engine} 在${value.context.parents?.length ? '当前父级内' : '当前文档中'}找到 ${value.total} 个元素` : '当前查找范围内未找到匹配元素');
        });
    }

    function clearLocator(nextContext: Context) {
        editingCaptureId.current = null;
        setActiveCaptureRecord(null);
        setContext(nextContext);
        setCapture(null);
        setResult(null);
        setSelected(null);
        setDpConditions([]);
        setExpression('');
        setCopied('');
        setError('');
    }

    async function useAsParent() {
        if (!result || result.total !== 1 || !result.matches[0]) return;
        await invoke('clear_highlights');
        clearLocator({...result.context, parents: [...(result.context.parents ?? []), {
            mode, expression, token: result.matches[0].token
        }]});
        setNotice('已设为父级，请捕获或输入下一层定位表达式');
    }

    async function removeParents(count: number) {
        if (!context) return;
        await invoke('clear_highlights');
        clearLocator({...context, parents: (context.parents ?? []).slice(0, count)});
        setNotice(count ? '已返回上一级父级范围' : '已清空父级，返回当前文档范围');
    }

    function restoreCapture(record: CaptureRecord) {
        const value = record.capture;
        const rows = record.dpConditions;
        editingCaptureId.current = record.id;
        setActiveCaptureRecord(record);
        setCapture(value);
        setContext(value.context);
        setSelected(value.element);
        setResult(null);
        setMode('DP');
        setDpConditions(rows);
        setExpression(dpQuickLocator(rows).expression);
        setCopied('');
        setError('');
        setNotice(isLiveCapture(record, {...current.current, generation: generation.current})
            ? '已恢复捕获记录，可编辑定位表达式并校验'
            : '正在查看历史快照，可查看属性和复制定位表达式');
    }

    function changeMode(next: string) {
        if (next === mode) return;
        setMode(next);
        setResult(null);
        setCopied('');
        if (capture) setExpression(next === 'CSS' ? capture.element.css : next === 'XPath' ? capture.element.xpath : dpQuickLocator(dpConditions).expression);
    }

    function changeDpConditions(rows: DpCondition[]) {
        const recordId = editingCaptureId.current;
        if (recordId !== null) setCaptureHistory(previous => saveCaptureConditions(previous, recordId, rows));
        setDpConditions(rows);
        setExpression(dpQuickLocator(rows).expression);
        setResult(null);
        setCopied('');
    }

    async function toggleFreeze() {
        if (freezePhase !== 'idle') {
            try {
                await invoke('set_freeze', {active: false});
            } finally {
                await restoreCaptureWindow();
            }
            return;
        }
        captureWindowRestore.current = await hideCaptureWindow(settings.hideCaptureWindow);
        try {
            await invoke('set_freeze', {active: true});
        } catch (e) {
            await restoreCaptureWindow();
            throw e;
        }
    }

    async function copy(text: string, key: string) {
        await navigator.clipboard.writeText(text);
        setCopied(key);
        window.setTimeout(() => setCopied(''), 1600);
    }

    const captureSource = {...current.current, generation: generation.current};
    const historySnapshot = !!activeCaptureRecord && !isLiveCapture(activeCaptureRecord, captureSource);
    const scope = context ?? capture?.context ?? null;
    const scopeLabel = scope?.steps.length ? scope.steps.map(s => s.kind === 'frame' ? 'iframe' : 'Shadow Root').join(' › ') : '顶层文档';
    const disabled = !!busy || recorder.pending || !!recorder.validatingId;
    return <div className="app-shell">
        <div className="workspace">
            <Titlebar desktop={desktop} settingsOpen={showSettings} onSettingsToggle={() => setShowSettings(v => !v)}
                      onError={setError}/>
            {workMode === 'desktop' ? <div className="connection-bar desktop-connection"><strong>Windows
                    桌面元素</strong><span>{desk.status}</span><span
                    className="connection-hint">{desk.backend.toUpperCase()} · 外部 Python 环境</span></div> :
                <div className="connection-bar">
                    <div className="address-input"><span>CDP</span><input aria-label="调试地址" value={address}
                                                                          onChange={e => setAddress(e.target.value)}
                                                                          placeholder="127.0.0.1:9222" onKeyDown={e => {
                        if (e.key === 'Enter' && !disabled) void execute('连接中', () => connect(address));
                    }}/></div>
                    <button disabled={!desktop || disabled} className="primary"
                            onClick={() => void execute('连接中', () => connect(address))}>连接<ArrowRight size={15}/>
                    </button>
                    <button disabled={!desktop || disabled} onClick={() => void execute('发现中', async () => {
                        const found = await invoke<Browser[]>('discover_browsers');
                        setBrowsers(found);
                        setNotice(found.length ? `发现 ${found.length} 个浏览器实例` : '未发现调试实例，可手填端口或启动浏览器');
                    })}><RefreshCw size={15} className={busy === '发现中' ? 'spin' : ''}/>发现实例
                    </button>
                    <div className="bar-separator"/>
                    <button disabled={!desktop || disabled} onClick={() => void execute('启动中', launch)}><Plus
                        size={16}/>启动浏览器
                    </button>
                    <span className="connection-hint">无需浏览器插件</span></div>}
            {showSettings && <section className="settings-panel">
                <div className="section-title"><h3><Settings2 size={17}/>运行环境</h3>
                    <button title="收起设置" className="icon-button" onClick={() => setShowSettings(false)}><X
                        size={17}/></button>
                </div>
                <label>Python 虚拟环境 <span>选择 Scripts/python.exe，并在该环境中安装 DrissionPage</span></label>
                <div className="setting-row"><input value={settings.python}
                                                    placeholder="D:\project\.venv\Scripts\python.exe" onChange={e => {
                    pythonGeneration.current++;
                    setSettings(s => ({...s, python: e.target.value}));
                    setPythonReady(false);
                    setPythonStatus('环境已修改，请重新检测');
                }}/>
                    <button disabled={disabled}
                            onClick={() => void execute('选择文件', () => pickExecutable('python'))}><FolderOpen
                        size={15}/>选择
                    </button>
                    <button disabled={disabled || !settings.python}
                            onClick={() => void execute('检测环境', checkPython)}>检测并保存
                    </button>
                </div>
                <p className={'environment-status ' + (pythonReady ? 'success' : '')}>{pythonStatus || '尚未配置 Python 环境'}</p>
                <label>桌面 Python
                    环境 <span>留空沿用上面的 Python；安装 desktop-automation-runtime，与 DrissionPage 分别检测</span></label>
                <div className="setting-row"><input aria-label="桌面 Python 环境" value={settings.desktopPython || ''}
                                                    placeholder="留空沿用 Python 环境"
                                                    onChange={e => setSettings(s => ({
                                                        ...s,
                                                        desktopPython: e.target.value
                                                    }))}/>
                    <button disabled={disabled}
                            onClick={() => void execute('选择文件', () => pickExecutable('desktopPython'))}><FolderOpen
                        size={15}/>选择
                    </button>
                    <button disabled={disabled} onClick={() => void execute('保存桌面环境', async () => {
                        await invoke('save_settings', {settings});
                        setNotice('桌面环境已保存，进入桌面元素工作区检测');
                    })}>保存
                    </button>
                </div>
                <label>浏览器路径 <span>留空时优先寻找本机 Chrome，其次 Edge；每次启动使用独立配置目录</span></label>
                <div className="setting-row"><input value={settings.browser} placeholder="自动检测 Chrome / Edge"
                                                    onChange={e => setSettings(s => ({
                                                        ...s,
                                                        browser: e.target.value
                                                    }))}/>
                    <button disabled={disabled}
                            onClick={() => void execute('选择文件', () => pickExecutable('browser'))}><FolderOpen
                        size={15}/>选择
                    </button>
                    <button disabled={disabled} onClick={() => void execute('保存设置', async () => {
                        await invoke('save_settings', {settings});
                        setNotice('设置已保存');
                    })}>保存
                    </button>
                </div>
                <label className="capture-window-setting">
                    <input type="checkbox" checked={settings.hideCaptureWindow} disabled={disabled}
                           onChange={e => {
                               const next = {...settings, hideCaptureWindow: e.target.checked};
                               void execute('保存设置', async () => {
                                   await invoke('save_settings', {settings: next});
                                   setSettings(next);
                               });
                           }}/>
                    捕获元素隐藏窗口
                    <span>捕获时最小化，结束后恢复；校验和回显高亮时最小化，5 秒后恢复。修改后自动保存</span>
                </label>
            </section>}
            {!desktop &&
                <div className="message warning">当前为界面预览。请使用 <code>npm run tauri dev</code> 启动桌面版以连接浏览器。
                </div>}
            {error && <div className="message error" role="alert"><span>{error}</span>
                <button title="关闭提示" onClick={() => setError('')}><X size={15}/></button>
            </div>}
            {freezePhase !== 'idle' && <div className="message freeze-message" role="status">
                <span>{freezePhase === 'armed' ? '展开浮窗，按 Alt + 鼠标左键确认冻结；Esc 取消。' : '浮窗已冻结，网页交互与定时更新已暂停。捕获或校验完成后，请解除冻结。'}</span>
                <button onClick={() => void execute('解除冻结', toggleFreeze)}
                        disabled={disabled}>{freezePhase === 'armed' ? '取消冻结' : '解除冻结'}</button>
            </div>}
            <main className="workbench">
                <section className="browser-pane">
                    <div className="pane-heading workspace-heading"><h2>工作区</h2></div>
                    <div className="workspace-nav" role="tablist" aria-orientation="vertical" aria-label="工作区功能">
                        <button role="tab" aria-selected={workMode === 'elements'} aria-controls="element-workspace"
                                id="element-tab" className={workMode === 'elements' ? 'active' : ''}
                                onClick={() => setWorkMode('elements')}><Crosshair size={16}/>元素定位
                        </button>
                        <button role="tab" aria-selected={workMode === 'network'} aria-controls="network-workspace"
                                id="network-tab" className={workMode === 'network' ? 'active' : ''}
                                onClick={() => setWorkMode('network')}><Radio size={16}/>网络监听
                        </button>
                        <button role="tab" aria-selected={workMode === 'recording'} aria-controls="recording-workspace"
                                id="recording-tab" className={workMode === 'recording' ? 'active' : ''}
                                onClick={() => setWorkMode('recording')}><CircleDot size={16}/>操作录制
                            {recorder.phase === 'recording' &&
                                <span className="recording-tab-dot" aria-label="正在录制">●</span>}
                            {recorder.phase === 'paused' && <span className="count">暂停</span>}
                        </button>
                    </div>
                    <button role="tab" aria-selected={workMode === 'desktop'} aria-controls="desktop-workspace"
                            id="desktop-tab" className={'desktop-mode-tab ' + (workMode === 'desktop' ? 'active' : '')}
                            disabled={disabled} onClick={() => void execute('切换桌面工作区', async () => {
                        await recorder.finish();
                        if (capturing) {
                            await invoke('set_capture', {active: false});
                            setCapturing(false);
                            await restoreCaptureWindow();
                        }
                        setWorkMode('desktop');
                    })}><Monitor size={16}/>桌面元素
                    </button>
                    {workMode === 'desktop' ? <DesktopSources d={desk}/> : <>
                        <div className="pane-heading browser-group-heading">
                            <h2>
                                <button className="browser-group-toggle" aria-expanded={browsersExpanded}
                                        aria-controls="browser-instance-list"
                                        onClick={() => setBrowsersExpanded(expanded => !expanded)}>
                                    <ChevronDown size={14} className={browsersExpanded ? '' : 'collapsed'}/>
                                    浏览器实例<span className="count">{browsers.length}</span>
                                </button>
                            </h2>
                        </div>
                        <div id="browser-instance-list" className="browser-list"
                             hidden={!browsersExpanded}>{browsers.length === 0 ?
                            <div className="sidebar-empty"><Monitor size={28}/><p>连接你的浏览器</p><span>发现已开放调试端口的实例，<br/>或启动一个新的开发浏览器。</span>
                            </div> : browsers.map(b => <button
                                className={'browser-item ' + (browser?.endpoint === b.endpoint ? 'selected' : '')}
                                key={b.endpoint} disabled={disabled}
                                onClick={() => void execute('连接中', () => connect(b.endpoint))}>
                                <div className="browser-icon"><Monitor size={18}/></div>
                                <div><strong>{b.name}</strong><small>{b.endpoint.replace('http://', '')}</small></div>
                                <span className={'status-dot ' + (browser?.endpoint === b.endpoint ? 'online' : '')}/>
                            </button>)}</div>
                        <div className="pane-heading tab-heading"><h2>标签页</h2>
                            <button className="icon-button" title="刷新标签页" disabled={!browser || disabled}
                                    onClick={() => void execute('刷新标签页', async () => setTabs(await invoke<Tab[]>('list_tabs', {address: browser!.endpoint})))}>
                                <RefreshCw size={14}/></button>
                        </div>
                        <div className="tab-list">{tabs.length === 0 ?
                            <p className="small-empty">连接实例后在这里选择标签页</p> : tabs.map(t => <button
                                className={'tab-item ' + (tab?.id === t.id ? 'selected' : '')} key={t.id}
                                disabled={disabled} onClick={() => void execute('接入标签页', () => chooseTab(t))}>
                                <div className="tab-icon"><ExternalLink size={15}/></div>
                                <div><strong>{t.title || '未命名标签页'}</strong><small>{t.url}</small></div>
                                {tab?.id === t.id && <ChevronRight size={14}/>}</button>)}</div>
                        <div className="browser-pane-footer"><span
                            className={'status-dot ' + (browser ? 'online' : '')}/>{browser ? '调试端口已连接' : '等待连接'}
                            <button className="icon-button" title="断开连接" disabled={!browser || disabled}
                                    onClick={() => void execute('断开连接', async () => {
                                        await recorder.finish();
                                        generation.current++;
                                        current.current = {endpoint: '', target: ''};
                                        await invoke('disconnect');
                                        clearPage();
                                        setBrowser(null);
                                        setTab(null);
                                        setTabs([]);
                                    })}><Unplug size={15}/></button>
                        </div>
                    </>}

                </section>
                <section className="editor-pane">
                    <h1 className="workspace-title">
                        {workMode === 'desktop' ? <Monitor size={16}/> : workMode === 'elements' ?
                            <Crosshair size={16}/> : workMode === 'network' ? <Radio size={16}/> :
                                <CircleDot size={16}/>}
                        {workMode === 'desktop' ? '桌面元素' : workMode === 'elements' ? '元素定位' : workMode === 'network' ? '网络监听' : '操作录制'}
                    </h1>
                    {workMode === 'desktop' && <DesktopPanel d={desk}/>}
                    <div id="recording-workspace" role="tabpanel" aria-labelledby="recording-tab"
                         hidden={workMode !== 'recording'}>
                        <RecordingPanel recorder={recorder} connected={!!tab && desktop} disabled={disabled}/>
                    </div>
                    <div id="network-workspace" role="tabpanel" aria-labelledby="network-tab"
                         hidden={workMode !== 'network'}>
                        <NetworkPanel hidden={workMode !== 'network'} endpoint={browser?.endpoint ?? ''}
                                      targetId={tab?.id ?? ''} python={settings.python} ready={pythonReady}
                                      disabled={disabled} onStarted={() => setCapturing(false)}
                                      onSelect={setNetworkPacket}/>
                    </div>
                    <div id="element-workspace" role="tabpanel" aria-labelledby="element-tab"
                         hidden={workMode !== 'elements'}>

                        <div className="locator-section">
                            <div className="section-title"><h3>定位表达式</h3>
                                <div className="context-badge" title={scope?.steps.map(s => s.selector).join(' › ')}>
                                    <Layers
                                        size={12}/>{scopeLabel}</div>
                            </div>
                            {!!scope?.parents?.length && <div className="parent-scope" aria-label="父级查找范围">
                                <div className="parent-scope-path"><span>查找范围</span><span>当前文档</span>
                                    {scope.parents.map((parent, index) => <span className="parent-scope-step" key={index}
                                        title={`${parent.mode}: ${parent.expression}`}><ChevronRight size={12}/>
                                        <code>{parent.expression}</code></span>)}
                                </div>
                                <div className="parent-scope-actions">
                                    <span>仅查找内部后代 · 不跨 iframe / Shadow Root</span>
                                    <button disabled={disabled || capturing || freezePhase === 'armed' || historySnapshot}
                                        onClick={() => void execute('返回上一级', () => removeParents(scope.parents!.length - 1))}>返回上一级</button>
                                    <button disabled={disabled || capturing || freezePhase === 'armed' || historySnapshot}
                                        onClick={() => void execute('清空父级', () => removeParents(0))}>清空父级</button>
                                </div>
                            </div>}
                            {historySnapshot && <p className="capture-snapshot-note"
                                                   role="status">正在查看历史快照。可编辑、复制定位表达式；重新捕获元素后可校验与高亮。</p>}
                            <div className="mode-tabs">{['CSS', 'XPath', 'DP'].map(m => <button
                                className={mode === m ? 'active' : ''} key={m} disabled={disabled || capturing}
                                onClick={() => changeMode(m)}>{m === 'DP' ? 'DrissionPage' : m}</button>)}<span
                                className="engine-label">实际 DP 引擎</span></div>
                            {mode === 'DP' && capture && <DpLocatorBuilder rows={dpConditions} expression={expression}
                                                                           truncated={!!capture.element.locatorTextTruncated}
                                                                           onChange={changeDpConditions}
                                                                           disabled={capturing || disabled}/>}
                            <div className="code-actions" role="group" aria-label="生成代码的操作">
                                <span>代码操作</span>
                                <label><input type="checkbox" checked={codeClick} disabled={disabled || capturing}
                                              onChange={e => {
                                                  setCodeClick(e.target.checked);
                                                  setCopied('');
                                              }}/>click</label>
                                <label><input type="checkbox" checked={codeInput} disabled={disabled || capturing}
                                              onChange={e => {
                                                  setCodeInput(e.target.checked);
                                                  setCopied('');
                                              }}/>input</label>
                                {codeInput && <textarea aria-label="input 输入内容" rows={1} value={inputText}
                                                        placeholder="输入内容" spellCheck={false}
                                                        disabled={disabled || capturing}
                                                        onChange={e => {
                                                            setInputText(e.target.value);
                                                            setCopied('');
                                                        }}/>}
                            </div>
                            <div className="code-editor"><span className="line-number">1</span><textarea
                                aria-label="定位表达式" spellCheck={false}
                                placeholder={mode === 'DP' ? '例如 tag:button@@id=submit' : mode === 'XPath' ? '例如 //button[@type="submit"]' : '例如 button[data-testid="submit"]'}
                                value={expression} disabled={capturing || disabled} onChange={e => {
                                setExpression(e.target.value);
                                setResult(null);
                                setCopied('');
                            }}/></div>
                            <div className="editor-actions">
                                <span className={'python-indicator ' + (pythonReady ? 'ready' : '')}>
                                    <i/>{pythonReady ? pythonStatus :
                                    <button onClick={() => setShowSettings(true)}>配置 Python 环境</button>}
                                </span>

                                <div className="editor-command-buttons">
                                    <button className="copy-action"
                                            title={copied === 'locator' ? '已复制定位表达式' : '复制定位表达式'}
                                            aria-label="复制定位表达式"
                                            disabled={!expression.trim() || disabled || capturing}
                                            onClick={() => void execute('复制', () => copy(locator(mode, expression), 'locator'))}>
                                        {copied === 'locator' ? <Check size={15}/> : <Copy size={15}/>}
                                    </button>
                                    <button className="copy-action"
                                            title={copied === 'code' ? '已复制 DP 代码' : '复制 DP 代码（包含父级链和 iframe / Shadow Root 上下文）'}
                                            aria-label="复制 DP 代码"
                                            disabled={!browser || !tab || !expression.trim() || disabled || capturing}
                                            onClick={() => void execute('复制', () => copy(dpCode(scope, mode, expression, {
                                                click: codeClick,
                                                input: codeInput ? inputText : undefined
                                            }), 'code'))}>
                                        {copied === 'code' ? <Check size={15}/> : <Code2 size={15}/>}
                                    </button>

                                    <div className="freeze-control">
                                        <button className={freezePhase !== 'idle' ? 'freeze-active' : ''}
                                                disabled={!tab || disabled || capturing || recorder.phase === 'recording'}
                                                onClick={() => void execute(freezePhase === 'idle' ? '准备冻结' : '解除冻结', toggleFreeze)}>
                                            <Snowflake
                                                size={15}/>{freezePhase === 'idle' ? '冻结浮窗' : freezePhase === 'armed' ? '取消冻结' : '解除冻结'}
                                        </button>
                                        <FreezeHelp/>
                                    </div>
                                    <button className={capturing ? '' : 'primary'}
                                            disabled={!tab || disabled || recorder.phase === 'recording' || freezePhase === 'armed'}
                                            onClick={() => void execute(capturing ? '停止捕获' : '开始捕获', async () => {
                                                if (capturing) {
                                                    try {
                                                        await invoke('set_capture', {active: false});
                                                    } finally {
                                                        setCapturing(false);
                                                        await restoreCaptureWindow();
                                                    }
                                                    return;
                                                }
                                                captureWindowRestore.current = await hideCaptureWindow(settings.hideCaptureWindow);
                                                setCapturing(true);
                                                try {
                                                    const nextScope = await invoke<Context | null>('set_capture', {
                                                        active: true, python: settings.python, context: historySnapshot ? null : scope
                                                    });
                                                    if (nextScope) setContext(nextScope);
                                                } catch (e) {
                                                    setCapturing(false);
                                                    await restoreCaptureWindow();
                                                    throw e;
                                                }
                                            })}>{capturing ? <Square size={15}/> :
                                        <Crosshair size={15}/>} {capturing ? '停止' : '开始捕获'}</button>
                                    <button
                                        disabled={!tab || !pythonReady || !expression.trim() || disabled || capturing || freezePhase === 'armed' || historySnapshot}
                                        className="primary" onClick={() => void execute('校验中', runQuery)}><Play
                                        size={14}/>{busy === '校验中' ? '正在校验…' : '回显校验'}</button>
                                    <button title={result?.total === 1 ? '在当前唯一匹配元素内继续查找' : '当前表达式需校验且恰好匹配一个元素'}
                                        disabled={!result || result.total !== 1 || !result.matches[0] || disabled || capturing || freezePhase === 'armed' || historySnapshot}
                                        onClick={() => void execute('设为父级', useAsParent)}><Layers size={14}/>设为父级</button>
                                    <button className="copy-action clear-highlight" title="清除网页高亮框"
                                            aria-label="清除网页高亮框"
                                            disabled={!tab || disabled || capturing || freezePhase === 'armed'}
                                            onClick={() => void execute('清除高亮', async () => {
                                                await invoke('clear_highlights');
                                                setNotice('已清除网页高亮框');
                                            })}><Eraser size={15}/></button>
                                </div>
                            </div>
                        </div>
                        <div className="results-section">
                            <div className="section-title"><h3>匹配结果 {result &&
                                <span className="count">{result.total}</span>}</h3>{result &&
                                <span className="result-engine"><Check size={12}/>{result.engine}</span>}</div>
                            {!result ? <div className="results-empty">
                                <div><Search size={28}/></div>
                                <strong>在这里查看匹配的元素</strong><p>输入表达式并校验，结果会同时标记在网页中。</p>
                            </div> : result.total === 0 ?
                                <div className="results-empty"><Search size={28}/><strong>没有匹配到元素</strong>
                                    <p>检查表达式和当前查找范围，或重新捕获一个范围内的元素。</p></div> : <>
                                    <div className="result-table">
                                        <div className="result-table-head">
                                            <span>#</span><span>元素 / 文本</span><span>状态</span></div>
                                        {result.matches.map((el, i) => <button
                                            className={'result-row ' + (selected?.token === el.token ? 'selected' : '')}
                                            key={el.token} disabled={disabled}
                                            onClick={() => void execute('定位元素', async () => {
                                                await previewWithHiddenWindow(settings.hideCaptureWindow, () => invoke('highlight', {
                                                    context: result.context,
                                                    tokens: [el.token],
                                                    scroll: true
                                                }));
                                                setActiveCaptureRecord(null);
                                                setSelected({...el});
                                            })}><span className="result-index">{i + 1}</span>
                                            <div>
                                                <code>&lt;{el.tag}&gt;</code><span>{el.text.slice(0, 100) || '无文本内容'}</span>
                                            </div>
                                            <span
                                                className={'visibility ' + (el.visible ? 'visible' : '')}>{el.inViewport ? '视口内' : el.visible ? '视口外' : '隐藏'}</span>
                                        </button>)}</div>
                                    {result.truncated &&
                                        <p className="limit-note">共 {result.total} 个匹配，列表与页面框展示前 200
                                            个。</p>}</>}</div>
                    </div>
                </section>
                <DetailsResizer/>
                <section id="details-pane"
                         className={'details-pane' + (workMode === 'desktop' ? ' desktop-details-pane' : workMode === 'elements' ? ' element-details-pane' : workMode === 'recording' ? ' recording-details-pane' : '')}>
                    {workMode === 'desktop' ? <DesktopDetails d={desk}/> : workMode === 'network' ?
                        <NetworkDetails packet={networkPacket}/> : workMode === 'recording' ?
                            <RecordingDetails recorder={recorder} disabled={disabled} pythonReady={pythonReady}
                                              connected={!!tab && desktop}
                                              capturing={capturing || freezePhase !== 'idle'}/> : <>
                                <div className="pane-heading"><h2>元素详情</h2><Braces size={16}/></div>
                                <div className="element-details-body">
                                    {!selected ? <div className="details-empty">
                                        <div className="element-illustration"><Code2 size={38}/></div>
                                        <strong>从一个元素开始</strong><p>捕获或选中匹配结果后，<br/>在这里查看属性、文本和位置尺寸。
                                    </p>
                                    </div> : <div className="details-content">
                                        <div className="element-tag"><code>&lt;{selected.tag}&gt;</code><span
                                            className={'visibility ' + (selected.visible ? 'visible' : '')}>{selected.visible ? '可见' : '隐藏'}</span>
                                        </div>
                                        <div className="element-text"><span>文本</span>
                                            <p title={selected.text || undefined}>{selected.text.replace(/\s+/g, ' ').trim() || '（无文本）'}</p>
                                        </div>
                                        <label
                                            className="detail-label">元素属性 <span>{Object.keys(selected.attributes).length}</span></label>
                                        <dl className="attribute-list">{Object.entries(selected.attributes).map(([name, value]) =>
                                            <div
                                                key={name}>
                                                <dt>{name}</dt>
                                                <dd title={value}>{value || '""'}</dd>
                                            </div>)}</dl>
                                        {historySnapshot ? <p className="capture-snapshot-note">历史快照
                                                · {activeCaptureRecord?.pageTitle || activeCaptureRecord?.pageUrl || '原页面'}<br/>位置与尺寸需重新捕获后读取。
                                            </p> :
                                            <ElementGeometryPanel context={context} element={selected}/>}
                                    </div>}</div>
                                <CaptureHistory records={captureHistory} source={captureSource}
                                                selectedId={activeCaptureRecord?.id}
                                                disabled={disabled || capturing} onSelect={restoreCapture}/>
                            </>}</section>
            </main>
            <footer className="statusbar">
                <div><span
                    className={'status-dot ' + (tab ? 'online' : '')}/>{workMode === 'desktop' ? desk.busy || desk.notice || desk.status : busy || notice || (tab ? '已连接 · 等待操作' : '就绪 · 请选择浏览器实例')}
                </div>
                <span>{freezePhase === 'armed' ? <>Alt +
                    左键确认冻结 <kbd>Esc</kbd> 取消</> : freezePhase === 'frozen' ? <>冻结中 ·
                    开始捕获后直接点击元素</> : <>Ctrl + 点击捕获 <kbd>Esc</kbd> 取消</>}</span></footer>
        </div>
    </div>;
}
