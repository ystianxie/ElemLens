import {defaultDpConditions, dpQuickLocator, dpCode, pythonString, type DpCondition} from './codegen';
import type {Context, ElementInfo, QueryResult} from './types';

export type RecordingPhase = 'idle' | 'recording' | 'paused' | 'finished';
export type RecordedEvent = {
    recordingId: string; id: string; revision: number; recordedAt: number;
    action: 'click' | 'input'; pageUrl: string; pageTitle: string;
    context: Context; element: ElementInfo; value?: string; sensitive?: boolean;
};
export type StepValidation = {
    status: 'unique' | 'multiple' | 'missing' | 'error' | 'stale';
    checkedAt: number; message: string; result?: QueryResult; pageUrl?: string;
};
export const validationLabels = {unique:'唯一匹配', multiple:'多个匹配', missing:'未找到', error:'校验失败', stale:'需要重新校验'};
export function matchedValidation(result: QueryResult & {pageUrl?:string}): StepValidation {
    return {status:result.total === 0 ? 'missing' : result.total === 1 ? 'unique' : 'multiple', checkedAt:Date.now(), result,
        pageUrl:result.pageUrl, message:result.total === 0 ? '当前页面未找到匹配元素，请检查页面和定位条件。' :
            result.total === 1 ? '当前页面唯一匹配。请核对下方元素是否为录制目标。' : `匹配到 ${result.total} 个元素，请收紧定位条件。`};
}
export function invalidateValidations(steps: RecordedStep[], message: string): RecordedStep[] {
    return steps.map(step => step.validation ? {...step,validation:{...step.validation,status:'stale',message}} : step);
}
export function editRecordedStep(step: RecordedStep, patch: Partial<RecordedStep>): RecordedStep {
    const changed = (patch.mode !== undefined && patch.mode !== step.mode) ||
        (patch.expression !== undefined && patch.expression !== step.expression) ||
        (patch.context !== undefined && patch.context !== step.context);
    return {...step,...patch,...(changed ? {validation:undefined} : {})};
}
export type RecordedStep = RecordedEvent & {
    dpConditions: DpCondition[]; mode: 'DP' | 'CSS' | 'XPath'; expression: string;
    editedValue?: string; validation?: StepValidation;
};
export function mergeRecordedStep(steps: RecordedStep[], event: RecordedEvent): RecordedStep[] {
    const index = steps.findIndex(step => step.id === event.id);
    if (index >= 0) {
        if (steps[index].revision >= event.revision) return steps;
        return steps.map((step, i) => i === index ? {...step, revision: event.revision,
            value: event.sensitive ? '' : event.value, sensitive: event.sensitive} : step);
    }
    const element = {...event.element, attributes: {...event.element.attributes}};
    if (event.sensitive || element.attributes.type?.toLowerCase() === 'password') delete element.attributes.value;
    const dpConditions = defaultDpConditions(element);
    const generated = dpQuickLocator(dpConditions);
    const useDp = !generated.errors.length && !!generated.expression;
    const step: RecordedStep = {...event, element, value: event.sensitive ? '' : event.value,
        dpConditions, mode: useDp ? 'DP' : 'CSS', expression: useDp ? generated.expression : element.css};
    return [...steps, step].sort((a, b) => a.recordedAt - b.recordedAt);
}
export function recordingStepName(step: RecordedStep, maxTextLength = 60): string {
    const attrs = step.element.attributes;
    return attrs['aria-label'] || attrs.placeholder || attrs.name || attrs.id ||
        step.element.text.replace(/\s+/g, ' ').trim().slice(0, maxTextLength) || step.element.tag;
}
export function recordingStepError(step: RecordedStep): string {
    if (!step.expression.trim()) return '定位表达式不能为空';
    return '';
}
export function recordingCode(steps: RecordedStep[]): {code: string; errors: string[]} {
    const errors = steps.flatMap((step, index) => {
        const error = recordingStepError(step);
        return error ? [`第 ${index + 1} 步：${error}`] : [];
    });
    if (!steps.length) return {code:'', errors};
    const lines = ['# 在已连接并准备好起始页面的 DrissionPage tab 上执行。', '# 定位校验只确认匹配情况，运行前请核对实际页面和操作效果。'];
    if (steps.some(step => step.sensitive)) lines.push('password = ""  # 请填写密码，或替换为你的变量');
    for (const [index, step] of steps.entries()) {
        lines.push('', `# ${index + 1}. ${step.action === 'click' ? '点击' : '输入'} ${recordingStepName(step).replace(/[\r\n\u2028\u2029]/g, ' ')}`);
        if (recordingStepError(step)) { lines.push('# 此步骤缺少有效定位，请修正后复制。'); continue; }
        if (step.action === 'click') {
            lines.push(dpCode(step.context, step.mode, step.expression, {click:true}));
        } else {
            const lookup = dpCode(step.context, step.mode, step.expression).split('\n');
            const element = lookup.pop()!;
            lines.push(...lookup);
            const value = step.editedValue ?? step.value ?? '';
            if (!step.sensitive && value === '') lines.push(`${element}.clear()`);
            else if (!step.sensitive && ['\n','\ue007','\ue006'].includes(value)) {
                lines.push(`ele = ${element}`, 'ele.clear()', `ele.input(${pythonString(value)})`);
            } else lines.push(`${element}.input(${step.sensitive ? 'password' : pythonString(value)}, clear=True)`);
        }
    }
    return {code:lines.join('\n'), errors};
}
