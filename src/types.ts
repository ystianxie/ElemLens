export type Step = { kind: 'frame' | 'shadow'; selector: string };
export type Context = { sessionId: string; contextId: number; frameId: string; documentToken: string; targetId?: string; steps: Step[] };
export type ElementInfo = { token: string; tag: string; text: string; locatorText?: string; directTextNodes?: string[]; locatorTextTruncated?: boolean; attributes: Record<string,string>; css: string; xpath: string; visible: boolean; inViewport: boolean };
export type Capture = { context: Context; element: ElementInfo };
export type Browser = { endpoint: string; name: string; version: string };
export type Tab = { id: string; title: string; url: string };
export type QueryResult = { matches: ElementInfo[]; total: number; engine: string; context: Context; truncated: boolean };
export type Settings = { python: string; browser: string };

export type ElementGeometry = { x: number; y: number; width: number; height: number; centerX: number; centerY: number };
