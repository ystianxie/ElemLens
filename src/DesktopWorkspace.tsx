import {useState} from 'react';
import {ChevronRight, ChevronDown, Crosshair, RefreshCw, X, Copy, Upload, Download, Monitor, Search} from 'lucide-react';
import type {DesktopController} from './useDesktop';
import type {ConditionRow, DesktopElement} from './desktop-model';
import './desktop.css';
const label = (item: DesktopElement) => item.title || item.control_type || item.class_name || '无名称控件';
export function DesktopSources({d}: {d: DesktopController}) {
    const [search, setSearch] = useState('');
    const locked = !!d.busy || d.capturing || !d.ready;
    const root = d.windows.find(item => item.token === d.root);
    function node(item: DesktopElement, depth: number, parents: Set<string>): React.ReactNode {
        if (!item.token || parents.has(item.token) || depth > 64) return null;
        const token = item.token, isOpen = d.expanded.has(token), next = new Set(parents).add(token);
        return <div key={token}>
            <div className={'desktop-tree-row ' + (d.selected?.token === token ? 'selected' : '')} style={{paddingLeft: 6 + depth * 12}}>
                <button className="icon-button" aria-label={'展开子控件：' + label(item)} aria-expanded={isOpen} disabled={locked} onClick={() => void d.expand(item)}>{isOpen ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</button>
                <button className="desktop-node-label" title={label(item)} disabled={locked} onClick={() => void d.inspect(item)}>{label(item)}<small>{item.control_type || item.class_name}</small></button>
            </div>
            {isOpen && (d.children[token]?.length ? d.children[token].map(child => node(child, depth + 1, next)) : <p className="small-empty">没有子控件</p>)}
        </div>;
    }
    return <div className="desktop-sources">
        <div className="pane-heading"><h2>桌面窗口</h2><button title="刷新窗口" className="icon-button" disabled={locked} onClick={() => void d.refresh()}><RefreshCw size={14}/></button></div>
        <label className="desktop-search"><Search size={14}/><input aria-label="搜索桌面窗口" placeholder="标题 / 进程 / 类名" value={search} onChange={e => setSearch(e.target.value)}/></label>
        <div className="desktop-window-list">{d.windows.filter(item => [item.title, item.process_name, item.class_name].join(' ').toLowerCase().includes(search.toLowerCase())).map(item => <button key={item.token} className={'desktop-window ' + (d.root === item.token ? 'selected' : '')} disabled={locked} onClick={() => void d.selectWindow(item)}><Monitor size={15}/><span><strong>{label(item)}</strong><small>{item.process_name} · {item.class_name}</small></span></button>)}
            {!d.windows.length && <p className="small-empty">检测环境后刷新窗口，或直接捕获目标软件。</p>}</div>
        <div className="pane-heading"><h2>控件树</h2><span className="count">按需展开</span></div>
        <div className="desktop-tree">{root ? node(root, 0, new Set()) : <p className="small-empty">选择窗口或捕获控件</p>}</div>
        {d.ancestry.length > 1 && <div className="desktop-ancestry"><label>当前捕获路径</label>{d.ancestry.map((item, index) => <button key={index} disabled={locked} title={label(item)} onClick={() => void d.inspect(item)}>{index + 1}. {label(item)}</button>)}</div>}
    </div>;
}
function Conditions({rows, disabled, onChange}: {rows: ConditionRow[]; disabled: boolean; onChange: (rows: ConditionRow[]) => void}) {
    const update = (index: number, changes: Partial<ConditionRow>) => onChange(rows.map((row, i) => i === index ? {...row, ...changes} : row));
    return <div className="desktop-conditions">{rows.map((row, index) => <div className="desktop-condition" key={index}>
        <input type="checkbox" aria-label={'使用 ' + row.field} checked={row.checked} disabled={disabled} onChange={e => update(index, {checked: e.target.checked})}/>
        <label>{row.field === 'title' || row.field === 'title_re' ? '名称 / 标题' : row.field}</label>
        <input aria-label={row.field} value={row.value} disabled={disabled} onChange={e => update(index, {value: e.target.value})}/>
        {(row.field === 'title' || row.field === 'title_re') && <label className="desktop-regex"><input type="checkbox" aria-label="使用正则" disabled={disabled} checked={row.field === 'title_re'} onChange={e => update(index, {field: e.target.checked ? 'title_re' : 'title'})}/>正则</label>}
    </div>)}</div>;
}
export function DesktopPanel({d}: {d: DesktopController}) {
    const locked = !!d.busy || d.capturing;
    const draft = d.draft;
    return <div id="desktop-workspace" role="tabpanel" aria-labelledby="desktop-tab" className="desktop-panel">
        <div className="desktop-toolbar"><select aria-label="桌面后端" disabled={locked} value={d.backend} onChange={e => d.setBackend(e.target.value as 'uia' | 'win32')}><option value="uia">UIA</option><option value="win32">Win32</option></select>
            <button className="primary" disabled={!!d.busy || !d.ready} onClick={() => void (d.capturing ? d.cancelCapture() : d.startCapture())}><Crosshair size={15}/>{d.capturing ? '取消捕获' : '开始捕获'}</button>
            <button disabled={locked} onClick={() => void d.check()}><RefreshCw size={14}/>检测环境</button>
            <button disabled={locked || !d.ready} onClick={() => void d.importFile()}><Upload size={14}/>导入 JSON</button></div>
        <p className="desktop-help">开始捕获后，鼠标悬停显示控件红框；Ctrl + 鼠标左键锁定，Esc 取消。校验只查询和高亮。</p>
        <p className={'environment-status ' + (d.ready ? 'success' : '')}>{d.status}</p>
        {d.error && <div className="message error" role="alert"><span><strong>{d.error.kind}</strong> · {d.error.message}</span><button aria-label="关闭错误" onClick={() => d.setError(null)}><X size={14}/></button></div>}
        {d.warning && <div className="message warning">捕获提示：{d.warning}</div>}
        {d.notice && <p className="desktop-notice" role="status">{d.notice}</p>}
        {!draft ? <div className="desktop-empty"><Crosshair size={30}/><h3>捕获一个桌面控件</h3><p>从窗口树选择控件，或直接捕获企业微信等软件的界面元素。</p></div> : <>
            <label className="desktop-name">元素名称<input aria-label="元素名称" value={draft.name} disabled={locked} onChange={e => d.updateDraft({...draft, name: e.target.value})}/></label>
            <section className="desktop-locator-group"><h3>窗口条件</h3><Conditions rows={draft.window} disabled={locked} onChange={window => d.updateDraft({...draft, window})}/></section>
            <section className="desktop-locator-group"><h3>元素路径 <span>{draft.path.length} 层</span></h3><p className="desktop-help">每层在上一层的后代中查找；移除多余祖先后请重新校验。路径为空时定位窗口本身。</p>
                {draft.path.map((rows, index) => <div className="desktop-path-step" key={index}><div className="section-title"><h4>{index === draft.path.length - 1 ? '目标控件' : '祖先范围'} · {index + 1}</h4><button disabled={locked} title="移除此层" onClick={() => d.updateDraft({...draft, path: draft.path.filter((_, i) => i !== index)})}><X size={12}/>移除</button></div><Conditions rows={rows} disabled={locked} onChange={next => d.updateDraft({...draft, path: draft.path.map((item, i) => i === index ? next : item)})}/></div>)}
            </section>
            {d.draftError && <p className="desktop-validation-error">{d.draftError}</p>}
            <div className="desktop-toolbar"><button className="primary" disabled={locked || !d.ready || !d.locator} onClick={() => void d.validate()}>校验并高亮</button><span className="count">{d.result ? d.result.total === 0 ? '未匹配 · 0 个' : d.result.total === 1 ? '唯一匹配' : '多个匹配 · ' + d.result.total + ' 个' : '未校验'}</span></div>
            {d.result && <div className="desktop-results">{d.result.matches.map((item, index) => <button key={index} disabled={locked} onClick={() => void d.selectResult(item)}><span>{index + 1}</span><strong>{label(item)}</strong><small>{item.class_name} · {item.visible ? '可见' : '隐藏'} · {item.enabled ? '启用' : '禁用'}</small></button>)}{d.result.truncated && <p>共 {d.result.total} 个匹配，仅列出前 200 个。</p>}</div>}
            <div className="section-title desktop-output-heading"><h3>Python / Locator JSON</h3><div className="desktop-toolbar"><button disabled={locked || !d.locator} onClick={() => void d.copyCode()}><Copy size={13}/>{d.copied ? '已复制' : '复制 Python'}</button><button disabled={locked || !d.ready || !d.locator} onClick={() => void d.exportFile()}><Download size={13}/>导出 JSON</button></div></div>
            <pre className="desktop-code">{d.code || '补全有效条件后生成代码'}</pre><details><summary>定位文件预览</summary><pre className="desktop-code">{d.locator ? JSON.stringify(d.locator, null, 2) : d.draftError}</pre></details>
        </>}
    </div>;
}
export function DesktopDetails({d}: {d: DesktopController}) {
    const item = d.selected, r = item?.rectangle;
    return <><div className="pane-heading"><h2>桌面元素属性</h2><span className="count">{d.backend.toUpperCase()}</span></div><div className="desktop-properties">
        {!item ? <p className="small-empty">捕获控件或选择匹配结果后查看实际属性。</p> : <><strong className="desktop-property-title">{label(item)}</strong><p className="desktop-state">{item.visible ? '可见' : '隐藏'} · {item.enabled ? '启用' : '禁用'}{item.checked !== null ? ' · 勾选：' + String(item.checked) : ''}</p>
            <dl className="attribute-list">{Object.entries(item).filter(([key]) => !['rectangle', 'token', 'visible', 'enabled', 'checked'].includes(key)).map(([key, value]) => <div key={key}><dt>{key}</dt><dd title={String(value ?? '')}>{String(value ?? '（无）') || '（空）'}</dd></div>)}{r && <><div><dt>位置</dt><dd>{r.left}, {r.top}</dd></div><div><dt>尺寸</dt><dd>{r.right - r.left} × {r.bottom - r.top}</dd></div></>}</dl><p className="desktop-help">PID、句柄和坐标仅用于当前诊断。唯一匹配后仍需核对高亮是否为预期控件。</p></>}
        </div><div className="desktop-history"><div className="pane-heading"><h2>捕获历史</h2><span className="count">{d.history.length} / 30</span></div>{!d.history.length ? <p className="small-empty">会话内保留最近 30 条及编辑状态</p> : [...d.history].reverse().map(record => <button key={record.id} disabled={!!d.busy || d.capturing} className={d.historyId === record.id ? 'selected' : ''} onClick={() => d.restoreHistory(record)}><strong>{record.draft.name || label(record.capture.element)}</strong><small>{record.backend.toUpperCase()} · {record.capturedAt}</small></button>)}</div></>;
}
