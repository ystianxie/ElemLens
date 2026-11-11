import {beforeEach, describe, expect, it, vi} from 'vitest';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {hideCaptureWindow, previewWithHiddenWindow} from './capture-window';
vi.mock('@tauri-apps/api/core', () => ({invoke: vi.fn(), isTauri: vi.fn()}));
const command = vi.mocked(invoke);
beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isTauri).mockReturnValue(true);
    command.mockResolvedValue(undefined);
});
describe('capture window lifecycle', () => {
    it('does not operate the window when disabled or outside Tauri', async () => {
        await (await hideCaptureWindow(false))();
        vi.mocked(isTauri).mockReturnValue(false);
        expect(await previewWithHiddenWindow(true, async () => 'preview')).toBe('preview');
        expect(command).not.toHaveBeenCalled();
    });
    it('keeps capture minimized until completion or cancellation explicitly restores it', async () => {
        const restore = await hideCaptureWindow(true);
        expect(command.mock.calls).toEqual([['minimize_capture_window', {session: expect.any(String)}]]);
        const session = (command.mock.calls[0][1] as {session: string}).session;
        await restore();
        expect(command).toHaveBeenLastCalledWith('restore_capture_window', {session, delayMs: 0});
    });
    it('minimizes before a preview and requests restoration five seconds after it finishes', async () => {
        const task = vi.fn(async () => {
            expect(command.mock.calls.map(call => call[0])).toEqual(['minimize_capture_window']);
            return 'matched';
        });
        expect(await previewWithHiddenWindow(true, task)).toBe('matched');
        expect(command).toHaveBeenLastCalledWith('restore_capture_window', {session: expect.any(String), delayMs: 5000});
    });
    it('restores immediately when query or highlight fails', async () => {
        await expect(previewWithHiddenWindow(true, async () => { throw Error('element expired'); })).rejects.toThrow('element expired');
        expect(command).toHaveBeenLastCalledWith('restore_capture_window', {session: expect.any(String), delayMs: 0});
    });
    it('waits for native minimization and restoration', async () => {
        let minimize!: () => void, restore!: () => void;
        command.mockImplementationOnce(() => new Promise<void>(resolve => { minimize = resolve; }))
            .mockImplementationOnce(() => new Promise<void>(resolve => { restore = resolve; }));
        const task = vi.fn(async () => 1);
        let finished = false;
        const preview = previewWithHiddenWindow(true, task).then(() => { finished = true; });
        expect(task).not.toHaveBeenCalled();
        minimize();
        await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(2));
        expect(task).toHaveBeenCalledOnce();
        expect(finished).toBe(false);
        restore(); await preview;
        expect(finished).toBe(true);
    });
    it('uses distinct owners so an earlier delayed restoration can be ignored by native code', async () => {
        const first = await hideCaptureWindow(true);
        const second = await hideCaptureWindow(true);
        const firstSession = (command.mock.calls[0][1] as {session: string}).session;
        const secondSession = (command.mock.calls[1][1] as {session: string}).session;
        expect(firstSession).not.toBe(secondSession);
        await first(5000); await second();
        expect(command.mock.calls.slice(2)).toEqual([
            ['restore_capture_window', {session: firstSession, delayMs: 5000}],
            ['restore_capture_window', {session: secondSession, delayMs: 0}],
        ]);
    });
    it('does not execute the target operation if minimizing fails', async () => {
        command.mockRejectedValueOnce(Error('window failure'));
        const task = vi.fn();
        await expect(previewWithHiddenWindow(true, task)).rejects.toThrow('window failure');
        expect(task).not.toHaveBeenCalled();
    });
});
