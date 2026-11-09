import { describe, expect, it } from 'vitest';
import { dpCode, locator, pythonString } from './codegen';

describe('selector and Python snippet generation',()=>{
  it('escapes selector text and preserves DP locators',()=>{
    expect(locator('CSS','button[data-x="a"]')).toBe('css:button[data-x="a"]');
    expect(locator('XPath','//button')).toBe('xpath://button');
    expect(locator('DP','@id=submit')).toBe('@id=submit');
    expect(pythonString("line\n'雪")).toBe(JSON.stringify("line\n'雪"));
  });
  it('generates a single element lookup on the existing tab',()=>{
    expect(dpCode(null,'CSS','button')).toBe('tab.ele("css:button")');
    expect(dpCode(null,'XPath','//button')).toBe('tab.ele("xpath://button")');
    expect(dpCode(null,'DP','@id=submit')).toBe('tab.ele("@id=submit")');
  });
  it('appends click or input to the target lookup',()=>{
    expect(dpCode(null,'CSS','button',{click:true})).toBe('tab.ele("css:button").click()');
    expect(dpCode(null,'DP','@id=search',{input:'关键词'})).toBe('tab.ele("@id=search").input("关键词")');
    expect(dpCode(null,'DP','@id=search',{click:false})).toBe('tab.ele("@id=search")');
    expect(dpCode(null,'DP','@id=search',{input:''})).toBe('tab.ele("@id=search").input("")');
  });
  it('escapes input content as a Python string',()=>{
    const text = '雪"\\path\n第二行';
    expect(dpCode(null,'CSS','input',{input:text})).toBe('tab.ele("css:input").input(' + pythonString(text) + ')');
  });
  it('clicks then inputs on the same element without chaining click results',()=>{
    expect(dpCode(null,'CSS','input',{click:true,input:'hello'})).toBe('ele = tab.ele("css:input")\nele.click()\nele.input("hello")');
  });
  it('applies actions only after entering the captured context',()=>{
    const context = {sessionId:'s',contextId:2,frameId:'f',documentToken:'d',steps:[{kind:'shadow' as const,selector:'x-app'}]};
    expect(dpCode(context,'CSS','input',{click:true,input:'hello'})).toBe('context = tab.ele("css:x-app").shadow_root\nele = context.ele("css:input")\nele.click()\nele.input("hello")');
  });
  it('generates one lookup per line for nested iframe and shadow scopes',()=>{
    const snippet=dpCode({sessionId:'s',contextId:2,frameId:'f',documentToken:'d',steps:[{kind:'frame',selector:'#iframe'},{kind:'shadow',selector:'x-app'},{kind:'frame',selector:'#inner'}]},'CSS','button');
    expect(snippet).toBe('context = tab.ele("css:#iframe")\ncontext = context.ele("css:x-app").shadow_root\ncontext = context.ele("css:#inner")\ncontext.ele("css:button")');
  });
  it('uses the existing tab for elements in a separate target',()=>{
    const snippet=dpCode({sessionId:'s',contextId:2,frameId:'viewer',documentToken:'d',targetId:'pdf-viewer',steps:[{kind:'shadow',selector:'#viewer'},{kind:'shadow',selector:'#toolbar'},{kind:'shadow',selector:'#downloads'}]},'DP','tag:cr-icon-button@@id=save');
    expect(snippet).toBe('context = tab.ele("css:#viewer").shadow_root\ncontext = context.ele("css:#toolbar").shadow_root\ncontext = context.ele("css:#downloads").shadow_root\ncontext.ele("tag:cr-icon-button@@id=save")');
  });
  it('escapes selectors in both scope steps and the final lookup',()=>{
    const selector = 'iframe[data-name="main"]';
    const value = 'button[data-label="save"]';
    const snippet=dpCode({sessionId:'s',contextId:2,frameId:'f',documentToken:'d',steps:[{kind:'frame',selector}]},'CSS',value);
    expect(snippet).toBe('context = tab.ele(' + pythonString('css:' + selector) + ')\ncontext.ele(' + pythonString('css:' + value) + ')');
  });
});
