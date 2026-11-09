import { describe, expect, it } from 'vitest';
import { defaultDpConditions, dpConditionError, dpQuickLocator, type DpCondition, type DpOperator } from './codegen';
import type { ElementInfo } from './types';
import fixtures from '../tests/dp-locators.json';

function element(attributes: Record<string,string> = {}, text = ''): ElementInfo {
  return { token: 'capture', tag: 'button', attributes, text, locatorText: text, directTextNodes: text ? [text] : [], css: '#button', xpath: '//button', visible: true, inViewport: true };
}
function attribute(value: string, operator: DpOperator = '='): DpCondition {
  return { key: 'attr:data-value', kind: 'attribute', name: 'data-value', value, operator, checked: true };
}

describe('DP native locator generation', () => {
  for (const fixture of fixtures) it(fixture.name, () => {
    const rows = defaultDpConditions(element(fixture.attributes as Record<string,string>, fixture.text)).map(row => ({
      ...row,
      checked: row.kind === 'tag' ? fixture.tag : fixture.choose.includes(row.name),
      operator: row.kind === 'tag' ? '=' as const : fixture.operator as DpOperator,
      includeDescendants: row.kind === 'text' ? !!fixture.includeDescendants : row.includeDescendants,
    }));
    const result = dpQuickLocator(rows);
    if (fixture.error) expect(result.errors).toHaveLength(1);
    else expect(result).toEqual({ expression: fixture.expression, errors: [] });
  });

  it('prefers one useful attribute and leaves every captured attribute available', () => {
    const rows = defaultDpConditions(element({ id: 'submit', class: 'btn', 'data-testid': 'submit', disabled: '' }, '提交'));
    expect(rows.filter(row => row.checked).map(row => row.name)).toEqual(['tag()', 'id']);
    expect(rows.map(row => row.name)).toEqual(['tag()', 'id', 'class', 'data-testid', 'disabled', 'text()']);
  });
  it('skips unsafe defaults and uses safe test attributes', () => {
    const rows = defaultDpConditions(element({ id: 'broken@@id', 'data-testid': 'safe' }, '提交'));
    expect(dpQuickLocator(rows).expression).toBe('tag:button@@data-testid=safe');
  });
  it('uses raw textContent rather than trimmed display text', () => {
    const rows = defaultDpConditions({ ...element({}, '提交'), locatorText: ' 提交\n' });
    expect(rows.find(row => row.kind === 'text')?.value).toBe(' 提交\n');
    expect(dpQuickLocator(rows).expression).toBe('tag:button@@text(): 提交\n');
  });
  it('defaults to direct text when the captured text is present in a direct text node', () => {
    const rows = defaultDpConditions(element({}, '提交'));
    expect(rows.find(row => row.kind === 'text')?.includeDescendants).toBe(false);
    expect(dpQuickLocator(rows.filter(row => row.kind === 'text'))).toEqual({expression:'text:提交', errors:[]});
  });
  it('defaults to descendant text when the captured text only comes from nested elements', () => {
    const rows = defaultDpConditions({...element({}, '立即提交'), directTextNodes:['立即']});
    expect(rows.find(row => row.kind === 'text')?.includeDescendants).toBe(true);
    expect(dpQuickLocator(rows)).toEqual({expression:'tag:button@@text():立即提交', errors:[]});
  });
  it('uses direct text with a tag and refuses an unscoped descendant-only expression', () => {
    const rows = defaultDpConditions(element({}, '提交'));
    const text = rows.find(row => row.kind === 'text')!;
    expect(dpQuickLocator([rows[0], {...text, checked:true}]).expression).toBe('tag:button@text():提交');
    expect(dpQuickLocator([{...text, checked:true, includeDescendants:true}]).errors).toHaveLength(1);
  });
  it('allows descendant text combined with an attribute when no tag is selected', () => {
    const rows = defaultDpConditions(element({id:'outer'}, '提交'));
    const selected = rows.map(row => row.kind === 'tag' ? {...row, checked:false} : row.kind === 'text' ? {...row, checked:true, includeDescendants:true} : {...row, checked:true});
    expect(dpQuickLocator(selected).expression).toBe('@@id=outer@@text():提交');
  });
  it('requires XPath for direct text combined with another non-tag condition', () => {
    const rows = defaultDpConditions(element({id:'submit'}, '提交'));
    const selected = rows.map(row => row.kind === 'text' ? {...row, checked:true} : row);
    expect(dpQuickLocator(selected).errors[0]).toContain('切换 XPath');
  });
  it('preserves punctuation, backslashes, quotes and line breaks verbatim', () => {
    const value = 'a@b.com: = $ ^ \\ "\'\n雪';
    expect(dpQuickLocator([attribute(value)]).expression).toBe('@data-value=' + value);
  });
  for (const value of ['x@@id=other', 'x@|id=other', 'x@!id=other']) it(`rejects delimiter ${value} without broadening the selector`, () => {
    const rows = defaultDpConditions(element({ id: 'submit' }));
    const result = dpQuickLocator([...rows, attribute(value)]);
    expect(result.expression).toBe('');
    expect(result.errors).toHaveLength(1);
  });
  it('validates only checked conditions', () => {
    expect(dpQuickLocator([{ ...attribute('bad@@value'), checked: false }])).toEqual({ expression: '', errors: [] });
  });
  it('supports existence even if the unused captured value contains delimiters', () => {
    expect(dpQuickLocator([attribute('bad@@value', 'exists')]).expression).toBe('@data-value');
  });
  it('rejects namespace and operator characters in attribute names', () => {
    for (const name of ['xlink:href', 'bad=name', 'text()']) expect(dpConditionError({ ...attribute('value'), name })).not.toBe('');
  });
  it('requires a nonempty value for contains, prefix and suffix', () => {
    for (const operator of [':', '^', '$'] as const) expect(dpQuickLocator([attribute('', operator)]).errors).toHaveLength(1);
  });
  it('has no implicit match-all expression when everything is unchecked', () => {
    expect(dpQuickLocator(defaultDpConditions(element()).map(row => ({ ...row, checked: false })))).toEqual({ expression: '', errors: [] });
  });
});
