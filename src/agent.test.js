import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('./agent.js', import.meta.url), 'utf8');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function page(nativeUuid = false) {
  const crypto = { getRandomValues: vi.fn(bytes => webcrypto.getRandomValues(bytes)) };
  if (nativeUuid) crypto.randomUUID = vi.fn(() => webcrypto.randomUUID());
  const document = {
    createElement: () => ({
      setAttribute() {}, style: {}, attachShadow: () => ({}), remove() {},
    }),
  };
  const globals = {
    performance: {timeOrigin:1000, now:vi.fn(() => performance.now())},
    location:{href:'https://example.test/form'}, Element:class {static [Symbol.hasInstance](value) {return value?.nodeType === 1;}}, ShadowRoot:class {},
    requestAnimationFrame:vi.fn(() => 1),
    __elemlens_bridge:vi.fn(),
    crypto, document, CSS: { escape: value => value }, innerWidth: 800, innerHeight: 600,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), cancelAnimationFrame: vi.fn(),
  };
  globals.window = globals;
  const install = () => runInNewContext(source, globals);
  install();
  return { globals, crypto, install, api: globals.__elemlens_v1 };
}

function element(id) {
  const rect = { x: 10, y: 20, width: 80, height: 30, top: 20, bottom: 50, left: 10, right: 90 };
  const el = {
    id, localName: 'button', nodeType: 1, parentElement: null, parentNode: null,
    isConnected: true, textContent: 'Submit', childNodes: [{nodeType:3,nodeValue:'Submit'}], attributes: [{ name: 'id', value: id }],
    getBoundingClientRect: () => rect, getClientRects: () => [rect],
    getRootNode: () => ({ querySelectorAll: () => [el] }),
  };
  return el;
}

describe('injected capture agent identifiers', () => {
  it('uses native UUIDs when available', () => {
    const { api, crypto } = page(true);
    expect(api.documentToken).toMatch(uuidPattern);
    expect(api.register(element('submit')).token).toMatch(uuidPattern);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(2);
    expect(crypto.getRandomValues).not.toHaveBeenCalled();
  });

  it('initializes and registers elements when randomUUID is unavailable in a frame', () => {
    const { api, crypto } = page();
    const first = element('first');
    const captured = api.register(first);
    const second = api.register(element('second'));
    const tokens = [api.documentToken, captured.token, second.token];
    tokens.forEach(token => expect(token).toMatch(uuidPattern));
    expect(new Set(tokens).size).toBe(3);
    expect(api.register(first).token).toBe(captured.token);
    expect(api.measure(captured.token)).toEqual({ x: 10, y: 20, width: 80, height: 30 });
    expect(captured.css).toBe('#first');
    expect(captured.directTextNodes).toEqual(['Submit']);
    expect(captured.visible).toBe(true);
    expect(crypto.getRandomValues).toHaveBeenCalledTimes(3);
  });

  it('keeps identifiers on repeated injection and replaces them after disposal', () => {
    const { api, globals, install } = page();
    install();
    expect(globals.__elemlens_v1).toBe(api);
    api.dispose();
    install();
    expect(globals.__elemlens_v1.documentToken).toMatch(uuidPattern);
    expect(globals.__elemlens_v1.documentToken).not.toBe(api.documentToken);
  });
});

function recordingPage() {
  const env = page();
  const events = () => env.globals.__elemlens_bridge.mock.calls.map(([value]) => JSON.parse(value)).filter(step => step.type === 'recording');
  env.api.setRecording({id:'recording-1',context:{steps:[{kind:'frame',selector:'#frame'}],documentToken:'old'}}, 1);
  function emit(name, el, extra = {}) {
    const event = {type:name,isTrusted:true,button:0,ctrlKey:false,composedPath:() => [el], ...extra};
    for (const [kind, handler] of env.globals.addEventListener.mock.calls) if (kind === name) handler(event);
    return event;
  }
  function input(id, value = '') {
    return {...element(id),localName:'input',type:'text',value};
  }
  return {...env,events,emit,input};
}

describe('operation recording agent', () => {
  it('records normal clicks without preventing them and captures the scope before navigation', () => {
    const {emit,events} = recordingPage();
    const preventDefault = vi.fn(), stopImmediatePropagation = vi.fn();
    emit('click',element('save'),{preventDefault,stopImmediatePropagation});
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopImmediatePropagation).not.toHaveBeenCalled();
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({action:'click',pageUrl:'https://example.test/form',element:{css:'#save'},context:{steps:[{kind:'frame',selector:'#frame'}]}});
  });
  it('publishes one input id, flushes before the next click, and avoids duplicate change events', () => {
    const {emit,events,input,api} = recordingPage();
    const field = input('name');
    field.value='a';emit('input',field);
    field.value='admin';emit('input',field);
    emit('blur',field);emit('change',field);
    emit('click',element('submit'));
    api.setRecording(null,2);
    expect(new Set(events().filter(step => step.action === 'input').map(step => step.id)).size).toBe(1);
    expect(events().at(-2)).toMatchObject({action:'input',value:'admin'});
    expect(events().at(-1)).toMatchObject({action:'click'});
  });
  it('does not publish intermediate Chinese composition text and flushes the final value on stop', () => {
    const {emit,events,input,api} = recordingPage();
    const field=input('name');
    emit('compositionstart',field);field.value='zhang';emit('input',field,{isComposing:true});
    expect(events()).toHaveLength(0);
    field.value='张三';emit('compositionend',field);
    api.setRecording(null,2);
    expect(events().at(-1)).toMatchObject({action:'input',value:'张三'});
    expect(new Set(events().map(step => step.id)).size).toBe(1);
  });
  it('retains clearing and separate edits around a click', () => {
    const {emit,events,input,api} = recordingPage();
    const field=input('query','A');emit('input',field);emit('click',element('search'));
    field.value='';emit('input',field);api.setRecording(null,2);
    const inputSteps=events().filter(step => step.action === 'input');
    expect(new Set(inputSteps.map(step => step.id)).size).toBe(2);
    expect(inputSteps.at(-1).value).toBe('');
  });
  it('ignores synthetic events and paused interactions, then resumes with new edits', () => {
    const {emit,events,input,api} = recordingPage();
    emit('click',element('fake'),{isTrusted:false});
    const field=input('q','a');emit('input',field);api.setRecording(null,2);
    const count=events().length;
    field.value='paused';emit('input',field);emit('click',element('skip'));
    expect(events()).toHaveLength(count);
    api.setRecording({id:'recording-1',context:{steps:[]}},3);
    field.value='resume';emit('input',field);
    expect(events().at(-1).value).toBe('resume');
  });
  it('never sends password values or value attributes', () => {
    const {emit,events,input} = recordingPage();
    const field=input('password','secret');field.type='password';
    field.attributes.push({name:'value',value:'secret'});
    emit('click',field);emit('input',field);
    expect(JSON.stringify(events())).not.toContain('secret');
    expect(events().at(-1)).toMatchObject({sensitive:true,value:''});
  });
  it('keeps revealed passwords redacted after toggling visibility', () => {
    const {emit,events,input} = recordingPage();
    const field=input('password','secret');field.type='password';
    emit('click',field);
    field.type='text';field.attributes.push({name:'value',value:'secret'});
    emit('input',field);emit('blur',field);emit('click',field);
    expect(JSON.stringify(events())).not.toContain('secret');
    expect(events().find(step => step.action === 'input')).toMatchObject({sensitive:true,value:''});
  });
  it('records submit buttons and warns when a stateful control is skipped', () => {
    const {emit,events,input,globals} = recordingPage();
    const submit=input('submit');submit.type='submit';
    submit.closest=() => submit;emit('click',submit);
    const checkbox=input('checked');checkbox.type='checkbox';
    emit('click',checkbox);
    expect(events()).toHaveLength(1);
    expect(events()[0].element.css).toBe('#submit');
    expect(globals.__elemlens_bridge.mock.calls.some(([raw]) => JSON.parse(raw).type === 'recordingWarning')).toBe(true);
  });
  it('rejects stale activation after a stop and removes recording handlers on disposal', () => {
    const {api,emit,events,globals} = recordingPage();
    api.setRecording(null,3);api.setRecording({id:'old',context:{steps:[]}},2);
    emit('click',element('old'));
    expect(events()).toHaveLength(0);
    api.dispose();
    expect(globals.removeEventListener.mock.calls.some(([name]) => name === 'compositionend')).toBe(true);
  });
});
