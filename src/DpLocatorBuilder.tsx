import { dpConditionError, dpQuickLocator, type DpCondition, type DpOperator } from './codegen';
import './dp-locator.css';

type Props = {
  rows: DpCondition[];
  expression: string;
  truncated: boolean;
  disabled: boolean;
  recordLabel?: string;
  onChange: (rows: DpCondition[]) => void;
};

export function DpLocatorBuilder({ rows, expression, truncated, disabled, recordLabel = '当前捕获记录', onChange }: Props) {
  const generated = dpQuickLocator(rows);
  const conditionErrors = rows.filter(row => row.checked).map(row => `${row.name}：${dpConditionError(row)}`);
  const locatorErrors = generated.errors.filter(error => !conditionErrors.includes(error));
  function update(key: string, patch: Partial<DpCondition>) {
    onChange(rows.map(row => row.key === key ? { ...row, ...patch } : row));
  }
  return <div className="dp-builder">
    <div className="dp-builder-title"><strong>属性快捷定位</strong><span>单层 · 所有勾选条件同时满足</span></div>
    <div className="dp-condition-head"><span>属性</span><span>运算符</span><span>值</span></div>
    <div className="dp-condition-list">
      {rows.map(row => {
        const error = dpConditionError(row);
        return <div className={'dp-condition' + (row.checked ? ' checked' : '')} key={row.key}>
          <div className="dp-condition-property">
            <label title={row.kind === 'tag' ? '限定元素标签' : row.name}>
              <input type="checkbox" checked={row.checked} disabled={disabled} onChange={e => update(row.key, { checked: e.target.checked })}/>
              <code>{row.name}</code>
            </label>
            {row.kind === 'text' && <label className="dp-text-scope" title="勾选后，文本匹配范围包含该元素的所有后代元素">
              <input type="checkbox" checked={!!row.includeDescendants} disabled={disabled} onChange={e => update(row.key, { includeDescendants: e.target.checked })}/>
              <span>含子元素</span>
            </label>}
          </div>
          <select aria-label={`${row.name} 运算符`} value={row.operator} disabled={disabled || row.kind === 'tag'} onChange={e => update(row.key, { operator: e.target.value as DpOperator })}>
            <option value="=">等于</option>
            {row.kind !== 'tag' && <><option value=":">包含</option><option value="^">开头是</option><option value="$">结尾是</option>{row.kind === 'attribute' && <option value="exists">存在</option>}</>}
          </select>
          <textarea aria-label={`${row.name} 定位值`} rows={1} value={row.value} title={row.value} spellCheck={false} readOnly={row.kind === 'tag'} disabled={disabled || row.operator === 'exists'} placeholder={row.operator === 'exists' ? '任意值' : '空字符串'} onChange={e => update(row.key, { value: e.target.value })}/>
          {row.checked && error && <p className="dp-condition-error" role="alert">{error}</p>}
        </div>;
      })}
    </div>
    {locatorErrors.map(error => <p className="dp-condition-error" role="alert" key={error}>{error}</p>)}
    <p className="dp-builder-hint">来自{recordLabel}；勾选、文本范围、运算符和值的修改会自动保存到该记录。文本单独定位时使用 text:；含子元素文本需同时限定标签或属性。{truncated && '捕获文本仅保留前 800 字符，请使用“包含”或自行补全。'}</p>
    {!rows.some(row => row.checked) && <p className="dp-condition-error">请至少勾选一个条件。</p>}
    {expression !== generated.expression && <div className="dp-manual-note"><span>表达式已手动编辑</span><button disabled={disabled || !!generated.errors.length} onClick={() => onChange(rows)}>恢复勾选结果</button></div>}
  </div>;
}
