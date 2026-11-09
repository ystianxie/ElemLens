export type NetworkOptions = { targets: string[]; count: number | null; timeout: number | null; fitCount: boolean; method: string };
export type NetworkPacket = { index: number; capturedAt: number; targets: string[]; url: string; method: string; status: number | null; failed: boolean; error: string; responseType: string; responseText: string | null; responseError: string };
export type NetworkSummary = { reason: 'complete' | 'timeout' | 'stopped'; total?: number; accepted?: boolean; metCount?: boolean; elapsed?: number };
export function networkOptions(keywords: string, continuous: boolean, count: string, timeout: string, fitCount: boolean, method: string): NetworkOptions {
    const targets = [...new Set(keywords.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
    if (!targets.length) throw Error('请至少填写一个 URL 关键词，一行一个');
    const amount = Number(count);
    const seconds = timeout.trim() ? Number(timeout) : null;
    if (!continuous && (!Number.isSafeInteger(amount) || amount < 1 || amount > 4294967295)) throw Error('捕获条数必须为正整数');
    if (!continuous && seconds !== null && (!Number.isFinite(seconds) || seconds <= 0)) throw Error('超时必须为正数，留空表示不限');
    return { targets, count: continuous ? null : amount, timeout: continuous ? null : seconds, fitCount, method };
}
export function networkSummary(summary: NetworkSummary, count: number | null): string {
    if (summary.reason === 'stopped') return '已手动结束监听，已捕获的结果已保留';
    if (summary.reason === 'complete') return '已满足捕获条数，监听自动结束';
    if (!summary.total) return '等待超时：本次监听期间未捕获到符合条件的数据包';
    if (summary.accepted) return '等待超时：已按 fit_count 设置接受部分结果';
    return '等待超时：已捕获 ' + summary.total + '/' + count + ' 条，未满足条数要求；已捕获的结果仍可查看';
}
