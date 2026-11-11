//! Native picking and non-activating, click-through borders. No UIA calls here.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Rectangle {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}
impl Rectangle {
    fn dimensions(&self) -> Result<(i32, i32), String> {
        let width = self.right.checked_sub(self.left).ok_or("无效矩形")?;
        let height = self.bottom.checked_sub(self.top).ok_or("无效矩形")?;
        if width <= 0 || height <= 0 {
            return Err("元素没有可高亮的矩形".into());
        }
        Ok((width, height))
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct NativeEvent {
    pub kind: String,
    pub session: String,
    pub sequence: u64,
    pub x: i32,
    pub y: i32,
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        cell::RefCell,
        ptr::{null, null_mut},
        sync::{mpsc, Arc},
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::*,
        Graphics::Gdi::*,
        System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
        UI::{
            HiDpi::SetThreadDpiAwarenessContext, Input::KeyboardAndMouse::*, WindowsAndMessaging::*,
        },
    };
    const WAKE: u32 = WM_APP + 77;
    type Sink = Box<dyn Fn(NativeEvent) + Send>;
    enum Command {
        Start(String, mpsc::Sender<Result<(), String>>),
        Stop(mpsc::Sender<Result<(), String>>),
        Show(Option<Rectangle>, Option<String>, u64, u64),
        Shutdown,
    }
    struct Inner {
        sender: mpsc::Sender<Command>,
        thread: u32,
    }
    impl Drop for Inner {
        fn drop(&mut self) {
            let _ = self.sender.send(Command::Shutdown);
            unsafe {
                PostThreadMessageW(self.thread, WAKE, 0, 0);
            }
        }
    }
    #[derive(Clone)]
    pub struct Control(Arc<Inner>);
    impl Control {
        pub fn new(
            exclude_pid: u32,
            sink: impl Fn(NativeEvent) + Send + 'static,
        ) -> Result<Self, String> {
            let (sender, receiver) = mpsc::channel();
            let (ready_tx, ready_rx) = mpsc::channel();
            std::thread::Builder::new()
                .name("desktop-picker".into())
                .spawn(move || unsafe {
                    SetThreadDpiAwarenessContext(-4isize as _);
                    let mut message: MSG = std::mem::zeroed();
                    PeekMessageW(&mut message, null_mut(), 0, 0, PM_NOREMOVE);
                    let borders = match create_borders() {
                        Ok(borders) => borders,
                        Err(error) => {
                            let _ = ready_tx.send(Err(error));
                            return;
                        }
                    };
                    CONTEXT.with(|cell| {
                        *cell.borrow_mut() = Some(Context {
                            sink: Box::new(sink),
                            exclude_pid,
                            borders,
                            mouse: null_mut(),
                            keyboard: null_mut(),
                            session: None,
                            active: false,
                            swallow_up: false,
                            escape_up: false,
                            pending: None,
                            sequence: 0,
                            painted_sequence: 0,
                            last_point: None,
                            shown_until: None,
                        })
                    });
                    SetTimer(null_mut(), 1, 33, None);
                    let _ = ready_tx.send(Ok(GetCurrentThreadId()));
                    while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
                        if message.message == WAKE {
                            let mut shutdown = false;
                            while let Ok(command) = receiver.try_recv() {
                                CONTEXT.with(|cell| {
                                    let mut slot = cell.borrow_mut();
                                    let context = slot.as_mut().unwrap();
                                    match command {
                                        Command::Start(session, reply) => {
                                            context.stop();
                                            let result = if context.swallow_up || context.escape_up
                                            {
                                                Err("请先松开鼠标和 Esc，再开始捕获".into())
                                            } else {
                                                context.start(session)
                                            };
                                            let _ = reply.send(result);
                                        }
                                        Command::Stop(reply) => {
                                            context.stop();
                                            let _ = reply.send(Ok(()));
                                        }
                                        Command::Show(rectangle, session, sequence, duration) => {
                                            context.update_highlight(
                                                rectangle, session, sequence, duration,
                                            );
                                        }
                                        Command::Shutdown => {
                                            context.stop();
                                            shutdown = true;
                                        }
                                    }
                                });
                            }
                            if shutdown {
                                break;
                            }
                        } else if message.message == WM_TIMER {
                            CONTEXT.with(|cell| {
                                if let Some(context) = cell.borrow_mut().as_mut() {
                                    context.tick();
                                }
                            });
                        } else {
                            TranslateMessage(&message);
                            DispatchMessageW(&message);
                        }
                    }
                    CONTEXT.with(|cell| {
                        if let Some(mut context) = cell.borrow_mut().take() {
                            context.unhook();
                            for window in context.borders {
                                DestroyWindow(window);
                            }
                        }
                    });
                })
                .map_err(|error| error.to_string())?;
            let thread = ready_rx
                .recv_timeout(Duration::from_secs(3))
                .map_err(|_| "原生捕获线程启动超时")??;
            Ok(Self(Arc::new(Inner { sender, thread })))
        }
        fn send(&self, command: Command) -> Result<(), String> {
            self.0
                .sender
                .send(command)
                .map_err(|_| "原生捕获线程已退出")?;
            if unsafe { PostThreadMessageW(self.0.thread, WAKE, 0, 0) } == 0 {
                return Err("无法唤醒原生捕获线程".into());
            }
            Ok(())
        }
        pub fn start(&self, session: String) -> Result<(), String> {
            let (tx, rx) = mpsc::channel();
            self.send(Command::Start(session, tx))?;
            rx.recv_timeout(Duration::from_secs(2))
                .map_err(|_| "开始捕获超时")?
        }
        pub fn stop(&self) -> Result<(), String> {
            let (tx, rx) = mpsc::channel();
            self.send(Command::Stop(tx))?;
            rx.recv_timeout(Duration::from_secs(2))
                .map_err(|_| "取消捕获超时")?
        }
        pub fn clear(&self, session: Option<String>, sequence: u64) -> Result<(), String> {
            self.send(Command::Show(None, session, sequence, 0))
        }
        pub fn highlight(
            &self,
            rectangle: Rectangle,
            session: Option<String>,
            sequence: u64,
            duration: u64,
        ) -> Result<(), String> {
            rectangle.dimensions()?;
            let bounds = RECT {
                left: rectangle.left,
                top: rectangle.top,
                right: rectangle.right,
                bottom: rectangle.bottom,
            };
            if unsafe { MonitorFromRect(&bounds, MONITOR_DEFAULTTONULL) }.is_null() {
                return Err("元素在所有显示器范围之外，无法高亮".into());
            }
            self.send(Command::Show(
                Some(rectangle),
                session,
                sequence,
                duration.min(3000),
            ))
        }
    }
    struct Context {
        sink: Sink,
        exclude_pid: u32,
        borders: [HWND; 4],
        mouse: HHOOK,
        keyboard: HHOOK,
        session: Option<String>,
        active: bool,
        swallow_up: bool,
        escape_up: bool,
        pending: Option<NativeEvent>,
        sequence: u64,
        painted_sequence: u64,
        last_point: Option<(i32, i32)>,
        shown_until: Option<Instant>,
    }
    thread_local! { static CONTEXT: RefCell<Option<Context>> = const { RefCell::new(None) }; }
    impl Context {
        unsafe fn update_highlight(
            &mut self,
            rectangle: Option<Rectangle>,
            session: Option<String>,
            sequence: u64,
            duration: u64,
        ) {
            if session.as_ref().is_none_or(|id| {
                self.session.as_ref() == Some(id)
                    && sequence > self.painted_sequence
                    && sequence <= self.sequence
                    && (self.active || sequence == self.sequence)
            }) {
                if session.is_some() {
                    self.painted_sequence = sequence;
                }
                if let Some(rectangle) = rectangle {
                    self.show(&rectangle, duration);
                    // Keep the current hover visible until its replacement
                    // arrives or capture ends; a stationary cursor is valid.
                    if session.is_some() && self.active {
                        self.shown_until = None;
                    }
                } else {
                    self.hide();
                }
            }
        }
        unsafe fn start(&mut self, session: String) -> Result<(), String> {
            self.mouse =
                SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), GetModuleHandleW(null()), 0);
            self.keyboard =
                SetWindowsHookExW(WH_KEYBOARD_LL, Some(key_hook), GetModuleHandleW(null()), 0);
            if self.mouse.is_null() || self.keyboard.is_null() {
                self.unhook();
                return Err("无法安装捕获钩子".into());
            }
            self.session = Some(session);
            self.sequence = 0;
            self.painted_sequence = 0;
            self.last_point = None;
            self.active = true;
            Ok(())
        }
        unsafe fn unhook(&mut self) {
            if !self.mouse.is_null() {
                UnhookWindowsHookEx(self.mouse);
                self.mouse = null_mut();
            }
            if !self.keyboard.is_null() {
                UnhookWindowsHookEx(self.keyboard);
                self.keyboard = null_mut();
            }
        }
        unsafe fn stop(&mut self) {
            self.active = false;
            self.session = None;
            self.pending = None;
            self.hide();
            // A captured mouse down must always consume its matching mouse up.
            if !self.swallow_up && !self.escape_up {
                self.unhook();
            }
        }
        unsafe fn hide(&mut self) {
            for window in self.borders {
                ShowWindow(window, SW_HIDE);
            }
            self.shown_until = None;
        }
        unsafe fn show(&mut self, rectangle: &Rectangle, duration: u64) {
            let Ok((width, height)) = rectangle.dimensions() else {
                self.hide();
                return;
            };
            let thickness = 3.min(width).min(height);
            let strips = [
                (rectangle.left, rectangle.top, width, thickness),
                (
                    rectangle.left,
                    rectangle.bottom - thickness,
                    width,
                    thickness,
                ),
                (rectangle.left, rectangle.top, thickness, height),
                (
                    rectangle.right - thickness,
                    rectangle.top,
                    thickness,
                    height,
                ),
            ];
            for (window, (x, y, width, height)) in self.borders.iter().zip(strips) {
                SetWindowPos(
                    *window,
                    HWND_TOPMOST,
                    x,
                    y,
                    width,
                    height,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
            self.shown_until = Some(Instant::now() + Duration::from_millis(duration));
        }
        unsafe fn event(&mut self, kind: &str, point: POINT) -> NativeEvent {
            self.sequence += 1;
            NativeEvent {
                kind: kind.into(),
                session: self.session.clone().unwrap_or_default(),
                sequence: self.sequence,
                x: point.x,
                y: point.y,
            }
        }
        unsafe fn tick(&mut self) {
            if let Some(event) = self.pending.take() {
                (self.sink)(event);
            }
            if !self.active && !self.swallow_up && !self.escape_up {
                self.unhook();
            }
            if self
                .shown_until
                .is_some_and(|until| Instant::now() >= until)
            {
                self.hide();
            }
            if self.active {
                let mut point = POINT { x: 0, y: 0 };
                if GetCursorPos(&mut point) != 0 && self.last_point != Some((point.x, point.y)) {
                    self.last_point = Some((point.x, point.y));
                    let event = self.event("hover", point);
                    (self.sink)(event);
                }
            }
        }
    }
    #[cfg(test)]
    mod hover_acceptance {
        use super::*;
        #[test]
        fn hover_frame_survives_delayed_results_and_clears() {
            unsafe {
                SetThreadDpiAwarenessContext(-4isize as _);
                let borders = create_borders().unwrap();
                let mut context = Context {
                    sink: Box::new(|_| {}),
                    exclude_pid: 0,
                    borders,
                    mouse: null_mut(),
                    keyboard: null_mut(),
                    session: Some("hover".into()),
                    active: true,
                    swallow_up: false,
                    escape_up: false,
                    pending: None,
                    sequence: 2,
                    painted_sequence: 0,
                    last_point: None,
                    shown_until: None,
                };
                let rectangle = Rectangle {
                    left: 100,
                    top: 100,
                    right: 200,
                    bottom: 160,
                };
                // Result 1 arrives after cursor event 2: it must still paint.
                context.update_highlight(Some(rectangle.clone()), Some("hover".into()), 1, 100);
                assert!(borders.iter().all(|window| IsWindowVisible(*window) != 0));
                std::thread::sleep(Duration::from_millis(700));
                context.tick();
                assert!(
                    borders.iter().all(|window| IsWindowVisible(*window) != 0),
                    "stationary hover must remain visible"
                );
                // A newer result clears the frame over our own window. Old
                // results must neither bring it back nor cross capture sessions.
                context.update_highlight(None, Some("hover".into()), 2, 0);
                assert!(borders.iter().all(|window| IsWindowVisible(*window) == 0));
                context.update_highlight(Some(rectangle.clone()), Some("hover".into()), 1, 600);
                assert!(borders.iter().all(|window| IsWindowVisible(*window) == 0));
                context.update_highlight(
                    Some(rectangle.clone()),
                    Some("old-session".into()),
                    3,
                    600,
                );
                assert!(borders.iter().all(|window| IsWindowVisible(*window) == 0));
                context.update_highlight(Some(rectangle.clone()), Some("hover".into()), 3, 600);
                assert!(borders.iter().all(|window| IsWindowVisible(*window) != 0));
                context.stop();
                context.update_highlight(Some(rectangle), Some("hover".into()), 4, 600);
                assert!(borders.iter().all(|window| IsWindowVisible(*window) == 0));
                for window in borders {
                    DestroyWindow(window);
                }
            }
        }
    }
    unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let consume = CONTEXT.with(|cell| {
                let mut slot = cell.borrow_mut();
                let Some(context) = slot.as_mut() else {
                    return false;
                };
                if wparam as u32 == WM_LBUTTONUP && context.swallow_up {
                    context.swallow_up = false;
                    return true;
                }
                if wparam as u32 == WM_LBUTTONDOWN
                    && context.active
                    && GetAsyncKeyState(VK_CONTROL as i32) < 0
                {
                    let point = (*(lparam as *const MSLLHOOKSTRUCT)).pt;
                    let window = WindowFromPoint(point);
                    let mut pid = 0;
                    GetWindowThreadProcessId(window, &mut pid);
                    if window.is_null() || pid == context.exclude_pid {
                        return false;
                    }
                    context.swallow_up = true;
                    context.active = false;
                    context.pending = Some(context.event("capture", point));
                    return true;
                }
                false
            });
            if consume {
                return 1;
            }
        }
        CallNextHookEx(null_mut(), code, wparam, lparam)
    }
    unsafe extern "system" fn key_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let consume = CONTEXT.with(|cell| {
                let mut slot = cell.borrow_mut();
                let Some(context) = slot.as_mut() else {
                    return false;
                };
                if (*(lparam as *const KBDLLHOOKSTRUCT)).vkCode == VK_ESCAPE as u32 {
                    if matches!(wparam as u32, WM_KEYUP | WM_SYSKEYUP) && context.escape_up {
                        context.escape_up = false;
                        return true;
                    }
                    if matches!(wparam as u32, WM_KEYDOWN | WM_SYSKEYDOWN) && context.escape_up {
                        return true;
                    }
                    if matches!(wparam as u32, WM_KEYDOWN | WM_SYSKEYDOWN) && context.active {
                        context.active = false;
                        context.escape_up = true;
                        context.hide();
                        context.pending = Some(context.event("cancel", POINT { x: 0, y: 0 }));
                        return true;
                    }
                }
                false
            });
            if consume {
                return 1;
            }
        }
        CallNextHookEx(null_mut(), code, wparam, lparam)
    }
    unsafe extern "system" fn border_proc(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == WM_NCHITTEST {
            return HTTRANSPARENT as isize;
        }
        if message == WM_MOUSEACTIVATE {
            return MA_NOACTIVATE as isize;
        }
        DefWindowProcW(window, message, wparam, lparam)
    }
    unsafe fn create_borders() -> Result<[HWND; 4], String> {
        let class: Vec<u16> = "ElemLensDesktopBorder\0".encode_utf16().collect();
        let instance = GetModuleHandleW(null());
        let definition = WNDCLASSW {
            lpfnWndProc: Some(border_proc),
            hInstance: instance,
            lpszClassName: class.as_ptr(),
            hbrBackground: CreateSolidBrush(0x004343ec),
            ..std::mem::zeroed()
        };
        RegisterClassW(&definition);
        let mut borders: [HWND; 4] = [null_mut(); 4];
        for index in 0..4 {
            let window = CreateWindowExW(
                WS_EX_LAYERED
                    | WS_EX_TRANSPARENT
                    | WS_EX_NOACTIVATE
                    | WS_EX_TOOLWINDOW
                    | WS_EX_TOPMOST,
                class.as_ptr(),
                class.as_ptr(),
                WS_POPUP,
                0,
                0,
                1,
                1,
                null_mut(),
                null_mut(),
                instance,
                null(),
            );
            if window.is_null() {
                for window in borders {
                    if !window.is_null() {
                        DestroyWindow(window);
                    }
                }
                return Err("无法创建桌面高亮边框".into());
            }
            SetLayeredWindowAttributes(window, 0, 225, LWA_ALPHA);
            borders[index] = window;
        }
        Ok(borders)
    }
}
#[cfg(windows)]
pub use platform::Control;

#[cfg(not(windows))]
#[derive(Clone)]
pub struct Control;
#[cfg(not(windows))]
impl Control {
    pub fn new(_: u32, _: impl Fn(NativeEvent) + Send + 'static) -> Result<Self, String> {
        Err("桌面元素仅支持 Windows".into())
    }
    pub fn start(&self, _: String) -> Result<(), String> {
        Err("桌面元素仅支持 Windows".into())
    }
    pub fn stop(&self) -> Result<(), String> {
        Ok(())
    }
    pub fn clear(&self, _: Option<String>, _: u64) -> Result<(), String> {
        Ok(())
    }
    pub fn highlight(&self, _: Rectangle, _: Option<String>, _: u64, _: u64) -> Result<(), String> {
        Err("桌面元素仅支持 Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rectangles_accept_negative_monitor_coordinates() {
        assert_eq!(
            Rectangle {
                left: -1920,
                top: -200,
                right: -1820,
                bottom: 100
            }
            .dimensions()
            .unwrap(),
            (100, 300)
        );
        assert!(Rectangle {
            left: i32::MIN,
            top: 0,
            right: i32::MAX,
            bottom: 1
        }
        .dimensions()
        .is_err());
        assert!(Rectangle {
            left: 0,
            top: 0,
            right: 0,
            bottom: 1
        }
        .dimensions()
        .is_err());
    }
}

#[cfg(all(test, windows))]
mod native_acceptance {
    use super::*;
    use std::{
        ptr::{null, null_mut},
        sync::{
            atomic::{AtomicU32, Ordering},
            mpsc,
        },
        time::Duration,
    };
    use windows_sys::Win32::{
        Foundation::*,
        Graphics::Gdi::ClientToScreen,
        System::LibraryLoader::GetModuleHandleW,
        UI::HiDpi::SetThreadDpiAwarenessContext,
        UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    };
    static DOWNS: AtomicU32 = AtomicU32::new(0);
    static UPS: AtomicU32 = AtomicU32::new(0);
    unsafe extern "system" fn procedure(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_LBUTTONDOWN => {
                DOWNS.fetch_add(1, Ordering::SeqCst);
                0
            }
            WM_LBUTTONUP => {
                UPS.fetch_add(1, Ordering::SeqCst);
                0
            }
            WM_CLOSE => {
                DestroyWindow(window);
                0
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(window, message, wparam, lparam),
        }
    }
    fn settle() {
        std::thread::sleep(Duration::from_millis(180));
    }
    unsafe fn click() {
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
        settle();
    }
    struct Fixture {
        window: isize,
        thread: Option<std::thread::JoinHandle<()>>,
        point: POINT,
        previous_point: POINT,
        previous_window: isize,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            unsafe {
                keybd_event(VK_CONTROL as u8, 0, KEYEVENTF_KEYUP, 0);
                keybd_event(VK_ESCAPE as u8, 0, KEYEVENTF_KEYUP, 0);
                mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
                PostMessageW(self.window as HWND, WM_CLOSE, 0, 0);
                SetCursorPos(self.previous_point.x, self.previous_point.y);
                SetForegroundWindow(self.previous_window as HWND);
            }
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }
    #[test]
    #[ignore = "Moves the cursor only inside a disposable test window; run explicitly on a Windows desktop"]
    fn capture_consumes_both_edges_and_highlight_is_transparent() {
        unsafe {
            SetThreadDpiAwarenessContext(-4isize as _);
            let mut previous_point = POINT { x: 0, y: 0 };
            GetCursorPos(&mut previous_point);
            let previous_window = GetForegroundWindow() as isize;
            let (tx, rx) = mpsc::channel();
            let thread = std::thread::spawn(move || {
                SetThreadDpiAwarenessContext(-4isize as _);
                let class: Vec<u16> = "ElemLensCaptureAcceptance\0".encode_utf16().collect();
                let instance = GetModuleHandleW(null());
                let cls = WNDCLASSW {
                    lpfnWndProc: Some(procedure),
                    hInstance: instance,
                    lpszClassName: class.as_ptr(),
                    ..std::mem::zeroed()
                };
                RegisterClassW(&cls);
                let window = CreateWindowExW(
                    0,
                    class.as_ptr(),
                    class.as_ptr(),
                    WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                    100,
                    100,
                    500,
                    300,
                    null_mut(),
                    null_mut(),
                    instance,
                    null(),
                );
                tx.send(window as isize).unwrap();
                let mut message = std::mem::zeroed();
                while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            });
            let window = rx.recv_timeout(Duration::from_secs(3)).unwrap();
            assert_ne!(window, 0);
            let mut point = POINT { x: 80, y: 80 };
            ClientToScreen(window as HWND, &mut point);
            let fixture = Fixture {
                window,
                thread: Some(thread),
                point,
                previous_point,
                previous_window,
            };
            SetWindowPos(
                window as HWND,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE,
            );
            SetForegroundWindow(window as HWND);
            SetCursorPos(fixture.point.x, fixture.point.y);
            settle();
            assert_eq!(
                WindowFromPoint(point),
                window as HWND,
                "test window must own the probe point"
            );
            let (events, received) = mpsc::channel();
            let control = Control::new(0, move |event| {
                let _ = events.send(event);
            })
            .unwrap();
            control.start("capture".into()).unwrap();
            click();
            assert_eq!(
                (DOWNS.load(Ordering::SeqCst), UPS.load(Ordering::SeqCst)),
                (1, 1),
                "ordinary click passes through"
            );
            keybd_event(VK_CONTROL as u8, 0, 0, 0);
            settle();
            click();
            keybd_event(VK_CONTROL as u8, 0, KEYEVENTF_KEYUP, 0);
            settle();
            assert_eq!(
                (DOWNS.load(Ordering::SeqCst), UPS.load(Ordering::SeqCst)),
                (1, 1),
                "capture consumes down AND up"
            );
            let captured = received
                .try_iter()
                .find(|e| e.kind == "capture")
                .expect("capture event");
            assert_eq!((captured.x, captured.y), (point.x, point.y));
            let foreground = GetForegroundWindow();
            let rectangle = Rectangle {
                left: point.x - 30,
                top: point.y,
                right: point.x + 100,
                bottom: point.y + 80,
            };
            assert!(
                control
                    .highlight(
                        Rectangle {
                            left: i32::MAX - 100,
                            top: i32::MAX - 100,
                            right: i32::MAX,
                            bottom: i32::MAX
                        },
                        None,
                        0,
                        100
                    )
                    .is_err(),
                "offscreen rectangles report a reason"
            );
            control.highlight(rectangle, None, 0, 1500).unwrap();
            settle();
            assert_eq!(
                GetForegroundWindow(),
                foreground,
                "highlight does not activate"
            );
            click();
            assert_eq!(
                DOWNS.load(Ordering::SeqCst),
                2,
                "click passes through border"
            );
            control.start("cancel".into()).unwrap();
            keybd_event(VK_ESCAPE as u8, 0, 0, 0);
            keybd_event(VK_ESCAPE as u8, 0, KEYEVENTF_KEYUP, 0);
            settle();
            assert!(received.try_iter().any(|e| e.kind == "cancel"));
            keybd_event(VK_CONTROL as u8, 0, 0, 0);
            settle();
            click();
            keybd_event(VK_CONTROL as u8, 0, KEYEVENTF_KEYUP, 0);
            assert_eq!(DOWNS.load(Ordering::SeqCst), 3, "Esc releases capture");
            control.start("cancel-between-edges".into()).unwrap();
            keybd_event(VK_CONTROL as u8, 0, 0, 0);
            settle();
            mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
            settle();
            control.stop().unwrap();
            mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
            keybd_event(VK_CONTROL as u8, 0, KEYEVENTF_KEYUP, 0);
            settle();
            assert_eq!(
                (DOWNS.load(Ordering::SeqCst), UPS.load(Ordering::SeqCst)),
                (3, 3),
                "cancel after captured down still consumes up"
            );
            drop(control);
            settle();
            click();
            assert_eq!(DOWNS.load(Ordering::SeqCst), 4, "shutdown releases hooks");
        }
    }
}
