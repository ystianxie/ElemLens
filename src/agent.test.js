import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('./agent.js', import.meta.url), 'utf8');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function page(nativeUuid = false) {
  const crypto = { getRandomValues: vi.fn(bytes => webcrypto.getRandomValues(bytes)) };
  if (nativeUuid) crypto.randomUUID = vi.fn(() => webcrypto.randomUUID());
  const nodes = [];
  function domNode() {
    return {
      style: {}, children: [], parentNode: null, setAttribute() {},
      get isConnected() { return this === document.documentElement || !!this.parentNode?.isConnected; },
      appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; return child; },
      remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
      },
      replaceChildren() { [...this.children].forEach(child => child.remove()); },
      attachShadow() { this.overlay = domNode(); this.overlay.parentNode = this; return this.overlay; },
      animate: vi.fn(() => ({cancel:vi.fn()})),
    };
  }
  const document = {
    createElement: () => { const node = domNode(); nodes.push(node); return node; },
    querySelectorAll: vi.fn(() => []),
  };
  document.documentElement = domNode();
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
  return { globals, crypto, install, api: globals.__elemlens_v1, windowTarget:runInNewContext('window', globals), host:nodes[0], dot:nodes[2], ripple:nodes[3], freezeDot:nodes[4], document };
}

function element(id) {
  const rect = { x: 10, y: 20, width: 80, height: 30, top: 20, bottom: 50, left: 10, right: 90 };
  const el = {
    id, localName: 'button', nodeType: 1, parentElement: null, parentNode: null,
    isConnected: true, textContent: 'Submit', childNodes: [{nodeType:3,nodeValue:'Submit'}], attributes: [{ name: 'id', value: id }],
    getAttribute: name => el.attributes.find(attr => attr.name === name)?.value ?? null,
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

  it('replaces an older agent that has no freeze support', () => {
    const { api, globals, install } = page();
    delete api.setFreezeArmed;
    install();
    expect(globals.__elemlens_v1).not.toBe(api);
    expect(typeof globals.__elemlens_v1.setFreezeArmed).toBe('function');
    expect(globals.removeEventListener).toHaveBeenCalled();
    expect(globals.__elemlens_v1.documentToken).not.toBe(api.documentToken);
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

describe('recording pointer feedback', () => {
  it('follows real mouse movement without adding steps and survives overlay redraws', () => {
    const {emit,events,dot,host,globals,api} = recordingPage();
    expect(dot.style.display).toBe('none');
    emit('pointermove',element('save'),{clientX:120,clientY:80,pointerType:'mouse'});
    expect(dot.style.transform).toBe('translate(120px,80px)');
    expect(dot.style.display).toBe('block');
    globals.requestAnimationFrame.mock.calls.at(-1)[0]();
    expect(dot.isConnected).toBe(true);
    expect(host.overlay.children).toContain(dot);
    expect(events()).toHaveLength(0);
    api.setRecording(null,2);
    emit('pointermove',element('save'),{clientX:200,clientY:150});
    expect(dot.style.display).toBe('none');
    expect(dot.isConnected).toBe(false);
  });
  it('hands off feedback to iframe agents without leaving a parent cursor behind', () => {
    const {emit,dot} = recordingPage();
    emit('pointermove',element('parent'),{clientX:40,clientY:30});
    expect(dot.style.display).toBe('block');
    emit('pointerout',element('parent'),{relatedTarget:{...element('frame'),localName:'iframe'}});
    expect(dot.style.display).toBe('none');
    emit('pointermove',element('parent'),{clientX:40,clientY:30});
    expect(dot.style.display).toBe('block');
  });
  it('shows a ripple on left pointer down while preserving click and input ordering', () => {
    const {emit,events,input,dot,ripple} = recordingPage();
    const field=input('name','Alice');
    emit('input',field);
    const button=element('save'), preventDefault=vi.fn(), stopImmediatePropagation=vi.fn();
    emit('pointerdown',button,{clientX:240,clientY:180,pointerType:'mouse',preventDefault,stopImmediatePropagation});
    expect(dot.style.transform).toBe('translate(240px,180px)');
    expect(ripple.style.left).toBe('240px');
    expect(ripple.style.top).toBe('180px');
    expect(ripple.animate).toHaveBeenCalledTimes(1);
    expect(events().at(-1)).toMatchObject({action:'input',value:'Alice',revision:2});
    emit('click',button,{preventDefault,stopImmediatePropagation});
    expect(events().filter(step=>step.action==='click')).toHaveLength(1);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopImmediatePropagation).not.toHaveBeenCalled();
  });
  it('cancels rapid clicks and removes all feedback on pause, stop and disposal', () => {
    const {emit,api,dot,ripple,host} = recordingPage();
    const click=()=>emit('pointerdown',element('save'),{clientX:50,clientY:60});
    click(); const first=ripple.animate.mock.results.at(-1).value;
    click(); const second=ripple.animate.mock.results.at(-1).value;
    expect(first.cancel).toHaveBeenCalledOnce();
    api.setRecording(null,2);
    expect(second.cancel).toHaveBeenCalledOnce();
    expect(host.overlay.children).not.toContain(dot);
    expect(host.overlay.children).not.toContain(ripple);
    api.setRecording({id:'recording-1',context:{steps:[]}},3);
    expect(host.overlay.children).toContain(dot);
    click(); const third=ripple.animate.mock.results.at(-1).value;
    api.setRecording(null,4);
    expect(third.cancel).toHaveBeenCalledOnce();
    api.setRecording({id:'recording-1',context:{steps:[]}},5);
    click(); const fourth=ripple.animate.mock.results.at(-1).value;
    api.dispose();
    expect(fourth.cancel).toHaveBeenCalledOnce();
    expect(host.isConnected).toBe(false);
  });
  it('hides feedback when leaving the page, changing focus or navigating', () => {
    const {emit,dot,ripple,windowTarget} = recordingPage();
    const button=element('save');
    const move=()=>emit('pointermove',button,{clientX:40,clientY:30});
    move();emit('pointerout',button,{relatedTarget:element('other')});
    expect(dot.style.display).toBe('block');
    emit('pointerout',button,{relatedTarget:null});
    expect(dot.style.display).toBe('none');
    move();emit('blur',button,{target:button});
    expect(dot.style.display).toBe('block');
    emit('blur',button,{target:windowTarget});
    expect(dot.style.display).toBe('none');
    emit('pointerdown',button,{clientX:40,clientY:30});
    const animation=ripple.animate.mock.results.at(-1).value;
    emit('pagehide',button);
    expect(animation.cancel).toHaveBeenCalledOnce();
    expect(dot.style.display).toBe('none');
  });
  it('ignores synthetic movement, touch feedback, right clicks and paused interactions', () => {
    const {emit,api,dot,ripple,events} = recordingPage();
    const button=element('save');
    emit('pointermove',button,{isTrusted:false,clientX:10,clientY:20});
    emit('pointermove',button,{pointerType:'touch',clientX:10,clientY:20});
    emit('pointerdown',button,{isTrusted:false});
    emit('pointerdown',button,{pointerType:'touch'});
    emit('pointerdown',button,{button:2});
    expect(dot.style.display).toBe('none');
    expect(ripple.animate).not.toHaveBeenCalled();
    api.setRecording(null,2);
    emit('pointerdown',button,{clientX:10,clientY:20});
    expect(ripple.animate).not.toHaveBeenCalled();
    expect(events()).toHaveLength(0);
  });
});


function freezePage() {
  const env = page();
  const messages = () => env.globals.__elemlens_bridge.mock.calls.map(([value]) => JSON.parse(value));
  function emit(type, el = element('trigger'), extra = {}) {
    const event = {type,isTrusted:true,button:0,altKey:false,ctrlKey:false,composedPath:()=>[el],
      preventDefault:vi.fn(),stopImmediatePropagation:vi.fn(),...extra};
    for (const [name, handler] of env.globals.addEventListener.mock.calls) if (name === type) handler(event);
    return event;
  }
  return {...env,messages,emit};
}

describe('popup freeze agent', () => {
  it('shows blue feedback only while armed and removes it on cancel or disposal', () => {
    const {api,emit,freezeDot,host,messages} = freezePage();
    api.setFreezeArmed(true);
    emit('pointermove',element('trigger'),{clientX:120,clientY:80});
    expect(freezeDot.style.cssText).toContain('#3b82f6');
    expect(freezeDot.style.display).toBe('block');
    expect(freezeDot.style.transform).toBe('translate(120px,80px)');
    expect(host.isConnected).toBe(true);
    emit('keydown',element('trigger'),{key:'Escape'});
    expect(messages()).toEqual([{type:'freezeCancel'}]);
    expect(freezeDot.isConnected).toBe(false);
    api.setFreezeArmed(true);
    api.dispose();
    expect(freezeDot.isConnected).toBe(false);
  });
  it('requires a real Alt-left press, blocks the complete click and sends one confirmation', () => {
    const {api,emit,messages,freezeDot} = freezePage();
    api.setFreezeArmed(true);
    expect(emit('pointerdown').preventDefault).not.toHaveBeenCalled();
    emit('pointerdown',element('trigger'),{altKey:true,isTrusted:false});
    emit('pointerdown',element('trigger'),{altKey:true,button:2});
    expect(messages()).toHaveLength(0);
    for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) {
      const e=emit(type,element('trigger'),{altKey:type==='pointerdown'});
      expect(e.preventDefault).toHaveBeenCalled();
      expect(e.stopImmediatePropagation).toHaveBeenCalled();
    }
    expect(messages()).toEqual([{type:'freeze'}]);
    expect(freezeDot.style.display).toBe('none');
    api.setFreezeArmed(false);
    expect(emit('pointerdown',element('trigger'),{altKey:true}).preventDefault).not.toHaveBeenCalled();
  });
  it('retains the composed hover path and includes hover states inside shadow roots', () => {
    const {api,emit,document} = freezePage();
    const trigger=element('trigger'), ancestor=element('ancestor'), inner=element('inner');
    ancestor.shadowRoot={querySelectorAll:()=>[inner]};
    document.querySelectorAll.mockReturnValue([ancestor]);
    api.setFreezeArmed(true);
    emit('pointerdown',trigger,{altKey:true,composedPath:()=>[trigger,ancestor]});
    expect(Array.from(api.freezeTargets())).toEqual([trigger,ancestor,inner]);
  });
  it('draws validation boxes synchronously when callbacks are disabled, then returns to animation frames', () => {
    const {api,globals,host} = freezePage();
    const token=api.register(element('popup')).token;
    api.setFrozen(true);
    globals.requestAnimationFrame.mockClear();
    api.highlight([token],false);
    expect(globals.requestAnimationFrame).not.toHaveBeenCalled();
    const boxes=host.overlay.children[0].children;
    expect(boxes).toHaveLength(1);
    expect(boxes[0].style.cssText).toContain('#18a67b');
    expect(boxes[0].children[0].textContent).toBe('1');
    api.setFrozen(false);
    expect(globals.requestAnimationFrame).toHaveBeenCalledOnce();
  });
});


describe('highlight cleanup', () => {
  it.each([false, true])('clears validation boxes with frozen=%s and allows highlighting again', frozen => {
    const {api,globals,host} = page();
    const token = api.register(element('matched')).token;
    api.setFrozen(frozen);
    function paint() {
      if (!frozen) globals.requestAnimationFrame.mock.calls.at(-1)[0]();
    }
    api.highlight([token],false);
    paint();
    const highlights = host.overlay.children[0];
    expect(highlights.children).toHaveLength(1);
    api.highlight([],false);
    paint();
    expect(highlights.children).toHaveLength(0);
    expect(host.isConnected).toBe(true);
    api.highlight([token],false);
    paint();
    expect(highlights.children).toHaveLength(1);
  });
});


function scopedCapturePage() {
  const env = page();
  const root = {};
  const parent = {...element('parent'),children:[]};
  const child = {...element('inside'),parentElement:parent,parentNode:parent};
  const outside = element('outside');
  parent.children = [child];
  for (const el of [parent,child,outside]) el.getRootNode = () => root;
  parent.contains = el => el === parent || parent.children.includes(el);
  parent.querySelectorAll = () => [child];
  root.querySelectorAll = () => [parent];
  const token = env.api.register(parent).token;
  const scope = {documentToken:env.api.documentToken,token};
  env.api.setCaptureScope(scope);
  env.api.setActive(true);
  function click(el) {
    const event = {type:'click',ctrlKey:true,button:0,composedPath:() => [el,parent],preventDefault:vi.fn(),stopImmediatePropagation:vi.fn()};
    for (const [name,handler] of env.globals.addEventListener.mock.calls) if (name === 'click') handler(event);
    return event;
  }
  const messages = () => env.globals.__elemlens_bridge.mock.calls.map(([value]) => JSON.parse(value));
  return {...env,parent,child,outside,token,scope,root,click,messages};
}

describe('capture within a parent scope', () => {
  it('rejects outside elements and the parent itself, then accepts an internal descendant without restarting', () => {
    const {click,outside,parent,child,messages} = scopedCapturePage();
    const event = click(outside);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopImmediatePropagation).toHaveBeenCalled();
    expect(messages()).toEqual([expect.objectContaining({type:'captureRejected',message:'超出当前父级范围'})]);
    click(parent);
    expect(messages().at(-1).message).toContain('后代');
    click(child);
    expect(messages().filter(m => m.type === 'capture')).toHaveLength(1);
    expect(messages().at(-1).element).toMatchObject({css:'#inside',xpath:'./*[local-name()="button"][1]'});
  });
  it('rejects shadow descendants even when their visual host is inside the parent', () => {
    const {api,child,click,messages} = scopedCapturePage();
    child.getRootNode = () => ({});
    expect(api.captureInfo(child).error).toContain('Shadow Root');
    click(child);
    expect(messages().at(-1).type).toBe('captureRejected');
  });
  it('blocks a different document and a detached parent instead of widening the capture scope', () => {
    const {api,child,parent,scope,click,messages} = scopedCapturePage();
    api.setCaptureScope({...scope,documentToken:'another-frame'});
    click(child);
    expect(messages().at(-1).message).toContain('上下文');
    parent.isConnected=false;
    expect(api.setCaptureScope(scope)).toBe(false);
    click(child);
    expect(messages().at(-1).message).toContain('失效');
  });
  it('builds CSS paths that stop at the selected parent', () => {
    const {api,child,parent,token} = scopedCapturePage();
    child.id=''; child.attributes=[];
    parent.querySelectorAll = selector => selector === 'button' ? [child,{}] : [child];
    expect(api.register(child,token).css).toBe(':scope > button');
    expect(api.captureInfo(child).element.xpath).toBe('./*[local-name()="button"][1]');
  });
  it('returns to unrestricted capture after clearing the scope', () => {
    const {api,outside,click,messages} = scopedCapturePage();
    api.setCaptureScope(null);
    click(outside);
    expect(messages().at(-1)).toMatchObject({type:'capture',element:{css:'#outside'}});
  });
});
