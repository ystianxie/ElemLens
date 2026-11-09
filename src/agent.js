(() => {
  const KEY = '__elemlens_v1';
  if (window[KEY]?.measure && window[KEY]?.setRecording) return;
  window[KEY]?.dispose();
  function createToken() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    // Error pages and insecure frames may provide getRandomValues without randomUUID.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20)].join('-');
  }
  const documentToken = createToken();
  const elements = new Map();
  const reverse = new WeakMap();
  let active = false, hover = null, selected = [], frame = 0;
  const host = document.createElement('div');
  host.setAttribute('data-elemlens-overlay', '');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
  const shadow = host.attachShadow({mode:'closed'});
  function mount() { if (!host.isConnected) (document.documentElement || document).appendChild(host); }
  function uniqueCss(el) {
    const root = el.getRootNode();
    const unique = s => { try { return root.querySelectorAll(s).length === 1; } catch { return false; } };
    if (el.id && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    for (const name of ['data-testid','data-test','name','aria-label']) {
      const value = el.getAttribute(name);
      if (value) { const s = el.localName + '[' + name + '=' + JSON.stringify(value) + ']'; if (unique(s)) return s; }
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      let part = CSS.escape(node.localName);
      const siblings = node.parentElement ? [...node.parentElement.children].filter(e => e.localName === node.localName) : [];
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node)+1) + ')';
      parts.unshift(part);
      if (unique(parts.join(' > '))) return parts.join(' > ');
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  function scopeSteps(el) {
    const steps = [];
    let root = el.getRootNode();
    while (root instanceof ShadowRoot) { steps.unshift({kind:'shadow',selector:uniqueCss(root.host)}); root = root.host.getRootNode(); }
    return steps;
  }
  function xpath(el) {
    const parts=[];
    while(el && el.nodeType===1){ const siblings = el.parentNode ? [...el.parentNode.children].filter(e=>e.localName===el.localName) : []; parts.unshift('*[local-name()=' + JSON.stringify(el.localName) + ']['+(siblings.indexOf(el)+1)+']'); el=el.parentElement; }
    return '/' + parts.join('/');
  }
  function register(el) {
    let token = reverse.get(el);
    if (!token) { token=createToken(); reverse.set(el,token); elements.set(token,el); }
    const rect=el.getBoundingClientRect(), style=getComputedStyle(el);
    const visible=!!(el.getClientRects().length && rect.width && rect.height && style.visibility!=='hidden' && style.display!=='none');
    const locatorText=el.textContent || '';
    const directTextNodes=[...el.childNodes].filter(node=>node.nodeType===3).map(node=>node.nodeValue || '');
    return {token,tag:el.localName,text:(el.innerText || locatorText).trim().slice(0,800),locatorText:locatorText.slice(0,800),directTextNodes,locatorTextTruncated:locatorText.length>800,attributes:Object.fromEntries([...el.attributes].map(a=>[a.name,a.value])),css:uniqueCss(el),xpath:xpath(el),visible,inViewport:visible && rect.bottom>0 && rect.right>0 && rect.top<innerHeight && rect.left<innerWidth};
  }
  function box(el,label,color) {
    if (!el?.isConnected) return;
    const r=el.getBoundingClientRect(); if(!r.width || !r.height) return;
    const div=document.createElement('div');
    div.style.cssText=`position:fixed;box-sizing:border-box;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:2px solid ${color};background:${color}18;pointer-events:none;`;
    const tag=document.createElement('span'); tag.textContent=label; tag.style.cssText=`position:absolute;left:0;bottom:100%;font:12px/20px system-ui;color:white;background:${color};padding:0 6px;white-space:nowrap`;
    div.appendChild(tag); shadow.appendChild(div);
  }
  function draw() { frame=0; mount(); shadow.replaceChildren(); if(active && hover) box(hover,hover.localName + ' · Ctrl+点击捕获','#6658e8'); selected.forEach((el,i)=>box(el,String(i+1),'#18a67b')); }
  function schedule(){if(!frame)frame=requestAnimationFrame(draw);}
  function move(e){ if(!active)return; hover=e.composedPath().find(n=>n instanceof Element && n!==host) || null; schedule(); }
  function block(e){if(!active || !e.ctrlKey || e.button!==0)return; if(e.type==='click')e.preventDefault();e.stopImmediatePropagation(); if(e.type==='click'){
    const el=e.composedPath().find(n=>n instanceof Element && n!==host); if(!el)return;
    const payload={type:'capture',documentToken,steps:scopeSteps(el),element:register(el)};
    active=false;hover=null;selected=[el];schedule();window.__elemlens_bridge(JSON.stringify(payload));
  }}
  function key(e){if(e.key==='Escape' && active){active=false;hover=null;schedule();window.__elemlens_bridge(JSON.stringify({type:'cancel'}));}}
  const events=['pointerdown','mousedown','mouseup','pointerup','click','auxclick'];
  window.addEventListener('pointermove',move,true);events.forEach(n=>window.addEventListener(n,block,true));window.addEventListener('keydown',key,true);
  window.addEventListener('scroll',schedule,true);window.addEventListener('resize',schedule,true);
  // Recording never prevents or synthesizes page events. Context paths are supplied
  // before interaction so navigation cannot invalidate an asynchronous lookup.
  let recording = null, recordingVersion = 0, pendingInput = null, lastValues = new WeakMap();
  const composing = new WeakSet(), sensitiveInputs = new WeakSet();
  function recordingTarget(event) {
    return event.composedPath().find(node => node instanceof Element && node !== host) || null;
  }
  function textInput(el) {
    return el && (el.localName === 'textarea' || (el.localName === 'input' &&
      ['text','search','email','url','tel','password','number'].includes((el.type || 'text').toLowerCase())));
  }
  function sensitiveInput(el) {
    if (el.localName === 'input' && el.type === 'password') sensitiveInputs.add(el);
    return sensitiveInputs.has(el);
  }
  function snapshot(el) {
    const info = register(el);
    // Value attributes can contain secrets even though password .value is masked.
    if (sensitiveInput(el)) delete info.attributes.value;
    return info;
  }
  function stepPayload(el, action) {
    return {
      type: 'recording', recordingId: recording.id, id: createToken(), revision: 0,
      recordedAt: performance.timeOrigin + performance.now(), action,
      pageUrl: location.href, pageTitle: document.title,
      context: {...recording.context, documentToken, steps: [...recording.context.steps, ...scopeSteps(el)]},
      element: snapshot(el),
    };
  }
  function sendStep(step) { window.__elemlens_bridge(JSON.stringify(step)); }
  function updateInput(el) {
    if (!recording || !textInput(el)) return;
    if (!pendingInput && lastValues.get(el) === el.value) return;
    lastValues.set(el, el.value);
    if (pendingInput && pendingInput.el !== el) flushInput();
    if (!pendingInput) pendingInput = {el, step: stepPayload(el, 'input')};
    const step = pendingInput.step;
    step.revision++;
    step.sensitive = sensitiveInput(el);
    step.value = step.sensitive ? '' : el.value;
    // Publish revisions as typing progresses, preserving a single stable step id.
    if (!composing.has(el)) sendStep(step);
  }
  function flushInput() {
    if (!pendingInput) return;
    const el = pendingInput.el;
    const step = pendingInput.step;
    step.revision++;
    step.value = step.sensitive ? '' : el.value;
    sendStep(step);
    pendingInput = null;
  }
  function recordClick(event) {
    if (!recording || !event.isTrusted || event.button !== 0) return;
    flushInput();
    const el = recordingTarget(event);
    if (!el) return;
    const inputType = (el.type || '').toLowerCase();
    // Stateful controls need semantic actions, not a misleading .click() step.
    const control = el.closest?.('input,select,[contenteditable="true"]');
    if (el.localName === 'select' || (el.localName === 'input' &&
        ['checkbox','radio','file','range','color','date','datetime-local','month','time','week'].includes(inputType)) ||
        (control && (control.localName === 'select' || control.isContentEditable)) ||
        (el.localName === 'label' && el.control && !textInput(el.control))) {
      window.__elemlens_bridge(JSON.stringify({type:'recordingWarning',recordingId:recording.id,
        message:'本次操作涉及暂不支持的控件，请在复制后补充对应代码。'}));
      return;
    }
    sendStep(stepPayload(el, 'click'));
  }
  function recordInput(event) {
    if (!recording || !event.isTrusted) return;
    const el = recordingTarget(event);
    if (!textInput(el)) return;
    if (event.isComposing) composing.add(el);
    updateInput(el);
  }
  function compositionStart(event) {
    if (event.isTrusted) { const el = recordingTarget(event); if (el) composing.add(el); }
  }
  function compositionEnd(event) {
    if (!event.isTrusted) return;
    const el = recordingTarget(event);
    if (el) { composing.delete(el); updateInput(el); }
  }
  function recordBlur(event) {
    if (pendingInput?.el === recordingTarget(event)) flushInput();
  }
  function recordPointer(event) {
    if (recording && event.isTrusted && pendingInput && pendingInput.el !== recordingTarget(event)) flushInput();
  }
  function recordKey(event) {
    if (recording && event.isTrusted && event.key === 'Enter' && !event.isComposing) {
      flushInput();
      window.__elemlens_bridge(JSON.stringify({type:'recordingWarning',recordingId:recording.id,
        message:'检测到 Enter 按键；第一版不录制键盘操作，请补充代码。'}));
    }
  }
  function setRecording(value, version) {
    if (version < recordingVersion) return;
    flushInput();
    recordingVersion = version;
    recording = value;
    lastValues = new WeakMap();
    if (value) { active = false; hover = null; selected = []; schedule(); }
  }
  const recordingEvents = {click:recordClick,input:recordInput,change:recordInput,
    compositionstart:compositionStart,compositionend:compositionEnd,blur:recordBlur,
    pointerdown:recordPointer,keydown:recordKey,pagehide:flushInput};
  Object.entries(recordingEvents).forEach(([name,handler]) => window.addEventListener(name,handler,true));
  const api={documentToken,register,scopeSteps,uniqueCss,setRecording,measure(token){const el=elements.get(token);if(!el?.isConnected)throw Error('元素已失效，请重新捕获或校验');const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};},setActive(value){active=value;hover=null; if(!value)selected=[];schedule();},highlight(tokens,scroll){selected=tokens.map(t=>elements.get(t)).filter(e=>e?.isConnected);if(tokens.length && !selected.length)throw Error('元素已失效，请重新校验');if(scroll && selected[0])selected[0].scrollIntoView({block:'center',inline:'nearest'});schedule();},dispose(){flushInput();recording=null;Object.entries(recordingEvents).forEach(([name,handler])=>window.removeEventListener(name,handler,true));active=false;events.forEach(n=>window.removeEventListener(n,block,true));window.removeEventListener('pointermove',move,true);window.removeEventListener('keydown',key,true);window.removeEventListener('scroll',schedule,true);window.removeEventListener('resize',schedule,true);cancelAnimationFrame(frame);host.remove();elements.clear();delete window[KEY];}};
  window[KEY]=api;
})();
