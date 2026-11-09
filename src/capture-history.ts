import type {Capture} from './types';
import type {DpCondition} from './codegen';

export const CAPTURE_HISTORY_LIMIT = 30;
export type CaptureSource = {endpoint: string; target: string; generation: number};
export type CaptureRecord = {
    id: number;
    capturedAt: number;
    source: CaptureSource;
    pageTitle: string;
    pageUrl: string;
    capture: Capture;
    dpConditions: DpCondition[];
};

export function appendCapture(history: CaptureRecord[], record: CaptureRecord): CaptureRecord[] {
    return [record, ...history].slice(0, CAPTURE_HISTORY_LIMIT);
}

export function saveCaptureConditions(history: CaptureRecord[], id: number, rows: DpCondition[]): CaptureRecord[] {
    return history.map(record => record.id === id ? {...record, dpConditions: rows} : record);
}

// A browser/tab connection or document invalidation changes the generation.
// Old element handles must never be used against the newly selected document.
export function isLiveCapture(record: CaptureRecord, source: CaptureSource): boolean {
    return record.source.generation === source.generation &&
        record.source.endpoint === source.endpoint && record.source.target === source.target;
}
