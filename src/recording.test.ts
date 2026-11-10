import {describe,expect,it} from 'vitest';
import {editRecordedStep,invalidateValidations,matchedValidation,mergeRecordedStep,recordingCode,type RecordedEvent} from './recording';
import {pythonString} from './codegen';
const event: RecordedEvent = {recordingId:'r',id:'one',revision:1,recordedAt:1000,action:'input',pageUrl:'https://example.test',pageTitle:'Form',value:'hello',
    context:{sessionId:'s',contextId:1,frameId:'f',documentToken:'d',steps:[]},
    element:{token:'e',tag:'input',text:'',attributes:{id:'name'},css:'#name',xpath:'//input',visible:true,inViewport:true}};
describe('recording steps and DP code', () => {
    it('merges input revisions while keeping edited locators and ignores stale deliveries', () => {
        let steps=mergeRecordedStep([],event);
        steps[0].expression='@name=custom';steps[0].editedValue='edited';
        steps=mergeRecordedStep(steps,{...event,revision:3,value:'latest'});
        expect(steps).toHaveLength(1);
        expect(steps[0]).toMatchObject({expression:'@name=custom',value:'latest',editedValue:'edited'});
        expect(mergeRecordedStep(steps,{...event,revision:2})).toBe(steps);
    });
    it('orders delayed frame events by capture time and retains repeated operations', () => {
        const steps=mergeRecordedStep(mergeRecordedStep([],{...event,id:'later',recordedAt:2000}),event);
        expect(steps.map(step => step.id)).toEqual(['one','later']);
    });
    it('generates replacement input, clearing, click, nested context, and escaped text', () => {
        const value='张三 "test"\\path\nnext';
        let steps=mergeRecordedStep([],{...event,value,context:{...event.context,steps:[{kind:'frame',selector:'#form'},{kind:'shadow',selector:'x-field'}]}});
        steps=mergeRecordedStep(steps,{...event,id:'clear',recordedAt:1001,value:''});
        steps=mergeRecordedStep(steps,{...event,id:'click',recordedAt:1002,action:'click'});
        const result=recordingCode(steps);
        expect(result.errors).toEqual([]);
        expect(result.code).toContain('context = tab.ele("css:#form")\ncontext = context.ele("css:x-field").shadow_root');
        expect(result.code).toContain(`.input(${pythonString(value)}, clear=True)`);
        expect(result.code).toContain('.clear()');expect(result.code).toContain('.click()');
    });
    it('optionally wraps each action in a numbered step and keeps the default format', () => {
        let steps=mergeRecordedStep([],{...event,value:'123',element:{...event.element,attributes:{id:'voyageNo'}}});
        steps=mergeRecordedStep(steps,{...event,id:'click',recordedAt:1001,action:'click'});
        expect(recordingCode(steps).code).toContain('# 1. 输入 voyageNo\ntab.ele("tag:input@@id=voyageNo").input("123", clear=True)');
        expect(recordingCode(steps, false)).toEqual(recordingCode(steps));
        const result=recordingCode(steps, true);
        expect(result.errors).toEqual([]);
        expect(result.code).toContain('with step("1. 输入 voyageNo"):\n    tab.ele("tag:input@@id=voyageNo").input("123", clear=True)');
        expect(result.code).toContain('with step("2. 点击 name"):\n    tab.ele("tag:input@@id=name").click()');
        expect(result.code).not.toContain('# 1. 输入');
        expect(recordingCode([], true)).toEqual({code:'',errors:[]});
    });
    it('indents all context and input lines and escapes step titles', () => {
        const name='name "quoted"\\path\nnext';
        let steps=mergeRecordedStep([],{...event,value:'\n',element:{...event.element,attributes:{'aria-label':name}},
            context:{...event.context,steps:[{kind:'frame',selector:'#form'},{kind:'shadow',selector:'x-field'}]}});
        steps=mergeRecordedStep(steps,{...event,id:'click',recordedAt:1001,action:'click',context:steps[0].context});
        steps=mergeRecordedStep(steps,{...event,id:'clear',recordedAt:1002,value:''});
        const code=recordingCode(steps, true).code;
        expect(code).toContain('with step(' + pythonString('1. 输入 ' + name.replace(/\n/g,' ')) + '):');
        expect(code).toContain('    context = tab.ele("css:#form")\n    context = context.ele("css:x-field").shadow_root\n    ele = context.ele(');
        expect(code).toContain('\n    ele.clear()\n    ele.input("\\n")');
        expect(code).toContain('with step("2. 点击 name"):\n    context = tab.ele("css:#form")\n    context = context.ele("css:x-field").shadow_root\n    context.ele("tag:input@@id=name").click()');
        expect(code).toContain('with step("3. 输入 name"):\n    tab.ele("tag:input@@id=name").clear()');
        steps[0].expression='';
        const invalid=recordingCode(steps, true);
        expect(invalid.errors).toEqual(['第 1 步：定位表达式不能为空']);
        expect(invalid.code).not.toContain('with step(' + pythonString('1. 输入 ' + name.replace(/\n/g,' ')) + '):');
    });
    it('redacts password snapshots and generates an editable variable placeholder', () => {
        const steps=mergeRecordedStep([],{...event,sensitive:true,value:'secret',element:{...event.element,attributes:{type:'password',value:'secret'}}});
        expect(JSON.stringify(steps)).not.toContain('secret');
        expect(recordingCode(steps).code).toContain('.input(password, clear=True)');
    });
    it('falls back to CSS when DP conditions cannot be represented and blocks empty expressions', () => {
        const steps=mergeRecordedStep([],{...event,element:{...event.element,tag:'invalid:tag',css:'#safe'}});
        expect(steps[0].mode).toBe('CSS');
        expect(recordingCode(steps).code).toContain('css:#safe');
        steps[0].expression='';expect(recordingCode(steps).errors).toEqual(['第 1 步：定位表达式不能为空']);
    });
    it('keeps newlines in element names from injecting executable code comments', () => {
        const steps=mergeRecordedStep([],{...event,element:{...event.element,attributes:{'aria-label':'hello\nraise Exception()'}}});
        expect(recordingCode(steps).code).not.toContain('\nraise Exception()');
    });
});

describe('per-step locator validation', () => {
    const result = {matches:[event.element],total:1,truncated:false,engine:'DrissionPage test',context:event.context,pageUrl:'https://example.test/current'};
    it('distinguishes no match, unique match, and ambiguous matches', () => {
        expect(matchedValidation({...result,total:0,matches:[]}).status).toBe('missing');
        expect(matchedValidation(result)).toMatchObject({status:'unique',pageUrl:'https://example.test/current'});
        expect(matchedValidation({...result,total:2}).status).toBe('multiple');
    });
    it('invalidates only the step whose locator changes and preserves the recorded snapshot', () => {
        const first={...mergeRecordedStep([],event)[0],validation:matchedValidation(result)};
        const other={...first,id:'other'};
        const updated=[first,other].map(step => step.id === first.id ? editRecordedStep(step,{expression:'#changed'}) : step);
        expect(updated[0].validation).toBeUndefined();
        expect(updated[0].element).toBe(first.element);
        expect(updated[1].validation).toBe(other.validation);
        expect(editRecordedStep(first,{mode:'CSS'}).validation).toBeUndefined();
        expect(editRecordedStep(first,{editedValue:'new content'}).validation).toBe(first.validation);
        expect(editRecordedStep(first,{expression:first.expression}).validation).toBe(first.validation);
    });
    it('retains validation history but marks old page matches stale', () => {
        const first={...mergeRecordedStep([],event)[0],validation:matchedValidation(result)};
        const unverified={...mergeRecordedStep([],{...event,id:'other'})[0]};
        const updated=invalidateValidations([first,unverified],'page changed');
        expect(updated[0].validation).toMatchObject({status:'stale',message:'page changed',result});
        expect(updated[1]).toBe(unverified);
    });
});
