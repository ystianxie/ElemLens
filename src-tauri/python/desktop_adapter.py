"""ElemLens inspection adapter; not part of the production automation library.

One COM owner thread (this process's main thread). stdin/stdout are JSONL;
all dependency diagnostics go to stderr. No input actions are exposed here.
"""
from __future__ import annotations

import contextlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import tempfile
import traceback

# Set before pywinauto/comtypes imports; do not inherit a GUI STA apartment.
sys.coinit_flags = 0


class UIAHover:
    """Fetch one geometry snapshot per provider call, without control wrappers."""
    def __init__(self, exclude_pid):
        from pywinauto.uia_defines import IUIA
        self.uia = IUIA()
        self.excluded = {exclude_pid, os.getpid()}
        self.cache = self.uia.iuia.CreateCacheRequest()
        for name in ("UIA_BoundingRectanglePropertyId", "UIA_IsOffscreenPropertyId",
                     "UIA_ProcessIdPropertyId", "UIA_RuntimeIdPropertyId"):
            self.cache.AddProperty(getattr(self.uia.UIA_dll, name))
        self.cache.TreeScope = self.uia.UIA_dll.TreeScope_Element

    def at(self, x, y):
        from ctypes.wintypes import tagPOINT
        point = tagPOINT(x, y)
        try:
            current = self.uia.iuia.ElementFromPointBuildCache(point, self.cache)
        except Exception as exc:
            # Some providers support ordinary hit testing but fail a cache
            # request. Read geometry only; this must never require parents.
            print(f"悬停缓存读取失败，改用直接命中: {exc}", file=sys.stderr)
            current = self.uia.iuia.ElementFromPoint(point)
            if current.CurrentProcessId in self.excluded:
                return None
            r = current.CurrentBoundingRectangle
            return {"rectangle": {"left": r.left, "top": r.top, "right": r.right, "bottom": r.bottom},
                    "visible": not current.CurrentIsOffscreen}
        seen = set()
        for _ in range(64):
            try:
                identity = tuple(current.GetCachedPropertyValue(self.uia.UIA_dll.UIA_RuntimeIdPropertyId) or ())
                if not identity or identity in seen:
                    break
                seen.add(identity)
                # Refinement is optional: a failed child read must not discard
                # the valid hit-test geometry we already have.
                children = current.FindAllBuildCache(self.uia.UIA_dll.TreeScope_Children,
                                                    self.uia.true_condition, self.cache)
            except Exception as exc:
                print(f"悬停细化失败，保留当前命中矩形: {exc}", file=sys.stderr)
                break
            candidates = []
            for index in range(min(children.Length, 256)):
                try:
                    child = children.GetElement(index)
                    key = tuple(child.GetCachedPropertyValue(self.uia.UIA_dll.UIA_RuntimeIdPropertyId) or ())
                    if key in seen or child.CachedIsOffscreen:
                        continue
                    r = child.CachedBoundingRectangle
                    if r.left <= x < r.right and r.top <= y < r.bottom:
                        candidates.append(((r.right-r.left)*(r.bottom-r.top), child))
                except Exception as exc:
                    print(f"跳过失效的悬停候选控件: {exc}", file=sys.stderr)
            if not candidates:
                break
            current = min(candidates, key=lambda item: item[0])[1]
        if current.CachedProcessId in self.excluded:
            return None
        r = current.CachedBoundingRectangle
        return {"rectangle": {"left": r.left, "top": r.top, "right": r.right, "bottom": r.bottom},
                "visible": not current.CachedIsOffscreen}


class Inspector:
    def __init__(self, backend="uia", exclude_pid=0):
        from desktop_automation import Desktop, Locator
        from desktop_automation.windows import WindowsBackend
        if not callable(getattr(Desktop, "query", None)):
            raise RuntimeError("桌面运行库版本过旧，请安装包含 Desktop.query() 的版本")
        self.Locator = Locator
        self.driver = WindowsBackend(backend)
        self.session = Desktop(backend=backend, driver=self.driver,
                               run_dir=Path(tempfile.gettempdir()) / "ElemLens" / "desktop-query")
        from pywinauto import Desktop as NativeDesktop
        self.window_desktop = NativeDesktop(backend="win32")
        self.exclude_pid = exclude_pid
        self.hover_uia = UIAHover(exclude_pid) if backend == "uia" else None
        self.nodes = {}
        self.identities = {}
        self.next_id = 0

    def close(self):
        self.session.close()
        self.nodes.clear()
        self.identities.clear()

    def token(self, wrapper):
        identity = self.driver._identity(wrapper)
        token = self.identities.get(identity)
        if token is None:
            self.next_id += 1
            token = str(self.next_id)
            self.identities[identity] = token
        self.nodes[token] = wrapper
        return token

    def allowed(self, wrapper):
        # WebView controls may belong to a child process of the owning window.
        excluded = {self.exclude_pid, os.getpid()}
        return (wrapper.element_info.process_id not in excluded
                and wrapper.top_level_parent().element_info.process_id not in excluded)

    def info(self, wrapper):
        snapshot = self.driver.snapshot(wrapper)
        snapshot["token"] = self.token(wrapper)
        snapshot["process_name"] = self.driver.process_name(snapshot["process"])
        return snapshot

    def node(self, token):
        if token not in self.nodes:
            raise RuntimeError("控件树已失效，请刷新窗口或重新捕获")
        wrapper = self.nodes[token]
        if self.driver.kind == "uia" and wrapper.backend.name == "win32":
            wrapper = self.driver.desktop.window(handle=wrapper.handle).wrapper_object()
            self.nodes[token] = wrapper
            self.identities[self.driver._identity(wrapper)] = token
        # Force a provider round trip rather than trusting a cached UIA object.
        wrapper.rectangle()
        if not self.allowed(wrapper):
            raise RuntimeError("觅元自身窗口不作为捕获目标")
        return wrapper

    def children(self, wrapper):
        items = wrapper.children()
        if self.driver.kind == "win32":
            import win32gui
            # pywinauto's Win32 children() enumerates every descendant HWND.
            items = [child for child in items if win32gui.GetParent(child.handle) == wrapper.handle]
        return items

    def from_point(self, x, y):
        if self.driver.kind == "win32":
            import win32gui
            # Start at the owning window and convert screen coordinates at every
            # level. Include disabled controls; never descend into hidden windows.
            handle = win32gui.GetAncestor(win32gui.WindowFromPoint((x, y)), 2)
            seen = set()
            for _ in range(64):
                seen.add(handle)
                child = win32gui.ChildWindowFromPointEx(handle, win32gui.ScreenToClient(handle, (x, y)), 1)
                if not child or child in seen:
                    break
                handle = child
            return self.window_desktop.window(handle=handle).wrapper_object()

        current = self.driver.desktop.from_point(x, y)
        seen = {self.driver._identity(current)}
        # Some providers hit-test only their host container even though they
        # expose descendants. Restrict refinement to that container, not desktop.
        for _ in range(64):
            candidates = []
            for child in self.children(current)[:256]:
                try:
                    identity = self.driver._identity(child)
                    if identity in seen or not child.is_visible():
                        continue
                    r = child.rectangle()
                    if r.left <= x < r.right and r.top <= y < r.bottom:
                        candidates.append(((r.right-r.left)*(r.bottom-r.top), child, identity))
                except Exception as exc:
                    print(f"跳过失效的候选控件: {exc}", file=sys.stderr)
            if not candidates:
                break
            _, current, identity = min(candidates, key=lambda item: item[0])
            seen.add(identity)
        return current

    def inspect(self, wrapper):
        if not self.allowed(wrapper):
            raise RuntimeError("觅元自身窗口不作为捕获目标")
        element = self.info(wrapper)
        root = wrapper.top_level_parent()
        ancestry = []
        current = wrapper
        seen = set()
        warning = ""
        complete = False
        root_identity = self.driver._identity(root)
        for _ in range(128):
            identity = self.driver._identity(current)
            if identity in seen:
                warning = "父级链出现重复控件标识，无法确认完整层级（可能是循环或标识缺失）。已保留当前元素属性，未生成定位条件。"
                break
            seen.add(identity)
            ancestry.insert(0, self.info(current))
            if identity == root_identity:
                complete = True
                break
            try:
                current = current.parent()
            except Exception as exc:
                warning = f"父级读取失败: {exc}。已保留当前元素属性，未生成定位条件。"
                break
            if current is None:
                break
        locator = None
        if complete:
            try:
                locator = self.driver.locator_for(wrapper).to_dict()
            except (ValueError, RuntimeError) as exc:
                warning = str(exc)
        else:
            warning = warning or "父级链未到达所属窗口或超过读取上限。已保留当前元素属性，未生成定位条件。"
            # The window is a scope, not an invented parent relationship. Keep
            # all partial nodes available for editing without selecting them.
            ancestry.insert(0, self.info(root))
        if self.driver._identity(wrapper) == self.driver._identity(root):
            warning = (warning + "\n当前只捕获到整个窗口，尚未定位内部控件。展开控件树或切换 UIA / Win32 重新捕获；若仍只有容器，说明当前后端未读到内部控件。").strip()
        elif element["control_type"] in {"Pane", "Group", "Custom", "Window"}:
            warning = (warning + "\n当前位置返回的是容器，请展开子控件并核对实际属性；容器的唯一匹配不代表已识别内部按钮或文本。").strip()
        return {"element": element, "window": self.info(root), "ancestry": ancestry,
                "locator": locator, "warning": warning}

    def dispatch(self, request):
        action = request["action"]
        if action == "check":
            return {"version": importlib.metadata.version("desktop-automation-runtime"),
                    "backend": self.driver.kind, "process": os.getpid()}
        if action == "windows":
            self.nodes.clear()
            self.identities.clear()
            windows = []
            # Enumerate native windows cheaply; open UIA providers only on selection.
            for wrapper in self.window_desktop.windows(visible_only=True, enabled_only=False):
                if self.allowed(wrapper):
                    try:
                        windows.append(self.info(wrapper))
                    except Exception as exc:
                        print(f"窗口属性无法读取: {exc}", file=sys.stderr)
            return windows
        if action == "children":
            return [self.info(child) for child in self.children(self.node(request["token"]))
                    if self.allowed(child)]
        if action == "inspect":
            return self.inspect(self.node(request["token"]))
        if action == "hover":
            if self.driver.kind == "uia":
                import win32gui
                import win32process
                # Resolve owning HWND cheaply, including WebView child processes;
                # climbing the UIA parent chain costs many provider round trips.
                window = win32gui.WindowFromPoint((int(request["x"]), int(request["y"])))
                root = win32gui.GetAncestor(window, 2) if window else 0
                if not root or win32process.GetWindowThreadProcessId(root)[1] in {self.exclude_pid, os.getpid()}:
                    return None
                return self.hover_uia.at(int(request["x"]), int(request["y"]))
            wrapper = self.from_point(int(request["x"]), int(request["y"]))
            if not self.allowed(wrapper):
                return None
            # The preview needs geometry only. Text/pattern reads and locator
            # generation belong to the explicit capture, not every mouse move.
            r = wrapper.rectangle()
            return {"rectangle": {"left": r.left, "top": r.top, "right": r.right, "bottom": r.bottom},
                    "visible": wrapper.is_visible()}
        if action == "point":
            wrapper = self.from_point(int(request["x"]), int(request["y"]))
            if not self.allowed(wrapper):
                return None
            return self.inspect(wrapper) if request.get("capture") else self.info(wrapper)
        if action == "query":
            locator = self.Locator.from_dict(request["locator"])
            if any(not self.allowed(root) for root in self.driver._roots(locator.window)):
                raise RuntimeError("觅元自身窗口不作为校验目标")
            matches = self.session.query(locator, timeout=0)
            if any(row["process"] in {self.exclude_pid, os.getpid()} for row in matches):
                raise RuntimeError("觅元自身窗口不作为校验目标")
            return {"total": len(matches), "matches": matches[:200], "truncated": len(matches) > 200}
        if action == "validate":
            return self.Locator.from_dict(request["locator"]).to_dict()
        if action == "load":
            return self.Locator.load(request["path"]).to_dict()
        if action == "save":
            locator = self.Locator.from_dict(request["locator"])
            locator.save(request["path"])
            return str(request["path"])
        raise ValueError(f"不支持的桌面请求: {action}")


def join_process_group():
    """Join before importing providers, even if a venv launcher won the spawn race."""
    name = os.environ.pop("ELEMLENS_DESKTOP_JOB", "")
    if not name or sys.platform != "win32":
        return
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenJobObjectW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.OpenJobObjectW.restype = wintypes.HANDLE
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenJobObjectW(0x0001 | 0x0004, False, name)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        member = wintypes.BOOL()
        process = kernel.GetCurrentProcess()
        if not kernel.IsProcessInJob(process, handle, ctypes.byref(member)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not member.value and not kernel.AssignProcessToJobObject(handle, process):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel.CloseHandle(handle)

def main():
    join_process_group()
    inspector = None
    backend = None
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                kind = request.get("backend", "uia")
                if inspector is None or kind != backend:
                    if inspector is not None:
                        inspector.close()
                    inspector = Inspector(kind, request.get("excludePid", 0))
                    backend = kind
                result = inspector.dispatch(request)
            response = {"id": request.get("id"), "ok": True, "result": result}
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            response = {"id": request.get("id"), "ok": False,
                        "error": str(exc), "errorType": type(exc).__name__}
        print(json.dumps(response, ensure_ascii=False), flush=True)
    if inspector is not None:
        with contextlib.redirect_stdout(sys.stderr):
            inspector.close()


if __name__ == "__main__":
    main()
