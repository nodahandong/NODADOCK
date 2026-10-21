//! Turns a saved drive + its secret into rclone remote-control calls.
use crate::models::{Drive, Provider, Secret, Settings};
use crate::platform;
use serde_json::{json, Value};

/// Quotes a value for an rclone connection string (`'...'`, quotes doubled).
fn q(v: &str) -> String {
    format!("'{}'", v.replace('\'', "''"))
}

/// rclone's reversible password "obscuring" (AES-256-CTR with rclone's
/// published key). rclone normally uses a random IV; we derive it from the
/// drive id + password so the same drive always produces the same remote
/// string. That keeps rclone's on-disk cache folder stable between
/// connections, so unfinished uploads resume after a restart.
pub fn obscure(drive_id: &str, password: &str) -> String {
    use aes::cipher::{KeyIvInit, StreamCipher};
    use base64::Engine;
    use sha2::{Digest, Sha256};
    const KEY: [u8; 32] = [
        0x9c, 0x93, 0x5b, 0x48, 0x73, 0x0a, 0x55, 0x4d, 0x6b, 0xfd, 0x7c, 0x63, 0xc8, 0x86, 0xa9, 0x2b,
        0xd3, 0x90, 0x19, 0x8e, 0xb8, 0x12, 0x8a, 0xfb, 0xf4, 0xde, 0x16, 0x2b, 0x8b, 0x95, 0xf6, 0x38,
    ];
    let digest = Sha256::digest(format!("{drive_id}\0{password}").as_bytes());
    let iv: [u8; 16] = digest[..16].try_into().unwrap();
    let mut buf = password.as_bytes().to_vec();
    ctr::Ctr128BE::<aes::Aes256>::new(&KEY.into(), &iv.into()).apply_keystream(&mut buf);
    let mut out = iv.to_vec();
    out.extend_from_slice(&buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(out)
}

/// Builds an on-the-fly rclone remote such as
/// `:webdav,url='https://…',user='bob',pass='<obscured>':Documents`.
/// Nothing is written to an rclone config file, and rclone logs the remote
/// under a hash (`:webdav{AbCd1}`) instead of these parameters.
pub fn fs_string(drive: &Drive, secret: &Secret, password: Option<&str>) -> Result<String, String> {
    let root = drive.remote_path.trim_matches('/');
    match &drive.provider {
        Provider::WebDav { url, vendor, username } => {
            let mut s = format!(":webdav,url={},vendor={}", q(url.trim()), q(vendor));
            if !username.is_empty() {
                s += &format!(",user={}", q(username));
            }
            if let Some(pw) = password.filter(|p| !p.is_empty()) {
                s += &format!(",pass={}", q(&obscure(&drive.id, pw)));
            }
            Ok(format!("{s}:{root}"))
        }
        Provider::GoogleDrive { shared_drive_id, client_id, .. } => {
            let token = secret.token.as_deref().ok_or("This Google Drive isn't signed in. Edit the drive and sign in again.")?;
            let mut s = format!(":drive,scope=drive,token={}", q(token));
            if !client_id.is_empty() {
                s += &format!(",client_id={}", q(client_id));
                if let Some(cs) = &secret.client_secret {
                    s += &format!(",client_secret={}", q(cs));
                }
            }
            if !shared_drive_id.is_empty() {
                s += &format!(",team_drive={}", q(shared_drive_id));
            }
            Ok(format!("{s}:{root}"))
        }
    }
}

pub enum MountType {
    Fuse,
    Nfs,
}

pub fn mount_type(settings: &Settings) -> MountType {
    if cfg!(target_os = "macos") {
        let fuse = platform::driver_status().installed;
        match settings.mac_mount_backend.as_str() {
            "fuse" => MountType::Fuse,
            "nfs" => MountType::Nfs,
            _ if fuse => MountType::Fuse,
            _ => MountType::Nfs,
        }
    } else {
        MountType::Fuse
    }
}

/// Where this drive will appear: its chosen letter/folder, or a sensible default.
pub fn resolve_mount_point(drive: &Drive, taken: &[String]) -> Result<String, String> {
    if !drive.mount_point.trim().is_empty() {
        let mp = drive.mount_point.trim().to_string();
        if cfg!(windows) && platform::is_drive_letter(&mp) {
            let mp = mp.to_uppercase();
            if !platform::free_drive_letters().contains(&mp) {
                return Err(format!("Drive letter {mp} is already in use. Pick another letter in the drive's settings."));
            }
            return Ok(mp);
        }
        return Ok(mp);
    }
    if cfg!(windows) {
        // Prefer letters from the end of the alphabet, like mapped network drives.
        return platform::free_drive_letters()
            .into_iter()
            .rev()
            .find(|l| !taken.contains(l))
            .ok_or_else(|| "No free drive letters left.".to_string());
    }
    let base = platform::mount_root().join(platform::sanitize_name(&drive.name));
    Ok(base.to_string_lossy().into_owned())
}

pub fn mount_params(drive: &Drive, fs: &str, mount_point: &str, settings: &Settings) -> Value {
    let kind = match mount_type(settings) {
        MountType::Fuse => "mount",
        MountType::Nfs => "nfsmount",
    };
    let mut mount_opt = json!({ "VolumeName": drive.name });
    if cfg!(windows) && drive.network_mode {
        mount_opt["NetworkMode"] = json!(true);
    }
    json!({
        "fs": fs,
        "mountPoint": mount_point,
        "mountType": kind,
        "mountOpt": mount_opt,
        "vfsOpt": {
            "CacheMode": drive.cache_mode,
            "CacheMaxSize": format!("{}G", settings.cache_max_size_gb.max(1)),
            "ReadOnly": drive.read_only,
        }
    })
}

pub const BAD_PASSWORD: &str = "The server didn't accept the username or password.";

/// Rewrites rclone's raw errors into something a person can act on.
pub fn friendly_error(raw: &str) -> String {
    let l = raw.to_lowercase();
    let msg = if l.contains("401") || l.contains("unauthorized") || l.contains("authentication") {
        BAD_PASSWORD
    } else if l.contains("invalid_grant") || l.contains("token expired") || l.contains("oauth2") {
        "Google sign-in has expired or was revoked. Edit the drive and sign in again."
    } else if l.contains("winfsp") || l.contains("cgofuse") || l.contains("fuse") && l.contains("not") {
        "The file-system driver isn't installed. Open Settings to install it."
    } else if l.contains("no such host") || l.contains("connection refused") || l.contains("dial tcp") || l.contains("network is unreachable") {
        "Can't reach the server. Check the address and your internet connection."
    } else if l.contains("x509") || l.contains("certificate") {
        "The server's security certificate isn't trusted."
    } else if l.contains("404") || l.contains("not found") && l.contains("directory") {
        "That folder doesn't exist on the server."
    } else if l.contains("already") && (l.contains("mount") || l.contains("in use") || l.contains("exists")) {
        "That drive letter or folder is already in use."
    } else {
        return raw.to_string();
    };
    msg.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_values() {
        assert_eq!(q("it's"), "'it''s'");
        assert_eq!(q("https://a:b/c"), "'https://a:b/c'");
    }

    #[test]
    fn obscure_is_stable() {
        assert_eq!(obscure("a", "pw"), obscure("a", "pw"));
        assert_ne!(obscure("a", "pw"), obscure("b", "pw"));
    }

    #[test]
    fn friendly_errors() {
        assert!(friendly_error("401 Unauthorized").contains("password"));
        assert!(friendly_error("dial tcp: lookup x: no such host").contains("reach"));
        assert_eq!(friendly_error("weird"), "weird");
    }
}
