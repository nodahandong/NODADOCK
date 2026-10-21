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

/// SFTP, FTP and S3 drives built the way the app builds them, against
/// rclone's own test servers.
#[tokio::test]
async fn e2e_cloud_backends() {
    if std::env::var("NODADOCK_E2E").is_err() {
        return;
    }
    let tmp = std::env::temp_dir().join(format!("nodadock-e2e-cloud-{}", std::process::id()));
    let served = tmp.join("served");
    std::fs::create_dir_all(served.join("bucket1/Docs")).unwrap();
    std::fs::write(served.join("bucket1/Docs/hello.txt"), "hi").unwrap();
    let bin = crate::rclone::find_binary().expect("rclone");
    let root = served.to_str().unwrap();
    let mut servers = vec![
        Command::new(&bin).args(["serve", "sftp", root, "--addr", "127.0.0.1:18022", "--user", "bob", "--pass", "s3cret"]).spawn().unwrap(),
        Command::new(&bin).args(["serve", "ftp", root, "--addr", "127.0.0.1:18021", "--user", "bob", "--pass", "s3cret"]).spawn().unwrap(),
        Command::new(&bin).args(["serve", "s3", root, "--addr", "127.0.0.1:18333", "--auth-key", "AKID,SECRETKEY"]).spawn().unwrap(),
    ];
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let rc = Rclone::start(bin, &tmp.join("data"), &tmp.join("cache"), &tmp.join("log/rclone.log")).await.unwrap();

    let cases = [
        (json!({ "backend": "sftp", "options": { "host": "127.0.0.1", "port": "18022", "user": "bob" } }), "s3cret", "bucket1"),
        (json!({ "backend": "ftp", "options": { "host": "127.0.0.1", "port": "18021", "user": "bob" } }), "s3cret", "bucket1"),
        (json!({ "backend": "s3", "options": { "provider": "Other", "access_key_id": "AKID", "endpoint": "http://127.0.0.1:18333", "region": "us-east-1" } }), "SECRETKEY", "bucket1"),
    ];
    for (provider, pw, path) in cases {
        let mut p = provider.clone();
        p["type"] = json!("cloud");
        let drive: Drive = serde_json::from_value(json!({ "id": "c1", "name": "c", "provider": p, "remotePath": path })).unwrap();
        assert!(drive.uses_password());
        let fs = mount::fs_string(&drive, &Secret::default(), Some(pw)).unwrap();
        let v = rc.call("operations/list", json!({ "fs": fs, "remote": "Docs" })).await;
        let names: Vec<String> = v.as_ref().map(|v| v["list"].as_array().unwrap().iter().map(|e| e["Name"].as_str().unwrap().to_string()).collect()).unwrap_or_default();
        println!("{} -> {:?} {:?}", provider["backend"], names, v.as_ref().err());
        assert_eq!(names, vec!["hello.txt".to_string()]);
        let bad = mount::fs_string(&drive, &Secret::default(), Some("wrong")).unwrap();
        let err = rc.call_timeout("operations/list", json!({ "fs": bad, "remote": "" }), Duration::from_secs(20)).await.unwrap_err();
        println!("   wrong password -> {}", mount::friendly_error(&err).lines().next().unwrap());
    }
    rc.shutdown();
    for s in servers.iter_mut() {
        let _ = s.kill();
    }
}
