import {useEffect, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {RefreshCw} from 'lucide-react';
import type {Context, ElementGeometry, ElementInfo} from './types';
import './element-geometry.css';

const number = new Intl.NumberFormat('en-US', {maximumFractionDigits: 2, useGrouping: false});
const format = (value: number) => number.format(Math.abs(value) < 0.005 ? 0 : value);

export function ElementGeometryPanel({context, element}: {context: Context | null; element: ElementInfo}) {
    const [geometry, setGeometry] = useState<ElementGeometry | null>(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [revision, setRevision] = useState(0);
    useEffect(() => {
        let cancelled = false;
        setGeometry(null);
        setError('');
        if (!context || !('__TAURI_INTERNALS__' in window)) {
            setLoading(false);
            setError('连接浏览器并捕获元素后可查看');
            return;
        }
        setLoading(true);
        invoke<ElementGeometry>('element_geometry', {context, token: element.token})
            .then(value => { if (!cancelled) setGeometry(value); })
            .catch(reason => { if (!cancelled) setError(String(reason)); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [context, element, revision]);
    return <section className="element-geometry" aria-label="元素位置与尺寸" aria-busy={loading}>
        <div className="geometry-heading"><span className="detail-label">位置与尺寸</span>
            <button className="icon-button" disabled={loading || !context} title="刷新元素位置与尺寸"
                    aria-label="刷新元素位置与尺寸" onClick={() => setRevision(value => value + 1)}>
                <RefreshCw size={13}/>
            </button>
        </div>
        <dl className="geometry-values">
            <div><dt title="[左, 上, 右, 下]，包含元素边框的外接矩形">BBox</dt>
                <dd>{geometry ? `[${[geometry.x, geometry.y, geometry.x + geometry.width, geometry.y + geometry.height].map(format).join(', ')}]` : '—'}</dd></div>
            <div><dt>尺寸 W × H</dt><dd>{geometry ? `${format(geometry.width)} × ${format(geometry.height)}` : '—'}</dd></div>
            <div><dt>中心 (X, Y)</dt><dd>{geometry ? `(${format(geometry.centerX)}, ${format(geometry.centerY)})` : '—'}</dd></div>
        </dl>
        <p className="geometry-note">页面可视区左上角为 (0, 0)，单位 CSS px。<br/>BBox 为 [左, 上, 右, 下]；滚动或布局变化后点刷新。</p>
        {(loading || error) && <p className={'geometry-status' + (error ? ' failed' : '')} role="status">{loading ? '正在读取元素位置…' : error}</p>}
    </section>;
}
