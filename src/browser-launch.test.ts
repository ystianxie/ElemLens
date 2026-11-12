import {beforeEach, describe, expect, it, vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import {launchBrowser} from './browser-launch';

vi.mock('@tauri-apps/api/core', () => ({invoke: vi.fn()}));
const command = vi.mocked(invoke);
beforeEach(() => {
    vi.resetAllMocks();
    command.mockResolvedValue('http://127.0.0.1:8222');
});

describe('browser launch CDP port', () => {
    it.each([
        ['8222', 8222],
        ['127.0.0.1:9333', 9333],
        ['http://127.0.0.1:9222', 9222],
        [' http://localhost:9321/ ', 9321],
        ['http://[::1]:9223/', 9223],
        ['HTTP://LOCALHOST:9224', 9224],
        ['http://localhost:80', 80],
        ['1', 1],
        ['65535', 65535],
    ])('passes the recognized port from %s to the launcher', async (address, port) => {
        expect(await launchBrowser('chrome.exe', address)).toBe('http://127.0.0.1:8222');
        expect(command).toHaveBeenCalledExactlyOnceWith('launch_browser', {browser: 'chrome.exe', port});
    });

    it.each(['', '  ', 'localhost', 'http://127.0.0.1', 'garbage', '0', '-1', '65536',
        'localhost:nope', 'http://example.com:9222', 'http://localhost:9222/path',
        'http://localhost:9222?query=1', 'http://localhost:9222#fragment', 'http://user@localhost:9222'])
    ('requests a random port when %s has no recognized local CDP port', async address => {
        await launchBrowser('edge.exe', address);
        expect(command).toHaveBeenCalledExactlyOnceWith('launch_browser', {browser: 'edge.exe', port: null});
    });

    it('propagates a launch error without retrying a different port', async () => {
        command.mockRejectedValueOnce(Error('CDP port 8222 is occupied'));
        await expect(launchBrowser('chrome.exe', '8222')).rejects.toThrow('8222');
        expect(command).toHaveBeenCalledTimes(1);
    });
});
