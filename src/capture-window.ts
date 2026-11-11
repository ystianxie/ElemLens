import {invoke, isTauri} from '@tauri-apps/api/core';

export type RestoreCaptureWindow = (delayMs?: number) => Promise<void>;
export async function hideCaptureWindow(enabled: boolean): Promise<RestoreCaptureWindow> {
    if (!enabled || !isTauri()) return async () => {};
    const session = crypto.randomUUID();
    await invoke('minimize_capture_window', {session});
    return async (delayMs = 0) => { await invoke('restore_capture_window', {session, delayMs}); };
}

export async function previewWithHiddenWindow<T>(enabled: boolean, task: () => Promise<T>): Promise<T> {
    const restore = await hideCaptureWindow(enabled);
    let delayMs = 0;
    try {
        const result = await task();
        delayMs = 5000;
        return result;
    } finally {
        await restore(delayMs);
    }
}
