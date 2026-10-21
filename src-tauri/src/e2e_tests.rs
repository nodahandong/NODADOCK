//! End-to-end check of the mount path against a real rclone and a local
//! WebDAV server. Run with: NODADOCK_E2E=1 cargo test e2e -- --nocapture
use crate::models::{Drive, Provider, Secret, Settings};
use crate::{mount, rclone::Rclone, secrets};
use serde_json::json;
use std::process::Command;
use std::time::Duration;

#[tokio::test]
async fn e2e_webdav_mount_cycle() {
    if std::env::var("NODADOCK_E2E").is_err() {
        return;
    }
    let tmp = std::env::temp_dir().join(format!("nodadock-e2e-{}", std::process::id()));
    let served = tmp.join("served");
    std::fs::create_dir_all(served.join("Docs")).unwrap();
    std::fs::write(served.join("Docs/hello.txt"), "hi").unwrap();
    let bin = crate::rclone::find_binary().expect("rclone");
    let password = "p@ss, w'ord:1";
    let mut server = Command::new(&bin)
        .args(["serve", "webdav", served.to_str().unwrap(), "--addr", "127.0.0.1:18099", "--user", "bob", "--pass", password])
        .spawn()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;

    let rc = Rclone::start(bin, &tmp.join("data"), &tmp.join("cache"), &tmp.join("log/rclone.log")).await.unwrap();
    println!("engine {}", rc.version);

    let drive = Drive {
        id: "e2etest".into(),
        name: "E2E Drive".into(),
        provider: Provider::WebDav { url: "http://127.0.0.1:18099".into(), vendor: "other".into(), username: "bob".into() },
        remote_path: "/Docs".into(),
        mount_point: tmp.join("mnt").to_string_lossy().into(),
        auto_mount: true,
        remember_password: true,
        read_only: false,
        cache_mode: "full".into(),
        network_mode: false,
        allow_self_signed: false,
        color: String::new(),
    };

    // keychain round trip (kernel keyring on Linux)
    let secret = Secret { password: Some(password.into()), ..Default::default() };
    if secrets::save(&drive.id, &secret).is_ok() {
        assert_eq!(secrets::load(&drive.id).unwrap().password.as_deref(), Some(password));
        secrets::delete(&drive.id).unwrap();
        assert!(secrets::load(&drive.id).unwrap().password.is_none());
        println!("keychain ok");
    }

    // wrong password is rejected with a friendly message
    let bad = mount::fs_string(&drive, &Secret::default(), Some("nope")).unwrap();
    let err = rc
        .call("operations/list", json!({ "fs": bad, "remote": "", "opt": { "dirsOnly": true } }))
        .await
        .unwrap_err();
    println!("wrong password -> {}", mount::friendly_error(&err));
    assert!(mount::friendly_error(&err).contains("password"));

    let fs = mount::fs_string(&drive, &Secret::default(), Some(password)).unwrap();
    assert_eq!(fs, mount::fs_string(&drive, &Secret::default(), Some(password)).unwrap(), "fs string must be stable");
    let mp = mount::resolve_mount_point(&drive, &[]).unwrap();
    std::fs::create_dir_all(&mp).unwrap();
    rc.call("mount/mount", mount::mount_params(&drive, &fs, &mp, &Settings::default(), "mount")).await.unwrap();
    assert_eq!(std::fs::read_to_string(format!("{mp}/hello.txt")).unwrap(), "hi");

    std::fs::write(format!("{mp}/new.txt"), "written through the mount").unwrap();
    let mounts = rc.call("mount/listmounts", json!({})).await.unwrap();
    let fs_name = mounts["mountPoints"][0]["Fs"].as_str().unwrap().to_string();
    assert!(!fs_name.contains(password) && !fs_name.contains("bob"), "secrets must not leak into fs name: {fs_name}");
    let stats = rc.call("vfs/stats", json!({ "fs": fs_name })).await.unwrap();
    println!("pending uploads right after write: {}", stats["diskCache"]["uploadsQueued"]);

    for _ in 0..40 {
        if served.join("Docs/new.txt").exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(std::fs::read_to_string(served.join("Docs/new.txt")).unwrap(), "written through the mount");
    println!("upload reached server");

    rc.call("mount/unmount", json!({ "mountPoint": mp })).await.unwrap();
    assert!(rc.call("mount/listmounts", json!({})).await.unwrap()["mountPoints"].as_array().unwrap().is_empty());
    let log = std::fs::read_to_string(tmp.join("log/rclone.log")).unwrap_or_default();
    assert!(!log.contains(password), "password leaked into log");
    println!("log clean ({} bytes)", log.len());

    rc.shutdown();
    let _ = server.kill();
}
