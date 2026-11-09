import {useEffect, useRef, useState} from 'react';
import type {PointerEvent} from 'react';
import './details-resizer.css';

const minWidth = 220;

function bounds(handle: HTMLDivElement) {
    const workbench = handle.parentElement!;
    const style = getComputedStyle(workbench);
    const max = Math.max(minWidth, workbench.clientWidth
        - parseFloat(style.getPropertyValue('--browser-pane-width'))
        - parseFloat(style.getPropertyValue('--editor-min-width'))
        - handle.getBoundingClientRect().width);
    return {workbench, max};
}

export function DetailsResizer() {
    const handle = useRef<HTMLDivElement>(null);
    const drag = useRef<{x: number; width: number} | null>(null);
    const [resizing, setResizing] = useState(false);
    const [size, setSize] = useState({width: 280, max: 280});

    useEffect(() => {
        const divider = handle.current!;
        const details = divider.nextElementSibling!;
        const update = () => setSize({width: Math.round(details.getBoundingClientRect().width), max: Math.floor(bounds(divider).max)});
        const observer = new ResizeObserver(update);
        observer.observe(divider.parentElement!);
        observer.observe(details);
        update();
        return () => observer.disconnect();
    }, []);

    function resize(width: number) {
        const {workbench, max} = bounds(handle.current!);
        workbench.style.setProperty('--details-preferred-width', `${Math.min(max, Math.max(minWidth, width))}px`);
    }

    function stopDrag(event: PointerEvent<HTMLDivElement>) {
        drag.current = null;
        setResizing(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }

    return <div ref={handle} className={'details-resizer' + (resizing ? ' resizing' : '')}
                role="separator" aria-orientation="vertical" aria-label="调整详情栏宽度"
                aria-controls="details-pane" aria-valuemin={minWidth} aria-valuemax={size.max}
                aria-valuenow={size.width} aria-valuetext={`${size.width} 像素`} tabIndex={0}
                title="拖动调整详情栏宽度，双击恢复默认"
                onPointerDown={event => {
                    if (event.button !== 0 || !event.isPrimary) return;
                    event.preventDefault();
                    event.currentTarget.focus();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    drag.current = {x: event.clientX, width: event.currentTarget.nextElementSibling!.getBoundingClientRect().width};
                    setResizing(true);
                }}
                onPointerMove={event => {
                    if (drag.current) resize(drag.current.width + drag.current.x - event.clientX);
                }}
                onPointerUp={stopDrag} onPointerCancel={stopDrag}
                onLostPointerCapture={() => { drag.current = null; setResizing(false); }}
                onDoubleClick={() => handle.current!.parentElement!.style.removeProperty('--details-preferred-width')}
                onKeyDown={event => {
                    const width = event.currentTarget.nextElementSibling!.getBoundingClientRect().width;
                    if (event.key === 'ArrowLeft') resize(width + 16);
                    else if (event.key === 'ArrowRight') resize(width - 16);
                    else if (event.key === 'Home') resize(minWidth);
                    else if (event.key === 'End') resize(bounds(event.currentTarget).max);
                    else return;
                    event.preventDefault();
                }}/>
}
