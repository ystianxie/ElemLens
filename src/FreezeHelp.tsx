import {useEffect, useState, type CSSProperties, type SyntheticEvent} from 'react';
import {createPortal} from 'react-dom';
import {CircleHelp} from 'lucide-react';

export function FreezeHelp() {
    const [position, setPosition] = useState<CSSProperties | null>(null);
    useEffect(() => {
        if (!position) return;
        const hide = () => setPosition(null);
        window.addEventListener('scroll', hide, true);
        window.addEventListener('resize', hide);
        return () => {
            window.removeEventListener('scroll', hide, true);
            window.removeEventListener('resize', hide);
        };
    }, [position]);

    function show(event: SyntheticEvent<HTMLButtonElement>) {
        const rect = event.currentTarget.getBoundingClientRect();
        const left = Math.max(12, Math.min(rect.right - 320, window.innerWidth - 332));
        setPosition(rect.top >= 260
            ? {left, bottom: window.innerHeight - rect.top + 8}
            : {left, top: rect.bottom + 8});
    }

    return <span className="freeze-help-wrap" onMouseLeave={() => setPosition(null)}>
        <button type="button" className="icon-button freeze-help" aria-label="冻结浮窗说明"
                aria-describedby={position ? 'freeze-help-tooltip' : undefined}
                onMouseEnter={show} onFocus={show} onBlur={() => setPosition(null)}>
            <CircleHelp size={15}/>
        </button>
        {position && createPortal(<div id="freeze-help-tooltip" className="freeze-tooltip" role="tooltip" style={position}>
            <strong>冻结浮窗的影响</strong>
            <p>冻结会暂停网页脚本、交互与定时更新，并保持悬浮状态，页面自动刷新和业务操作也会受到影响。</p>
            <p>CSS 动画仍可能继续；浏览器原生提示等不保证保留。</p>
            <p>先展开浮窗，按 Alt + 鼠标左键确认；Esc 取消。冻结后仍可捕获、校验与高亮。</p>
            <p>完成后请解除冻结；切换标签页或关闭觅元会自动解除。</p>
        </div>, document.body)}
    </span>;
}
