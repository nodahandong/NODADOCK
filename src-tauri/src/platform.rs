//! OS-specific bits: which file-system driver is available, and which drive
//! letters / mount folders can be used.
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverStatus {
    pub os: &'static str,
    /// Name of the driver that will be used, e.g. "WinFsp", "macFUSE", "FUSE-T".
    pub driver: String,
    pub installed: bool,
    /// macOS can always fall back to the built-in NFS client.
    pub fallback: Option<String>,
    pub install_url: Option<String>,
}

pub fn os_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

#[cfg(windows)]
pub fn driver_status() -> DriverStatus {
    let mut roots = Vec::new();
    for var in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(p) = std::env::var_os(var) {
            roots.push(PathBuf::from(p).join("WinFsp").join("bin"));
        }
    }
    let installed = roots.iter().any(|r| {
        ["winfsp-x64.dll", "winfsp-a64.dll", "winfsp-x86.dll"].iter().any(|dll| r.join(dll).is_file())
    });
    DriverStatus {
        os: os_name(),
        driver: "WinFsp".into(),
        installed,
        fallback: None,
        install_url: Some("https://winfsp.dev/rel/".into()),
    }
}

#[cfg(target_os = "macos")]
pub fn driver_status() -> DriverStatus {
    let fuse_t = Path::new("/usr/local/lib/libfuse-t.dylib").exists()
        || Path::new("/Library/Application Support/fuse-t").exists();
    let macfuse = Path::new("/Library/Filesystems/macfuse.fs").exists();
    let driver = if macfuse { "macFUSE" } else { "FUSE-T" };
    DriverStatus {
        os: os_name(),
        driver: driver.into(),
        installed: macfuse || fuse_t,
        fallback: Some("Built-in NFS".into()),
        install_url: Some("https://www.fuse-t.org/".into()),
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn driver_status() -> DriverStatus {
    DriverStatus {
        os: os_name(),
        driver: "FUSE".into(),
        installed: Path::new("/dev/fuse").exists(),
        fallback: None,
        install_url: None,
    }
}

/// Drive letters not currently used by Windows, D: to Z:.
#[cfg(windows)]
pub fn free_drive_letters() -> Vec<String> {
    let used = unsafe { windows_sys::Win32::Storage::FileSystem::GetLogicalDrives() };
    (b'D'..=b'Z')
        .filter(|c| used & (1 << (c - b'A')) == 0)
        .map(|c| format!("{}:", c as char))
        .collect()
}

#[cfg(not(windows))]
pub fn free_drive_letters() -> Vec<String> {
    Vec::new()
}

/// Folder that holds automatically-created mount points on macOS/Linux.
pub fn mount_root() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp")).join("CloudDock")
}

pub fn sanitize_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || " -_.".contains(c) { c } else { '-' })
        .collect();
    let s = s.trim().trim_matches('.').to_string();
    if s.is_empty() { "Drive".into() } else { s }
}

pub fn is_drive_letter(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

#[allow(dead_code)]
pub fn path_exists(p: &str) -> bool {
    Path::new(p).exists()
}
