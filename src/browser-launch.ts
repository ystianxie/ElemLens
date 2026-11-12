import {invoke} from '@tauri-apps/api/core';

export function launchBrowser(browser: string, address: string): Promise<string> {
    const match = address.trim().match(/^(?:(?:http:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):)?(\d+)\/?$/i);
    const parsed = match ? Number(match[1]) : 0;
    const port = parsed >= 1 && parsed <= 65535 ? parsed : null;
    return invoke<string>('launch_browser', {browser, port});
}
