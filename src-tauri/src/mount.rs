//! Turns a saved drive + its secret into rclone remote-control calls.
use crate::models::{Drive, Provider, Secret, Settings, OAUTH_BACKENDS, PASSWORD_BACKENDS};
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
            if drive.allow_self_signed {
                s += ",override.no_check_certificate=true";
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
        Provider::Cloud { backend, options, .. } => {
            let b = backend.as_str();
            if !OAUTH_BACKENDS.contains(&b) && !PASSWORD_BACKENDS.contains(&b) {
                return Err(format!("Unsupported service: {backend}"));
            }
            let mut s = format!(":{b}");
            for (k, v) in options {
                if v.trim().is_empty() {
                    continue;
                }
                if !k.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
                    return Err(format!("Invalid setting name: {k}"));
                }
                s += &format!(",{k}={}", q(v.trim()));
            }
            if OAUTH_BACKENDS.contains(&b) {
                let token = secret.token.as_deref().ok_or("This drive isn't signed in. Edit the drive and sign in again.")?;
                s += &format!(",token={}", q(token));
                if let Some(cs) = &secret.client_secret {
                    s += &format!(",client_secret={}", q(cs));
                }
            } else if let Some(pw) = password.filter(|p| !p.is_empty()) {
                s += &match b {
                    "s3" => format!(",secret_access_key={}", q(pw)),
                    "b2" => format!(",key={}", q(pw)),
                    _ => format!(",pass={}", q(&obscure(&drive.id, pw))),
                };
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

/// Picks the rclone mount implementation from those this rclone build has
/// (`mount/types`). On Windows and macOS the FUSE one is registered for the
/// remote-control API as "cmount", on Linux as "mount".
pub fn pick_mount_type(settings: &Settings, available: &[String]) -> String {
    let wanted: &[&str] = match mount_type(settings) {
        MountType::Nfs => &["nfsmount"],
        MountType::Fuse if cfg!(any(windows, target_os = "macos")) => &["cmount", "mount"],
        MountType::Fuse => &["mount", "cmount", "mount2"],
    };
    wanted
        .iter()
        .find(|w| available.iter().any(|a| a == *w))
        .unwrap_or(&wanted[0])
        .to_string()
}

pub fn mount_params(drive: &Drive, fs: &str, mount_point: &str, settings: &Settings, kind: &str) -> Value {
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

pub const BAD_PASSWORD: &str = "The server didn't accept the login details (username, password or key).";

/// Rewrites rclone's raw errors into something a person can act on.
pub fn friendly_error(raw: &str) -> String {
    let l = raw.to_lowercase();
    let msg = if l.contains("401")
        || l.contains("unauthorized")
        || l.contains("authentication")
        || l.contains("unable to authenticate")
        || l.contains("incorrect password")
        || l.contains("login incorrect")
        || l.contains("530 ")
        || l.contains("signaturedoesnotmatch")
        || l.contains("invalidaccesskeyid")
        || l.contains("bad_auth_token")
        || l.contains("unauthorized_application_key")
        || l.contains("eaccess")
    {
        // compared as-is by the unlock flow, so no details appended
        return BAD_PASSWORD.to_string();
    } else if l.contains("invalid_grant") || l.contains("token expired") || l.contains("oauth2") {
        "Google sign-in has expired or was revoked. Edit the drive and sign in again."
    } else if l.contains("winfsp") || l.contains("cgofuse") || l.contains("fuse") && l.contains("not") {
        "The file-system driver isn't installed. Open Settings to install it."
    } else if l.contains("http response to https client") {
        "This port speaks http, not https. Edit the drive and set Protocol to http://."
    } else if l.contains("first record does not look like a tls handshake") || l.contains("tls: ") && !l.contains("x509") {
        "The secure (https) connection failed. If the server uses plain http on this port, set Protocol to http://."
    } else if l.contains("x509") || l.contains("certificate") {
        "The server's security certificate isn't trusted (common with a NAS). If this is your own server, edit the drive and turn on \"Allow self-signed certificate\"."
    } else if l.contains("no such host") {
        "The server name couldn't be found. Check the spelling of the address."
    } else if l.contains("connection refused") || l.contains("actively refused") {
        "The server refused the connection on this port. Check the port number, and that WebDAV is turned on in the server."
    } else if l.contains("timeout") || l.contains("timed out") || l.contains("took too long") || l.contains("failed to respond") {
        "The server didn't answer. The port may be blocked by a firewall, or the server may only be reachable from your office network or VPN."
    } else if l.contains("connection reset") || l.contains("forcibly closed") {
        "The server closed the connection. Check the Protocol (http/https) and port."
    } else if l.contains("dial tcp") || l.contains("network is unreachable") {
        "Can't reach the server. Check the address and your internet connection."
    } else if l.contains("404") || l.contains("not found") && l.contains("directory") {
        "That folder or WebDAV path doesn't exist on the server."
    } else if l.contains("405") || l.contains("method not allowed") {
        "The server answered, but not as WebDAV. Check the WebDAV path, and that WebDAV is enabled."
    } else if l.contains("already") && (l.contains("mount") || l.contains("in use") || l.contains("exists")) {
        "That drive letter or folder is already in use."
    } else {
        return raw.to_string();
    };
    // Keep rclone's own words too, so problems can be diagnosed.
    let detail: String = raw.trim().chars().take(240).collect();
    format!("{msg}\nDetails: {detail}")
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
    fn picks_registered_mount_type() {
        // force FUSE: on a Mac without FUSE installed "auto" means NFS
        let s = Settings { mac_mount_backend: "fuse".into(), ..Settings::default() };
        let avail = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let expected = if cfg!(any(windows, target_os = "macos")) { "cmount" } else { "mount" };
        assert_eq!(pick_mount_type(&s, &avail(&["cmount", "mount"])), expected);
        assert_eq!(pick_mount_type(&s, &avail(&["cmount"])), "cmount");
    }

    #[test]
    fn cloud_fs_strings() {
        use std::collections::BTreeMap;
        let mut d: Drive = serde_json::from_value(serde_json::json!({
            "name": "x", "provider": { "type": "cloud", "backend": "s3",
            "options": { "provider": "AWS", "access_key_id": "AK", "region": "" } }, "remotePath": "bucket/dir"
        })).unwrap();
        let fs = fs_string(&d, &Secret::default(), Some("SK")).unwrap();
        assert_eq!(fs, ":s3,access_key_id='AK',provider='AWS',secret_access_key='SK':bucket/dir");
        d.provider = Provider::Cloud { backend: "dropbox".into(), account: String::new(), options: BTreeMap::new() };
        assert!(fs_string(&d, &Secret::default(), None).is_err());
        let tok = Secret { token: Some("{}".into()), ..Default::default() };
        assert_eq!(fs_string(&d, &tok, None).unwrap(), ":dropbox,token='{}':bucket/dir");
        d.provider = Provider::Cloud { backend: "local".into(), account: String::new(), options: BTreeMap::new() };
        assert!(fs_string(&d, &tok, None).is_err());
    }

    #[test]
    fn obscure_is_stable() {
        assert_eq!(obscure("a", "pw"), obscure("a", "pw"));
        assert_ne!(obscure("a", "pw"), obscure("b", "pw"));
    }

    #[test]
    fn friendly_errors() {
        assert!(friendly_error("401 Unauthorized").contains("password"));
        assert_eq!(friendly_error("ssh: unable to authenticate, attempted methods"), BAD_PASSWORD);
        assert_eq!(friendly_error("api error SignatureDoesNotMatch: x"), BAD_PASSWORD);
        assert!(friendly_error("dial tcp: lookup x: no such host").contains("couldn't be found"));
        assert!(friendly_error("http: server gave HTTP response to HTTPS client").contains("http://"));
        assert_eq!(friendly_error("401 Unauthorized"), BAD_PASSWORD);
        assert_eq!(friendly_error("weird"), "weird");
    }
}
