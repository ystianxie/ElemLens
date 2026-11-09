import type { Context, ElementInfo } from './types';
export function pythonString(value: string): string { return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
export function locator(mode: string, value: string) { return mode === 'DP' ? value : `${mode.toLowerCase()}:${value}`; }
export type DpOperator = '=' | ':' | '^' | '$' | 'exists';
export type DpCondition = { key: string; kind: 'tag' | 'attribute' | 'text'; name: string; value: string; operator: DpOperator; checked: boolean; includeDescendants?: boolean };

export function dpConditionError(row: DpCondition): string {
  if (row.kind === 'tag') return /^[a-zA-Z][\w.-]*$/.test(row.value) ? '' : '标签名无法用 DP 快捷语法表示';
  if (row.kind === 'attribute' && !/^[a-zA-Z_][\w.-]*$/.test(row.name)) return '该属性名不能安全用于 DP 快捷语法，请手动使用 CSS / XPath';
  if (row.operator === 'exists') return '';
  if (/@@|@\||@!/.test(row.value)) return '值含 DP 组合分隔符（@@、@| 或 @!），请修改值或手动使用 CSS / XPath';
  if (row.operator !== '=' && !row.value) return '包含、开头和结尾条件需要填写非空值';
  return '';
}

export function defaultDpConditions(element: ElementInfo): DpCondition[] {
  const attributes: DpCondition[] = Object.entries(element.attributes).map(([name,value]) => ({ key: `attr:${name}`, kind: 'attribute', name, value, operator: '=', checked: false }));
  const preferred = ['id', 'data-testid', 'data-test', 'name', 'aria-label', 'class'].map(name => attributes.find(row => row.name === name && row.value && !dpConditionError(row))).find(Boolean);
  if (preferred) preferred.checked = true;
  const text = element.locatorText ?? element.text;
  const directTextMatches = element.directTextNodes?.some(node => !!text && node.includes(text)) ?? false;
  return [
    { key: 'tag', kind: 'tag', name: 'tag()', value: element.tag, operator: '=', checked: true },
    ...attributes,
    { key: 'text', kind: 'text', name: 'text()', value: text, operator: ':', checked: !preferred && !!text && !/@@|@\||@!/.test(text), includeDescendants: !!text && !directTextMatches },
  ];
}

export function dpQuickLocator(rows: readonly DpCondition[]): { expression: string; errors: string[] } {
  const selected = rows.filter(row => row.checked);
  const errors = selected.flatMap(row => { const error = dpConditionError(row); return error ? [`${row.name}：${error}`] : []; });
  if (errors.length) return { expression: '', errors };
  const tag = selected.find(row => row.kind === 'tag');
  const conditions = selected.filter(row => row.kind !== 'tag');
  const text = conditions.find(row => row.kind === 'text');
  if (text?.includeDescendants && !tag && conditions.length === 1) return { expression: '', errors: ['含子元素文本需要同时勾选标签或属性条件，避免匹配到页面高层元素'] };
  if (text && !text.includeDescendants && conditions.length > 1) return { expression: '', errors: ['自身文本不能与多个快捷条件组合，请切换 XPath 或改用含子元素文本'] };
  if (text && !tag && conditions.length === 1) {
    return { expression: `text${text.operator}${text.value}`, errors: [] };
  }
  const parts = conditions.map(row => row.name + (row.operator === 'exists' ? '' : row.operator + row.value));
  const prefix = !tag && conditions.length === 1 && conditions[0].kind === 'attribute' ? '@' : text && !text.includeDescendants ? '@' : '@@';
  return { expression: (tag ? `tag:${tag.value}` : '') + parts.map(part => prefix + part).join(''), errors };
}

export function dpCode(context: Context | null, mode: string, value: string, actions: { click?: boolean; input?: string } = {}) {
  const lines = (context?.steps ?? []).map((step, index) => `context = ${index === 0 ? 'tab' : 'context'}.ele(${pythonString('css:' + step.selector)})${step.kind === 'shadow' ? '.shadow_root' : ''}`);
  const element = `${lines.length ? 'context' : 'tab'}.ele(${pythonString(locator(mode, value))})`;
  if (actions.click && actions.input !== undefined) {
    lines.push(`ele = ${element}`, 'ele.click()', `ele.input(${pythonString(actions.input)})`);
  } else {
    const operation = actions.click ? '.click()' : actions.input !== undefined ? `.input(${pythonString(actions.input)})` : '';
    lines.push(element + operation);
  }
  return lines.join('\n');
}
