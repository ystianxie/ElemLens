import {useState} from 'react';
import {
    AlertTriangle,
    Check,
    ChevronRight,
    Clock3,
    Copy,
    Circle,
    LoaderCircle,
    Pause,
    Play,
    Square,
    Trash2,
    X
} from 'lucide-react';
import {DpLocatorBuilder} from './DpLocatorBuilder';
import {dpQuickLocator} from './codegen';
import {recordingCode, recordingStepName, validationLabels} from './recording';
import type {Recorder} from './useRecording';
import './recording.css';

const validationIcons = {
    unverified: Circle,
    unique: Check,
    multiple: AlertTriangle,
    missing: X,
    error: X,
    stale: Clock3,
    validating: LoaderCircle
};

export function RecordingPanel({recorder: r, connected, disabled}: {
    recorder: Recorder;
    connected: boolean;
    disabled: boolean
}) {
    const [copyMessage, setCopyMessage] = useState('');
    const [codeExpanded, setCodeExpanded] = useState(false);
    const [withSteps, setWithSteps] = useState(false);
    const generated = recordingCode(r.steps, withSteps);
    const active = r.phase === 'recording' || r.phase === 'paused';
    const locked = disabled || r.pending;
    const labels = {idle: '尚未开始', recording: '录制中', paused: '已暂停', finished: '已结束'};

    async function copy() {
        try {
            await navigator.clipboard.writeText(generated.code);
            setCopyMessage('已复制');
        } catch (e) {
            setCopyMessage('复制失败：' + String(e));
        }
    }

    return <div className="recording-panel">
        <div className="recording-toolbar">
            {!active ? <button className="primary" disabled={locked || !connected || !r.ready || !r.sameSource}
                               onClick={() => void r.control('start').catch(() => {
                               })}><Circle size={14}/>{r.steps.length ? '继续录制' : '开始录制'}</button> :
                <button disabled={locked || !connected}
                        onClick={() => void r.control(r.phase === 'paused' ? 'resume' : 'pause').catch(() => {
                        })}>
                    {r.phase === 'paused' ? <Play size={14}/> :
                        <Pause size={14}/>}{r.phase === 'paused' ? '恢复录制' : '暂停'}</button>}
            <button disabled={locked || !active} onClick={() => void r.control('stop').catch(() => {
            })}><Square size={14}/>结束
            </button>
            <button disabled={locked || active || !r.steps.length} onClick={() => {
                r.clear();
                setCopyMessage('');
            }}><Trash2 size={14}/>清空
            </button>
            <span className={'recording-status ' + r.phase}><Circle size={9}
                fill="currentColor"/>{labels[r.phase]}</span>
            <span className="recording-count">{r.steps.length} 步</span>
        </div>

        <p className="recording-hint">暂不支持下拉选项、勾选状态、上传、拖拽、富文本、键盘快捷键及新标签页。结果仅保留在本次应用会话中。</p>
        {r.source.target &&
            <p className="recording-page" title={r.source.url}>录制页面：{r.source.title || r.source.url}</p>}
        {!r.sameSource && <p className="recording-warning">已有其他标签页的步骤，请先复制并清空，再录制当前标签页。</p>}
        {r.error && <p className="recording-error" role="alert">{r.error}</p>}
        {r.warning && <p className="recording-warning" role="status">{r.warning}</p>}
        <div className="section-title"><h3>操作步骤 <span className="count">{r.steps.length}</span></h3><span
            className="recording-unverified">{r.steps.filter(step => step.validation?.status === 'unique').length} 步唯一匹配</span>
        </div>
        {!r.steps.length ? <div className="recording-empty"><Circle size={30}/><strong>录制你的操作流程</strong>
                <p>选择左侧网页，开始录制后在浏览器中点击和输入。</p></div> :
            <ol className="recording-steps" aria-label="录制步骤">{r.steps.map((step, index) => {
                const status = r.validatingId === step.id ? 'validating' : step.validation?.status ?? 'unverified';
                const statusLabel = status === 'validating' ? '正在校验…' : step.validation ? validationLabels[step.validation.status] : '未校验';
                const name = `${step.action === 'click' ? '点击' : '输入'} · ${recordingStepName(step, Infinity)}`;
                const StatusIcon = validationIcons[status];
                return <li key={step.id} className={`${status}${r.selectedId === step.id ? ' selected' : ''}`}>
                    <button className="recording-step" onClick={() => r.select(step.id)}
                            aria-pressed={r.selectedId === step.id}
                            aria-label={`第 ${index + 1} 步，${name}，${statusLabel}`}
                            title={`${index + 1}. ${name}\n${statusLabel}`}>
                        <span className="recording-step-number">{index + 1}</span>
                        <strong>{name}</strong><StatusIcon className="recording-step-status" size={13}
                                                           aria-hidden="true"/>
                    </button>
                    <button className="recording-step-delete icon-button" aria-label={`删除第 ${index + 1} 步`}
                            title={`删除第 ${index + 1} 步`} disabled={locked || active}
                            onClick={() => r.remove(step.id)}><Trash2 size={12}/></button>
                </li>;
            })}</ol>}
        <div className="recording-code-title">
            <button className="recording-code-toggle" aria-expanded={codeExpanded} aria-controls="recording-code"
                    onClick={() => setCodeExpanded(previous => !previous)}><ChevronRight size={14}
                                                                                         className={codeExpanded ? 'expanded' : ''}/>DP
                代码
            </button>
            <label className="recording-code-option"><input type="checkbox" checked={withSteps}
                onChange={event => {
                    setWithSteps(event.target.checked);
                    setCopyMessage('');
                }}/>步骤</label>
            <button disabled={locked || !generated.code || !!generated.errors.length}
                    onClick={() => void copy()}>{copyMessage === '已复制' ? <Check size={14}/> : <Copy size={14}/>}复制全部
            </button>
        </div>
        {generated.errors.map(error => <p className="recording-error" key={error}>{error}</p>)}
        {copyMessage && <p className="recording-hint" role="status">{copyMessage}</p>}
        {codeExpanded && <pre id="recording-code"
                              className="recording-code"><code>{generated.code || '# 开始录制后，代码会显示在这里。'}</code></pre>}
    </div>;
}

export function RecordingDetails({recorder: r, disabled, pythonReady, connected, capturing}: {
    recorder: Recorder;
    disabled: boolean;
    pythonReady: boolean;
    connected: boolean;
    capturing: boolean
}) {
    const step = r.selected;
    const locked = disabled || r.pending || r.phase === 'recording' || r.phase === 'paused';
    if (!step) return <>
        <div className="pane-heading"><h2>录制步骤详情</h2></div>
        <div className="details-empty"><strong>选择一条操作</strong>
            <p>查看元素快照，结束录制后可编辑定位条件和输入内容。</p></div>
    </>;
    return <div className="recording-details">
        <div className="pane-heading"><h2>第 {r.steps.indexOf(step) + 1} 步
            · {step.action === 'click' ? '点击' : '输入'}</h2></div>
        <div className="details-content recording-details-body">
            <div className="element-tag"><code>&lt;{step.element.tag}&gt;</code><span
                className="recording-unverified">录制快照</span></div>
            <p className="recording-page" title={step.pageUrl}>{step.pageTitle || step.pageUrl}</p>
            <p className="recording-hint">{step.pageUrl}</p>
            <p className="recording-hint">上下文：{step.context.steps.length ? step.context.steps.map(item => item.kind === 'frame' ? 'iframe' : 'Shadow Root').join(' › ') : '顶层文档'}</p>
            {locked && <p className="recording-hint">结束录制后可修改或删除步骤。</p>}
            {step.action === 'input' && <label className="recording-field">输入内容（替换原值）
                {step.sensitive ? <p className="recording-hint">使用 password 变量，原始密码不保存。</p> :
                    <textarea aria-label="录制步骤输入内容" rows={3} value={step.editedValue ?? step.value ?? ''}
                              disabled={locked}
                              onChange={e => r.update(step.id, {editedValue: e.target.value})}/>}
            </label>}
            <div className="mode-tabs">{(['DP', 'CSS', 'XPath'] as const).map(mode => <button key={mode}
                                                                                              className={step.mode === mode ? 'active' : ''}
                                                                                              disabled={locked}
                                                                                              onClick={() => r.update(step.id, {
                                                                                                  mode,
                                                                                                  expression: mode === 'DP' ? dpQuickLocator(step.dpConditions).expression : mode === 'CSS' ? step.element.css : step.element.xpath
                                                                                              })}>{mode}</button>)}</div>
            {step.mode === 'DP' &&
                <DpLocatorBuilder recordLabel="当前录制步骤" rows={step.dpConditions} expression={step.expression}
                                  truncated={!!step.element.locatorTextTruncated} disabled={locked}
                                  onChange={rows => r.update(step.id, {
                                      dpConditions: rows,
                                      expression: dpQuickLocator(rows).expression
                                  })}/>}
            <label className="recording-field">定位表达式<textarea rows={4} aria-label="录制步骤定位表达式"
                                                                   spellCheck={false} value={step.expression}
                                                                   disabled={locked}
                                                                   onChange={e => r.update(step.id, {expression: e.target.value})}/></label>
            <div className="recording-validation">
                <div className="recording-validation-actions">
                    <button className="primary" disabled={disabled || !r.canValidate || !step.expression.trim()}
                            onClick={() => void r.validate(step.id)}><Play
                        size={13}/>{r.validatingId === step.id ? '正在校验…' : '校验并高亮'}</button>
                    <button disabled={r.steps.indexOf(step) === r.steps.length - 1}
                            onClick={() => r.select(r.steps[r.steps.indexOf(step) + 1].id)}>下一步
                    </button>
                </div>
                <p className="recording-hint">在当前网页按录制的上下文路径查找元素。请手动将网页切换到这一步对应的状态。</p>
                {!connected ? <p className="recording-warning">请连接并选择录制来源标签页。</p> : !r.sameSource ?
                    <p className="recording-warning">请选择录制来源标签页后再校验。</p> :
                    !pythonReady ?
                        <p className="recording-warning">请在设置中配置并检测 Python / DrissionPage 环境。</p> :
                        r.phase === 'recording' ?
                            <p className="recording-hint">暂停或结束录制后可校验。</p> : capturing ?
                                <p className="recording-hint">请先停止元素捕获再校验。</p> : null}
                {step.validation &&
                    <div className={'recording-validation-result ' + step.validation.status} role="status">
                        <strong>{validationLabels[step.validation.status]}</strong><p>{step.validation.message}</p>
                        <small>{new Date(step.validation.checkedAt).toLocaleTimeString()} · {step.validation.result?.engine ?? '定位校验'}</small>
                        {step.validation.pageUrl &&
                            <p className="recording-hint">校验页面：{step.validation.pageUrl}</p>}
                    </div>}
                {step.validation?.result && step.validation.status !== 'stale' && step.validation.status !== 'error' &&
                    <div className="recording-matches">{step.validation.result.matches.map((element, index) => <button
                        key={element.token}
                        disabled={disabled || !r.canValidate} title="滚动并高亮此匹配元素"
                        onClick={() => void r.highlightMatch(step.id, element.token)}>
                        <span>{index + 1}. &lt;{element.tag}&gt;{element.attributes.id ? '#' + element.attributes.id : ''}</span>
                        <small>{element.text || element.attributes.placeholder || element.attributes.name || element.css}</small>
                        <small>{element.inViewport ? '视口内' : element.visible ? '视口外' : '隐藏'}</small>
                    </button>)}{step.validation.result.truncated &&
                        <p className="recording-hint">共 {step.validation.result.total} 个匹配，仅展示及高亮前 200
                            个。</p>}</div>}
            </div>
            <label className="detail-label">录制时的文本</label><p
            className="recording-snapshot-text">{step.element.text || '（无文本）'}</p>
            <label className="detail-label">录制时的属性</label>
            <dl className="attribute-list">{Object.entries(step.element.attributes).map(([name, value]) =>
                <div key={name}>
                    <dt>{name}</dt>
                    <dd title={value}>{value || '""'}</dd>
                </div>)}</dl>
            <p className="recording-hint">校验仅确认当前页面的定位匹配情况，不执行录制动作。唯一匹配仍需核对是否为目标元素。</p>
        </div>
    </div>;
}
