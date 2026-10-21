use serde::{Deserialize, Serialize};

/// Where a drive's files live. Secrets (passwords, OAuth tokens) are never
/// part of this struct; they live in the OS credential store (see `secrets`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum Provider {
    #[serde(rename = "webdav", rename_all = "camelCase")]
    WebDav {
        url: String,
        #[serde(default = "default_vendor")]
        vendor: String,
        #[serde(default)]
        username: String,
    },
    #[serde(rename = "gdrive", rename_all = "camelCase")]
    GoogleDrive {
        #[serde(default)]
        account: String,
        #[serde(default)]
        shared_drive_id: String,
        #[serde(default)]
        shared_drive_name: String,
        #[serde(default)]
        client_id: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Drive {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub provider: Provider,
    /// Folder on the server to use as the drive's root ("" = top level).
    #[serde(default)]
    pub remote_path: String,
    /// "Z:" on Windows, a folder path on macOS/Linux, "" = pick automatically.
    #[serde(default)]
    pub mount_point: String,
    #[serde(default = "yes")]
    pub auto_mount: bool,
    /// false = ask for the password every time the app starts.
    #[serde(default = "yes")]
    pub remember_password: bool,
    #[serde(default)]
    pub read_only: bool,
    /// rclone VFS cache mode: off | minimal | writes | full
    #[serde(default = "default_cache_mode")]
    pub cache_mode: String,
    /// Windows only: show as a network drive instead of a local disk.
    #[serde(default)]
    pub network_mode: bool,
    #[serde(default)]
    pub color: String,
}

impl Drive {
    pub fn is_webdav(&self) -> bool {
        matches!(self.provider, Provider::WebDav { .. })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "yes")]
    pub launch_at_login: bool,
    #[serde(default = "yes")]
    pub start_minimized: bool,
    #[serde(default = "yes")]
    pub close_to_tray: bool,
    /// system | light | dark
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_cache_size")]
    pub cache_max_size_gb: u32,
    /// macOS only: auto | fuse | nfs
    #[serde(default = "default_auto")]
    pub mac_mount_backend: String,
}

impl Default for Settings {
    fn default() -> Self {
        serde_json::from_str("{}").expect("defaults")
    }
}

/// Everything secret about a drive, stored as one JSON blob in the keychain.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Secret {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
}

impl Secret {
    pub fn is_empty(&self) -> bool {
        self.password.is_none() && self.token.is_none() && self.client_secret.is_none()
    }
}

fn yes() -> bool {
    true
}
fn default_vendor() -> String {
    "other".into()
}
fn default_cache_mode() -> String {
    "full".into()
}
fn default_theme() -> String {
    "system".into()
}
fn default_cache_size() -> u32 {
    10
}
fn default_auto() -> String {
    "auto".into()
}
