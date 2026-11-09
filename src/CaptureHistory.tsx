import {useState} from 'react';
import {ChevronRight, History} from 'lucide-react';
import {CAPTURE_HISTORY_LIMIT, isLiveCapture, type CaptureRecord, type CaptureSource} from './capture-history';
import './capture-history.css';

const time = new Intl.DateTimeFormat('zh-CN', {hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false});

export function CaptureHistory({records, source, selectedId, disabled, onSelect}: {
    records: CaptureRecord[];
    source: CaptureSource;
    selectedId?: number;
    disabled: boolean;
    onSelect: (record: CaptureRecord) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    return <section className="capture-history" aria-label="捕获历史">
        <button className="capture-history-toggle" aria-expanded={expanded} aria-controls="capture-history-list"
                onClick={() => setExpanded(value => !value)}>
            <History size={14}/><span>捕获历史</span><span className="count">{records.length}</span>
            <ChevronRight size={14} className={expanded ? 'expanded' : ''}/>
        </button>
        <div id="capture-history-list" hidden={!expanded}>
            <p className="capture-history-hint">本次会话最近 {CAPTURE_HISTORY_LIMIT} 条 · 点击回看</p>
            {records.length === 0 ? <p className="capture-history-empty">暂无捕获记录，捕获元素后会自动记录。</p> :
                <ol className="capture-history-list">{records.map(record => {
                    const element = record.capture.element;
                    const summary = element.text.replace(/\s+/g, ' ').trim() || element.attributes['aria-label'] ||
                        element.attributes.placeholder || element.attributes.id || '（无文本）';
                    const live = isLiveCapture(record, source);
                    return <li key={record.id}>
                        <button className={'capture-history-item' + (selectedId === record.id ? ' selected' : '')}
                                aria-pressed={selectedId === record.id} disabled={disabled}
                                title={[summary, record.pageTitle, record.pageUrl, live ? '点击恢复定位表达式' : '历史快照，仅供回看和复制'].filter(Boolean).join('\n')}
                                onClick={() => onSelect(record)}>
                            <span className="capture-history-meta"><code>&lt;{element.tag}&gt;</code>
                                <time dateTime={new Date(record.capturedAt).toISOString()}>{time.format(record.capturedAt)}</time>
                            </span>
                            <span className="capture-history-summary">{summary}</span>
                            <span className="capture-history-source"><span>{record.pageTitle || record.pageUrl || record.source.endpoint}</span>
                                {!live && <span className="capture-history-snapshot">快照</span>}</span>
                        </button>
                    </li>;
                })}</ol>}
        </div>
    </section>;
}
