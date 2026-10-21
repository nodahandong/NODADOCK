//! Runs a private `rclone rcd` daemon and talks to it over its HTTP
//! remote-control API on 127.0.0.1 with a random user and password.
use serde_json::{json, Value};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

#[cfg(windows)]
pub const EXE: &str = "rclone.exe";
#[cfg(not(windows))]
pub const EXE: &str = "rclone";

/// Looks for rclone next to our executable (where the installer puts the
/// bundled copy), then in the dev `binaries/` folder, then on PATH.
pub fn find_binary() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(EXE));
            // macOS app bundle: Contents/MacOS/rclone
            candidates.push(dir.join("../MacOS").join(EXE));
        }
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
    if let Ok(entries) = std::fs::read_dir(&dev) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with("rclone-") {
                candidates.push(e.path());
            }
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join(EXE));
        }
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/rclone"));
        candidates.push(PathBuf::from("/usr/local/bin/rclone"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

pub fn command(bin: &Path) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(bin);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

pub struct Rclone {
    pub bin: PathBuf,
    pub version: String,
    base: String,
    user: String,
    pass: String,
    http: reqwest::Client,
    child: Mutex<Option<Child>>,
}

impl Rclone {
    pub async fn start(bin: PathBuf, data_dir: &Path, cache_dir: &Path, log_file: &Path) -> Result<Self, String> {
        let port = TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .map_err(|e| e.to_string())?
            .port();
        let user = uuid::Uuid::new_v4().simple().to_string();
        let pass = uuid::Uuid::new_v4().simple().to_string();
        let _ = std::fs::create_dir_all(data_dir);
        let _ = std::fs::create_dir_all(cache_dir);
        if let Some(dir) = log_file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }

        let child = command(&bin)
            .arg("rcd")
            .arg(format!("--rc-addr=127.0.0.1:{port}"))
            .arg(format!("--config={}", data_dir.join("rclone.conf").display()))
            .arg(format!("--cache-dir={}", cache_dir.display()))
            .arg(format!("--log-file={}", log_file.display()))
            .arg("--log-level=INFO")
            // credentials via env so they don't show up in process listings
            .env("RCLONE_RC_USER", &user)
            .env("RCLONE_RC_PASS", &pass)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Couldn't start rclone ({}): {e}", bin.display()))?;

        let mut rc = Rclone {
            bin,
            version: String::new(),
            base: format!("http://127.0.0.1:{port}"),
            user,
            pass,
            http: reqwest::Client::builder().no_proxy().build().map_err(|e| e.to_string())?,
            child: Mutex::new(Some(child)),
        };

        let mut last_err = String::new();
        for _ in 0..50 {
            match rc.call_timeout("core/version", json!({}), Duration::from_secs(2)).await {
                Ok(v) => {
                    rc.version = v["version"].as_str().unwrap_or("").to_string();
                    return Ok(rc);
                }
                Err(e) => last_err = e,
            }
            if let Some(child) = rc.child.lock().unwrap().as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    return Err(format!("rclone exited during startup ({status}). See the log file for details."));
                }
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        rc.shutdown();
        Err(format!("rclone didn't respond: {last_err}"))
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.call_timeout(method, params, Duration::from_secs(120)).await
    }

    pub async fn call_timeout(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let resp = self
            .http
            .post(format!("{}/{}", self.base, method))
            .basic_auth(&self.user, Some(&self.pass))
            .timeout(timeout)
            .json(&params)
            .send()
            .await
            .map_err(|e| if e.is_timeout() { "The server took too long to answer.".to_string() } else { e.to_string() })?;
        let ok = resp.status().is_success();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        if ok {
            Ok(body)
        } else {
            Err(body["error"].as_str().unwrap_or("rclone request failed").to_string())
        }
    }

    pub fn shutdown(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for Rclone {
    fn drop(&mut self) {
        self.shutdown();
    }
}
