//! Own the entire Python process group, including Windows venv launchers.
#[cfg(windows)]
mod platform {
    use std::{
        ptr::null,
        time::{SystemTime, UNIX_EPOCH},
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::*,
    };
    pub struct WorkerJob {
        handle: isize,
        name: String,
    }
    impl WorkerJob {
        pub fn new() -> Result<Self, String> {
            let name = format!(
                "Local\\ElemLensDesktop-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            );
            let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            unsafe {
                let handle = CreateJobObjectW(null(), wide.as_ptr());
                if handle.is_null() {
                    return Err(format!(
                        "无法创建桌面进程组：{}",
                        std::io::Error::last_os_error()
                    ));
                }
                let job = Self {
                    handle: handle as isize,
                    name,
                };
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as _,
                    std::mem::size_of_val(&limits) as u32,
                ) == 0
                {
                    return Err(format!(
                        "无法设置桌面进程清理：{}",
                        std::io::Error::last_os_error()
                    ));
                }
                Ok(job)
            }
        }
        pub fn configure(&self, command: &mut tokio::process::Command) {
            command.env("ELEMLENS_DESKTOP_JOB", &self.name);
        }
        pub fn assign(&self, child: &tokio::process::Child) -> Result<(), String> {
            let handle = child.raw_handle().ok_or("桌面工作进程已退出")?;
            if unsafe { AssignProcessToJobObject(self.handle as HANDLE, handle) } == 0 {
                return Err(format!(
                    "无法管理桌面工作进程：{}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(())
        }
    }
    impl Drop for WorkerJob {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.handle as HANDLE);
            }
        }
    }
}
#[cfg(not(windows))]
mod platform {
    pub struct WorkerJob;
    impl WorkerJob {
        pub fn new() -> Result<Self, String> {
            Ok(Self)
        }
        pub fn configure(&self, _: &mut tokio::process::Command) {}
        pub fn assign(&self, _: &tokio::process::Child) -> Result<(), String> {
            Ok(())
        }
    }
}
pub use platform::WorkerJob;
