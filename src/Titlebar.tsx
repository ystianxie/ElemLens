import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Minus, Settings2, Square, X } from 'lucide-react';
import './titlebar.css';

type TitlebarProps = {
  desktop: boolean;
  settingsOpen: boolean;
  onSettingsToggle: () => void;
  onError: (message: string) => void;
};

export function Titlebar({ desktop, settingsOpen, onSettingsToggle, onError }: TitlebarProps) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    const appWindow = getCurrentWindow();
    let disposed = false;
    let stopListening: (() => void) | undefined;
    const refresh = async () => {
      try {
        const value = await appWindow.isMaximized();
        if (!disposed) setMaximized(value);
      } catch (error) {
        if (!disposed) onError(`读取窗口状态失败：${String(error)}`);
      }
    };
    void appWindow.onResized(() => { void refresh(); }).then(unlisten => {
      if (disposed) unlisten();
      else {
        stopListening = unlisten;
        void refresh();
      }
    }).catch(error => {
      if (!disposed) onError(`监听窗口状态失败：${String(error)}`);
    });
    return () => { disposed = true; stopListening?.(); };
  }, [desktop, onError]);

  function windowAction(action: 'minimize' | 'toggleMaximize' | 'close') {
    if (!desktop) return;
    void getCurrentWindow()[action]().catch(error => onError(`窗口操作失败：${String(error)}`));
  }

  return <header className="titlebar">
    <div className="titlebar-drag" data-tauri-drag-region>
      <img className="titlebar-icon" src="/icon.png" alt="" draggable="false"/>
      <strong className="titlebar-name">觅元 <span>ElemLens</span></strong>
      <span className="titlebar-divider"/>
      <span className="titlebar-subtitle">元素工作台</span>
      <span className="titlebar-status"><i/>本地工作空间</span>
    </div>
    <button className="titlebar-settings" title="环境设置" aria-label="环境设置" aria-pressed={settingsOpen}
            onClick={onSettingsToggle}><Settings2 size={16}/></button>
    {desktop && <div className="window-controls" role="group" aria-label="窗口操作">
      <button className="window-control" title="最小化" aria-label="最小化" onClick={() => windowAction('minimize')}><Minus size={14}/></button>
      <button className="window-control" title={maximized ? '还原' : '最大化'} aria-label={maximized ? '还原' : '最大化'} onClick={() => windowAction('toggleMaximize')}>{maximized ? <Copy size={12}/> : <Square size={12}/>}</button>
      <button className="window-control window-close" title="关闭" aria-label="关闭" onClick={() => windowAction('close')}><X size={16}/></button>
    </div>}
  </header>;
}
