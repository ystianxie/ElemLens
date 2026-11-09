import {useEffect, useRef, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {Copy, Play, Radio, Square, Trash2} from 'lucide-react';
import {networkOptions, networkSummary, type NetworkOptions, type NetworkPacket, type NetworkSummary} from './network';
import './network.css';

type Props = {
    hidden: boolean;
    endpoint: string;
    targetId: string;
    python: string;
    ready: boolean;
    disabled: boolean;
    onStarted: () => void;
    onSelect: (packet: NetworkPacket | null) => void
};
type Phase = 'idle' | 'starting' | 'listening' | 'stopping' | 'finished' | 'error';
const desktop = '__TAURI_INTERNALS__' in window;
const time = (value: number) => new Date(value).toLocaleTimeString('zh-CN', {hour12: false, timeZone: 'Asia/Shanghai'});

export function NetworkPanel(props: Props) {
    const [keywords, setKeywords] = useState(''), [continuous, setContinuous] = useState(false);
    const [count, setCount] = useState('1'), [timeout, setTimeoutValue] = useState(''), [fitCount, setFitCount] = useState(true), [method, setMethod] = useState('ALL');
    const [phase, setPhase] = useState<Phase>('idle'), [message, setMessage] = useState('先开始监听，再刷新网页或手动操作，触发目标请求。');
    const [packets, setPackets] = useState<NetworkPacket[]>([]), [total, setTotal] = useState(0), [selected, setSelected] = useState<number | null>(null);
    const [startedAt, setStartedAt] = useState<number | null>(null), [elapsed, setElapsed] = useState(0), [eventsReady, setEventsReady] = useState(false), [copyMessage, setCopyMessage] = useState('');
    const [snapshot, setSnapshot] = useState<NetworkOptions | null>(null);
    const session = useRef(''), options = useRef<NetworkOptions | null>(null), select = useRef(props.onSelect),
        phaseRef = useRef<Phase>('idle');
    select.current = props.onSelect;
    phaseRef.current = phase;
    const active = phase === 'starting' || phase === 'listening' || phase === 'stopping';
    useEffect(() => {
        if (!desktop) return;
        let disposed = false;
        const unlisten = listen<{
            sessionId: string;
            kind: string;
            data: unknown
        }>('network-event', ({payload: event}) => {
            if (disposed || event.sessionId !== session.current) return;
            if (event.kind === 'ready') {
                setStartedAt(Date.now());
                if (phaseRef.current !== 'stopping') {
                    setPhase('listening');
                    setMessage('正在监听，请刷新网页或手动操作，触发目标请求。');
                }
            } else if (event.kind === 'packet') {
                const packet = event.data as NetworkPacket;
                setPackets(rows => [...rows.slice(-499), packet]);
                setTotal(packet.index);
                setSelected(value => value ?? packet.index);
                if (packet.index === 1) select.current(packet);
            } else if (event.kind === 'finished') {
                const summary = event.data as NetworkSummary;
                setPhase('finished');
                setMessage(networkSummary(summary, options.current?.count ?? null));
                if (summary.elapsed !== undefined) setElapsed(Math.floor(summary.elapsed));
            } else if (event.kind === 'error') {
                setPhase('error');
                setMessage((event.data as { message: string }).message);
            }
        });
        void unlisten.then(fn => {
            if (disposed) fn(); else setEventsReady(true);
        }).catch(e => {
            if (!disposed) {
                setPhase('error');
                setMessage(String(e));
            }
        });
        return () => {
            disposed = true;
            void unlisten.then(fn => fn()).catch(() => {
            });
        };
    }, []);
    useEffect(() => {
        if (!active || startedAt === null) return;
        const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
        return () => window.clearInterval(timer);
    }, [active, startedAt]);

    async function start() {
        if (['starting', 'listening', 'stopping'].includes(phaseRef.current)) return;
        try {
            const value = networkOptions(keywords, continuous, count, timeout, fitCount, method);
            options.current = value;
            setSnapshot(value);
            session.current = crypto.randomUUID();
            phaseRef.current = 'starting';
            setPhase('starting');
            setMessage('正在启动监听，请等待就绪后再操作网页……');
            setPackets([]);
            setTotal(0);
            setSelected(null);
            select.current(null);
            setCopyMessage('');
            setElapsed(0);
            setStartedAt(null);
            await invoke('start_network_listener', {python: props.python, sessionId: session.current, options: value});
            props.onStarted();
        } catch (error) {
            setPhase('error');
            setMessage(String(error));
        }
    }

    async function stop() {
        if (!active || phase === 'stopping') return;
        const id = session.current;
        phaseRef.current = 'stopping';
        setPhase('stopping');
        setMessage('正在结束监听……');
        try {
            await invoke('stop_network_listener', {sessionId: id});
        } catch (error) {
            if (session.current === id) {
                setPhase('error');
                setMessage(String(error));
            }
        }
    }

    function clear() {
        setPackets([]);
        setTotal(0);
        setSelected(null);
        select.current(null);
        setSnapshot(null);
        setPhase('idle');
        setMessage('先开始监听，再刷新网页或手动操作，触发目标请求。');
        setElapsed(0);
        setCopyMessage('');
    }

    async function copy(url: string) {
        try {
            await navigator.clipboard.writeText(url);
            setCopyMessage('已复制 URL');
        } catch (error) {
            setCopyMessage('复制失败：' + String(error));
        }
    }

    return <div className="network-panel" hidden={props.hidden}>
        <div className="network-intro"><Radio size={22}/>
            <div><strong>验证监听 URL</strong><p>设置 URL 关键词，在网页中操作，检查是否捕获到目标请求。</p></div>
        </div>
        <label className="network-label"
               htmlFor="network-targets">监听关键词 <span>URL 包含任意一行内容时捕获，区分大小写</span></label>
        <textarea id="network-targets" rows={3} value={keywords} disabled={active} spellCheck={false}
                  placeholder={'api/user\napi/order'} onChange={e => setKeywords(e.target.value)}/>
        <div className="network-controls">
            <label>捕获方式<select value={continuous ? 'continuous' : 'count'} disabled={active}
                                   onChange={e => setContinuous(e.target.value === 'continuous')}>
                <option value="count">定量捕获</option>
                <option value="continuous">持续捕获 · 手动结束</option>
            </select></label>
            <label>请求方法<select value={method} disabled={active}
                                   onChange={e => setMethod(e.target.value)}>{['ALL', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(m =>
                <option key={m} value={m}>{m === 'ALL' ? '全部' : m}</option>)}</select></label>
        </div>
        {!continuous && <>
            <div className="network-controls">
                <label>捕获条数 count<input type="number" min="1" step="1" value={count} disabled={active}
                                            onChange={e => setCount(e.target.value)}/></label>
                <label>超时 timeout（秒）<input type="number" min="0.01" step="any" value={timeout} disabled={active}
                                              placeholder="留空表示不限"
                                              onChange={e => setTimeoutValue(e.target.value)}/></label>
            </div>
            <label className="network-fit"><input type="checkbox" checked={fitCount} disabled={active}
                                                  onChange={e => setFitCount(e.target.checked)}/>fit_count：超时时必须满足捕获条数</label>
            <p className="network-hint">取消勾选后，超时可接受不足条数的结果；不限时仍等待 count
                条。多个关键词共同计数。</p></>}
        <div className="network-actions">
            <button className="primary"
                    disabled={!desktop || !eventsReady || !props.targetId || !props.ready || props.disabled || active}
                    onClick={() => void start()}><Play size={14}/>开始监听
            </button>
            <button disabled={!active || phase === 'stopping'} onClick={() => void stop()}><Square
                size={14}/>{phase === 'stopping' ? '正在结束…' : '结束监听'}</button>
            <button disabled={active || !snapshot} onClick={clear}><Trash2 size={14}/>清空结果</button>
        </div>
        <div className={'network-status ' + (phase === 'error' ? 'error' : '')} role="status" aria-live="polite"><span
            className={'status-dot ' + (phase === 'listening' ? 'online' : '')}/><span>{message}</span></div>
        <div className="network-metrics">
            <span>已捕获 <b>{total}</b> 条</span><span>已等待 {elapsed} 秒</span>{!props.ready &&
            <span>请先配置并检测 Python 环境</span>}</div>
        {snapshot &&
            <p className="network-snapshot">本次条件：{snapshot.targets.join(' 或 ')} · {snapshot.method === 'ALL' ? '全部方法' : snapshot.method} · {snapshot.count === null ? '持续捕获' : '目标 ' + snapshot.count + ' 条'}{snapshot.timeout !== null ? ' · 超时 ' + snapshot.timeout + ' 秒' : ' · 不限时'}</p>}
        <div className="section-title network-results-title"><h3>监听结果 <span className="count">{total}</span></h3>
            <span>{copyMessage}</span></div>
        {!packets.length ? <div className="results-empty"><Radio
            size={28}/><strong>{active ? '等待符合条件的数据包' : '暂无捕获结果'}</strong><p>未捕获到数据包不代表 URL
            条件无效。</p></div> : <div className="network-results">{packets.map(packet => <div key={packet.index}
                                                                                               className={'network-row ' + (selected === packet.index ? 'selected' : '')}>
            <button className="network-packet" onClick={() => {
                setSelected(packet.index);
                select.current(packet);
            }}>
                <span
                    className="network-row-meta"><span>#{packet.index} · {time(packet.capturedAt)}</span><b>{packet.method}</b><span
                    className={packet.failed || (packet.status ?? 0) >= 400 ? 'network-failed' : ''}>{packet.failed ? '连接失败' : packet.status}</span></span>
                <code>{packet.url}</code><span
                className="network-match">命中：{packet.targets.join('、')}{packet.failed ? ' · ' + packet.error : ''}</span>
            </button>
            <button className="copy-action" aria-label={'复制第 ' + packet.index + ' 条 URL'} title="复制 URL"
                    onClick={() => void copy(packet.url)}><Copy size={14}/></button>
        </div>)}</div>}
        {total > 500 && <p className="network-hint">累计捕获 {total} 条，界面保留最近 500 条。</p>}
    </div>;
}

export function NetworkDetails({packet}: { packet: NetworkPacket | null }) {
    const [copyMessage, setCopyMessage] = useState('');
    useEffect(() => setCopyMessage(''), [packet]);

    async function copyResponse() {
        if (packet?.responseText == null) return;
        try {
            await navigator.clipboard.writeText(packet.responseText);
            setCopyMessage('已复制 Response');
        } catch (error) {
            setCopyMessage('复制失败：' + String(error));
        }
    }

    return <>
        <div className="pane-heading"><h2>监听详情</h2><Radio size={16}/></div>
        {packet ? <div className="details-content network-detail">
            <label className="detail-label">完整 URL</label><code>{packet.url}</code>
            <label className="detail-label">命中关键词</label><p>{packet.targets.join('、')}</p>
            <label className="detail-label">请求方法 / 状态</label>
            <p>{packet.method} · {packet.failed ? '连接失败：' + packet.error : packet.status}</p>
            <label className="detail-label">捕获时间</label><p>{time(packet.capturedAt)}</p>
            <div className="detail-label network-response-heading"><span>Response</span>
                <button className="copy-action" disabled={packet.responseText == null}
                        onClick={() => void copyResponse()} title="复制完整 Response 文本"><Copy size={13}/>复制
                </button>
            </div>
            <p className="network-response-type">{packet.responseType}</p>
            {packet.responseText != null ?
                <pre className="network-response-body">{packet.responseText || '（空响应）'}</pre> :
                <p>{packet.responseError || '未获取到 Response 文本'}</p>}
            <p role="status" aria-live="polite">{copyMessage}</p>
        </div> : <div className="details-empty"><Radio size={32}/><p>开始监听后，在网页中触发请求。<br/>选中结果可查看关键词、完整
            URL 和 Response。</p><p>请先等待“正在监听”提示，<br/>再刷新或操作网页。</p></div>}</>;
}
