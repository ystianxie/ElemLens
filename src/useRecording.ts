import {useEffect, useRef, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {editRecordedStep, invalidateValidations, matchedValidation, mergeRecordedStep, type RecordedEvent, type RecordedStep, type RecordingPhase} from './recording';

import type {QueryResult} from './types';
import {hideCaptureWindow, previewWithHiddenWindow, type RestoreCaptureWindow} from './capture-window';

type Source = {endpoint: string; target: string; title: string; url: string};
const desktop = '__TAURI_INTERNALS__' in window;
export function useRecording(source: Source, onStarted: () => void, environment: {python:string; ready:boolean; capturing:boolean; hideCaptureWindow:boolean}) {
    const [steps, setSteps] = useState<RecordedStep[]>([]);
    const [phase, setPhase] = useState<RecordingPhase>('idle');
    const [pending, setPending] = useState(false), [ready, setReady] = useState(false);
    const [error, setError] = useState(''), [warning, setWarning] = useState('');
    const [validatingId, setValidatingId] = useState<string | null>(null);
    const validationEpoch = useRef(0), stepsRef = useRef<RecordedStep[]>([]);
    stepsRef.current = steps;
    const [selectedId, select] = useState<string | null>(null);
    const session = useRef({id:'', source: {...source}}), phaseRef = useRef<RecordingPhase>('idle');
    const pendingRef = useRef(false), sourceRef = useRef(source), startedRef = useRef(onStarted);
    sourceRef.current = source; startedRef.current = onStarted;
    function invalidate(message: string) {
        validationEpoch.current++;
        setSteps(previous => invalidateValidations(previous, message));
    }
    useEffect(() => { invalidate('所选标签页或 Python 环境已改变，请重新校验。'); }, [source.endpoint, source.target, environment.python]);
    function changePhase(value: RecordingPhase) { phaseRef.current = value; setPhase(value); }
    useEffect(() => {
        if (!desktop) return;
        let disposed = false;
        const unlisten = listen<{endpoint:string; targetId:string; kind:string; data:unknown}>('browser-event', ({payload:event}) => {
            if (disposed || !session.current.id || event.endpoint !== session.current.source.endpoint ||
                event.targetId !== session.current.source.target) return;
            if (event.kind === 'recording-step') {
                const step = event.data as RecordedEvent;
                if (step.recordingId !== session.current.id) return;
                setSteps(previous => mergeRecordedStep(previous, step));
                select(previous => previous ?? step.id);
            } else if (event.kind === 'recording-warning') {
                const data = event.data as string | {recordingId:string;message:string};
                if (typeof data === 'string' || data.recordingId === session.current.id)
                    setWarning(typeof data === 'string' ? data : data.message);
            } else if (event.kind === 'invalidated') {
                invalidate('页面或 iframe 已变化，请重新校验。');
            } else if (event.kind === 'disconnected') {
                invalidate('连接已断开，请重新连接后校验。');
                changePhase('finished');
                setWarning('录制连接已断开，已接收步骤保留。请检查断开前的最后一步。');
            }
        });
        void unlisten.then(() => { if (!disposed) setReady(true); }).catch(e => { if (!disposed) setError(String(e)); });
        return () => { disposed = true; void unlisten.then(fn => fn()).catch(() => {}); };
    }, []);
    const sameSource = !steps.length || (session.current.source.endpoint === source.endpoint && session.current.source.target === source.target);
    async function control(action: 'start' | 'resume' | 'pause' | 'stop') {
        if (pendingRef.current) return;
        pendingRef.current = true; setPending(true); setError('');
        try {
            if (action === 'start') {
                if (!sameSource) throw new Error('已有其他标签页的录制，请先复制并清空，再录制当前标签页。');
                session.current = {id:crypto.randomUUID(), source:{...sourceRef.current}};
                setWarning('');
            }
            await invoke('set_recording', {recordingId:session.current.id, action});
            changePhase(action === 'start' || action === 'resume' ? 'recording' : action === 'pause' ? 'paused' : 'finished');
            if (action === 'start' || action === 'resume') {
                invalidate('录制已继续，请完成操作后重新校验。');
                startedRef.current();
            }
        } catch (e) {
            setError(String(e));
            throw e;
        } finally { pendingRef.current = false; setPending(false); }
    }
    async function finish() {
        if (phaseRef.current === 'recording' || phaseRef.current === 'paused') await control('stop');
    }
    function update(id: string, patch: Partial<RecordedStep>) {
        setSteps(previous => previous.map(step => step.id === id ? editRecordedStep(step, patch) : step));
    }
    function remove(id: string) {
        setSteps(previous => previous.filter(step => step.id !== id));
        if (selectedId === id) select(null);
    }
    function clear() {
        if (phaseRef.current === 'recording' || phaseRef.current === 'paused' || pendingRef.current) return;
        session.current = {id:'',source:{...sourceRef.current}};
        setSteps([]); select(null); setWarning(''); setError(''); changePhase('idle');
    }
    const canValidate = desktop && ready && environment.ready && !!source.target && sameSource &&
        phase !== 'recording' && !environment.capturing && !pending && !validatingId;
    async function validate(id: string) {
        if (!canValidate || pendingRef.current) return;
        const step = stepsRef.current.find(item => item.id === id);
        if (!step || !step.expression.trim()) return;
        const epoch = validationEpoch.current;
        pendingRef.current = true; setValidatingId(id); setError('');
        const current = () => epoch === validationEpoch.current &&
            stepsRef.current.some(item => item.id === id && item.expression === step.expression && item.mode === step.mode);
        let restore: RestoreCaptureWindow | undefined;
        let previewed = false;
        try {
            restore = await hideCaptureWindow(environment.hideCaptureWindow);
            const result = await invoke<QueryResult & {pageUrl:string}>('query_recording_step', {
                python:environment.python, endpoint:source.endpoint, targetId:source.target,
                steps:step.context.steps, mode:step.mode, expression:step.expression,
            });
            if (!current()) return;
            const validation = matchedValidation(result);
            setSteps(previous => previous.map(item => item.id === id ? {...item,validation} : item));
            try {
                await invoke('highlight', {context:result.context,tokens:result.matches.map(item => item.token),scroll:false});
                previewed = true;
            } catch (e) {
                if (current()) {
                    setSteps(previous => previous.map(item => item.id === id ? {...item,validation:{...validation,status:'stale',message:'高亮失败，请重新校验：' + String(e)}} : item));
                }
            }
        } catch (e) {
            if (current()) setSteps(previous => previous.map(item => item.id === id ? {...item,
                validation:{status:'error',checkedAt:Date.now(),message:String(e)}} : item));
        } finally {
            try { if (restore) await restore(previewed ? 5000 : 0); }
            catch (e) { setError(String(e)); }
            finally { pendingRef.current = false; setValidatingId(null); }
        }
    }
    async function highlightMatch(id: string, token: string) {
        if (!canValidate || pendingRef.current) return;
        const step = stepsRef.current.find(item => item.id === id);
        if (!step?.validation?.result || step.validation.status === 'stale' || step.validation.status === 'error') return;
        pendingRef.current = true; setPending(true); setError('');
        try {
            const context = step.validation.result.context;
            await previewWithHiddenWindow(environment.hideCaptureWindow, () => invoke('highlight', {context,tokens:[token],scroll:true}));
        } catch (e) {
            setSteps(previous => previous.map(item => item.id === id && item.validation ? {...item,validation:{...item.validation,status:'stale',message:'高亮失败，请重新校验：' + String(e)}} : item));
        }
        finally { pendingRef.current = false; setPending(false); }
    }
    return {steps, phase, pending, ready, error, warning, selectedId, validatingId, canValidate, validate, highlightMatch, select, update, remove, clear, control, finish,
        sameSource, source:session.current.source, selected:steps.find(step => step.id === selectedId) ?? null};
}
export type Recorder = ReturnType<typeof useRecording>;
