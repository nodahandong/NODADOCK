//! Google sign-in through `rclone authorize drive`: rclone runs a one-shot
//! local web server, the person signs in in their browser, and rclone prints
//! the OAuth token, which we keep in the keychain.
use crate::rclone;
use serde::Serialize;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Default)]
pub struct AuthSession {
    child: Mutex<Option<tokio::process::Child>>,
}

impl AuthSession {
    pub fn cancel(&self) {
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            let _ = child.start_kill();
        }
    }
}

/// Runs the sign-in. `on_url` is called with the consent URL so the UI can
/// open it and show it as a fallback link.
pub async fn authorize(
    bin: &Path,
    client_id: &str,
    client_secret: &str,
    session: Arc<AuthSession>,
    on_url: impl Fn(String) + Send + Sync + 'static,
) -> Result<String, String> {
    session.cancel();
    let mut cmd = tokio::process::Command::from(rclone::command(bin));
    cmd.args(["authorize", "drive"]);
    if !client_id.is_empty() {
        cmd.args([client_id, client_secret]);
    }
    cmd.arg("--auth-no-open-browser")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    *session.child.lock().unwrap() = Some(child);

    let output = Arc::new(Mutex::new(String::new()));
    let on_url = Arc::new(on_url);
    let mut readers = Vec::new();
    for (i, pipe) in [Box::new(stdout) as Box<dyn tokio::io::AsyncRead + Unpin + Send>, Box::new(stderr)]
        .into_iter()
        .enumerate()
    {
        let output = output.clone();
        let on_url = on_url.clone();
        readers.push(tokio::spawn(async move {
            let mut lines = BufReader::new(pipe).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(start) = line.find("http://127.0.0.1:53682/auth") {
                    let url = line[start..].split_whitespace().next().unwrap_or("").to_string();
                    on_url(url);
                }
                let mut out = output.lock().unwrap();
                if i == 0 {
                    out.push_str(&line);
                } else {
                    // keep rclone's log lines too, so a failure can be explained
                    out.push_str("LOG ");
                    out.push_str(&line);
                }
                out.push('\n');
            }
        }));
    }

    let waited = tokio::time::timeout(Duration::from_secs(600), async {
        for r in readers {
            let _ = r.await;
        }
    })
    .await;
    let child = session.child.lock().unwrap().take();
    if let Some(mut child) = child {
        let _ = child.start_kill();
    }
    if waited.is_err() {
        return Err("Sign-in timed out. Please try again.".into());
    }

    let out = output.lock().unwrap().clone();
    parse_token(&out).ok_or_else(|| explain_failure(&out))
}

fn explain_failure(out: &str) -> String {
    let l = out.to_lowercase();
    if l.contains("address already in use") || l.contains("only one usage of each socket") || l.contains("bind") {
        return "Another sign-in window is still open. Close it (or restart NodaDock) and try again.".into();
    }
    if l.contains("access_denied") {
        return "Google sign-in was cancelled in the browser.".into();
    }
    let detail = out
        .lines()
        .rev()
        .find(|line| line.contains("ERROR") || line.contains("Failed") || line.contains("error"))
        .map(|line| line.trim_start_matches("LOG ").trim().to_string());
    match detail {
        Some(d) => format!("Google sign-in didn't finish: {d}"),
        None => "Google sign-in was cancelled or didn't finish.".into(),
    }
}

fn parse_token(out: &str) -> Option<String> {
    let out: String = out.lines().filter(|l| !l.starts_with("LOG ")).collect::<Vec<_>>().join("\n");
    let start = out.find("--->")? + 4;
    let end = out[start..].find("<---")? + start;
    let token = out[start..end].trim();
    serde_json::from_str::<serde_json::Value>(token).ok()?;
    Some(token.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedDrive {
    pub id: String,
    pub name: String,
}

fn access_token(token: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(token).ok()?;
    v["access_token"].as_str().map(str::to_string)
}

/// The signed-in Google account's email, shown on the drive card.
pub async fn account_email(token: &str) -> Option<String> {
    let at = access_token(token)?;
    let v: serde_json::Value = reqwest::Client::new()
        .get("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)")
        .bearer_auth(at)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    v["user"]["emailAddress"].as_str().map(str::to_string)
}

/// Shared drives the account can see, so the person can mount one of them
/// instead of "My Drive".
pub async fn shared_drives(token: &str) -> Result<Vec<SharedDrive>, String> {
    let at = access_token(token).ok_or("Invalid token")?;
    let v: serde_json::Value = reqwest::Client::new()
        .get("https://www.googleapis.com/drive/v3/drives?pageSize=100&fields=drives(id,name)")
        .bearer_auth(at)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(v["drives"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|d| SharedDrive {
                    id: d["id"].as_str().unwrap_or("").into(),
                    name: d["name"].as_str().unwrap_or("").into(),
                })
                .collect()
        })
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_token() {
        let out = "Paste the following into your remote machine --->\n{\"access_token\":\"a\",\"refresh_token\":\"r\"}\n<---End paste\n";
        assert_eq!(super::parse_token(out).unwrap(), "{\"access_token\":\"a\",\"refresh_token\":\"r\"}");
        assert!(super::parse_token("nothing").is_none());
    }
}
