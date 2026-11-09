import {describe, expect, it} from 'vitest';
import {appendCapture, CAPTURE_HISTORY_LIMIT, isLiveCapture, saveCaptureConditions, type CaptureRecord} from './capture-history';
import {defaultDpConditions, dpQuickLocator} from './codegen';
import type {Capture} from './types';

const source = {endpoint: '127.0.0.1:9222', target: 'tab-1', generation: 4};
function record(id: number): CaptureRecord {
    const capture: Capture = {
        context: {sessionId: 'session', contextId: 1, frameId: 'frame', documentToken: 'document', steps: []},
        element: {token: 'button', tag: 'button', text: '保存', attributes: {id: 'save'}, css: '#save', xpath: '//*[@id="save"]', visible: true, inViewport: true}
    };
    return {
        id, capturedAt: 1000 + id, source: {...source}, pageTitle: '测试页', pageUrl: 'https://example.test',
        capture, dpConditions: defaultDpConditions(capture.element)
    };
}

describe('捕获历史的保留与上下文隔离', () => {
    it('保留最近 30 次捕获，新的排在前面，回看不会改变原捕获内容', () => {
        let history: CaptureRecord[] = [];
        const first = record(1);
        history = appendCapture(history, first);
        const original = history;
        for (let id = 2; id <= 35; id++) history = appendCapture(history, record(id));
        expect(history).toHaveLength(CAPTURE_HISTORY_LIMIT);
        expect(history.map(item => item.id)).toEqual(Array.from({length: 30}, (_, i) => 35 - i));
        expect(original).toEqual([first]);
        expect(first.capture.element.attributes).toEqual({id: 'save'});
    });
    it('同一个元素再次捕获仍是一条新记录', () => {
        const first = record(1), second = record(2);
        expect(appendCapture([first], second)).toEqual([second, first]);
    });
    it('同一次页面连接中的记录可以继续用于校验', () => {
        expect(isLiveCapture(record(1), source)).toBe(true);
    });
    it.each([
        {...source, generation: 5},
        {...source, target: 'tab-2'},
        {...source, endpoint: '127.0.0.1:9333'},
        {endpoint: '', target: '', generation: 5}
    ])('页面刷新、切换标签页、浏览器或断开后仅保留快照：%j', next => {
        expect(isLiveCapture(record(1), next)).toBe(false);
    });
});

describe('历史记录中的 DP 编辑', () => {
    it('来回切换时保留各自的勾选、运算符和值，且不改变捕获顺序或原始元素', () => {
        const first = record(1), second = record(2);
        const original = [second, first];
        const rows = first.dpConditions.map(row => row.kind === 'text'
            ? {...row, checked: true, operator: '^' as const, value: '确认'}
            : row.kind === 'attribute' ? {...row, checked: false} : row);
        const saved = saveCaptureConditions(original, first.id, rows);
        const secondRows = second.dpConditions.map(row => row.kind === 'attribute' ? {...row, value: 'submit'} : row);
        const history = saveCaptureConditions(saved, second.id, secondRows);
        expect(history.map(item => item.id)).toEqual([2, 1]);
        expect(dpQuickLocator(history[1].dpConditions).expression).toBe('tag:button@@text()^确认');
        expect(dpQuickLocator(history[0].dpConditions).expression).toBe('tag:button@@id=submit');
        expect(original[1].dpConditions.find(row => row.kind === 'attribute')?.checked).toBe(true);
        expect(history[1].capture).toBe(first.capture);
        expect(history[1].capture.element.text).toBe('保存');
        expect(history[1].source).toBe(first.source);
    });
    it('未勾选任何条件以及尚未填完的值也能保存，不会回退到默认条件', () => {
        const first = record(1);
        const unchecked = first.dpConditions.map(row => ({...row, checked: false}));
        const history = saveCaptureConditions([first], first.id, unchecked);
        expect(dpQuickLocator(history[0].dpConditions).expression).toBe('');
        const incomplete = unchecked.map(row => row.kind === 'text' ? {...row, checked: true, value: ''} : row);
        const saved = saveCaptureConditions(history, first.id, incomplete)[0];
        expect(saved.dpConditions).toEqual(incomplete);
        expect(dpQuickLocator(saved.dpConditions).errors.length).toBeGreaterThan(0);
        expect(isLiveCapture(saved, {...source, generation: source.generation + 1})).toBe(false);
    });
    it('编辑已经不在历史中的记录不会重新插入或修改其他记录', () => {
        const remaining = record(2);
        expect(saveCaptureConditions([remaining], 1, [])).toEqual([remaining]);
    });
});
