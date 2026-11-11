import {describe, expect, it} from 'vitest';
import {appendDesktopHistory, buildDesktopLocator, desktopCode, draftFromCapture, draftFromLocator, type DesktopCapture, type DesktopLocator, type DesktopHistory} from './desktop-model';
const locator: DesktopLocator = {version: 1, backend: 'uia', name: '搜索', window: {process_name: 'WXWork.exe', title_re: '^企业微信'}, path: [{auto_id: '101', control_type: 'Edit'}], metadata: {verified: false, value: null, text: '中文"\\\n'}};
describe('desktop locator editing', () => {
    it('preserves locator format, regex, metadata and numeric IDs through editing', () => {
        expect(buildDesktopLocator(draftFromLocator(locator), 'uia').locator).toEqual(locator);
        const win32 = {...locator, backend: 'win32' as const, path: [{control_id: 101}]};
        expect(buildDesktopLocator(draftFromLocator(win32), 'win32').locator).toEqual(win32);
    });
    it('rejects empty scope, missing selected values, invalid numeric IDs and backend mismatch', () => {
        const draft = draftFromLocator(locator);
        draft.window.forEach(row => row.checked = false);
        expect(buildDesktopLocator(draft, 'uia').error).toContain('窗口');
        expect(buildDesktopLocator(draftFromLocator(locator), 'win32').error).toContain('Win32');
        const numeric = draftFromLocator({...locator, backend: 'win32', path: [{control_id: 1}]});
        numeric.path[0][0].value = '1.2';
        expect(buildDesktopLocator(numeric, 'win32').error).toContain('非负整数');
    });
    it('generates Python literals rather than embedding JSON booleans/null as code', () => {
        const code = desktopCode(locator);
        expect(code).toContain('False'); expect(code).toContain('None');
        expect(code).toContain('desktop.ele(locator)'); expect(code).not.toContain('.click(');
        expect(code).toContain('"中文\\"');
    });
    it('keeps partial capture properties editable without generating a window-only locator', () => {
        const root = {title: 'App', class_name: 'Window', process_name: 'app.exe', token: '1'};
        const leaf = {title: 'Target', control_type: 'Button', auto_id: 'target', token: '2'};
        const capture = {element: leaf, window: root, ancestry: [root, leaf], locator: null,
            warning: '父级链出现重复控件标识'} as DesktopCapture;
        const draft = draftFromCapture(capture, 'uia');
        expect(draft.name).toBe('Target');
        expect(draft.path).toHaveLength(1);
        expect(draft.path[0].find(row => row.field === 'auto_id')?.value).toBe('target');
        expect(buildDesktopLocator(draft, 'uia').locator).toBeNull();
    });
    it('keeps the newest 30 captures', () => {
        let records: DesktopHistory[] = [];
        for (let id = 0; id < 35; id++) records = appendDesktopHistory(records, {id} as DesktopHistory);
        expect(records).toHaveLength(30); expect(records[0].id).toBe(5);
    });
});
