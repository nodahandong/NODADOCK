//! Browser sign-in through `rclone authorize <backend>` (Google Drive,
//! OneDrive, Dropbox, Box): rclone runs a one-shot local web server, the
//! person signs in in their browser, and rclone prints the OAuth token, which
//! we keep in the keychain.
use crate::rclone;
use serde::Serialize;
use std::collections::BTreeMap;
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
    backend: &str,
    client_id: &str,
    client_secret: &str,
    session: Arc<AuthSession>,
    on_url: impl Fn(String) + Send + Sync + 'static,
) -> Result<String, String> {
    session.cancel();
    let mut cmd = tokio::process::Command::from(rclone::command(bin));
    cmd.args(["authorize", backend]);
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
        return "Sign-in was cancelled in the browser.".into();
    }
    let detail = out
        .lines()
        .rev()
        .find(|line| line.contains("ERROR") || line.contains("Failed") || line.contains("error"))
        .map(|line| line.trim_start_matches("LOG ").trim().to_string());
    match detail {
        Some(d) => format!("Sign-in didn't finish: {d}"),
        None => "Sign-in was cancelled or didn't finish.".into(),
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

async fn get_json(req: reqwest::RequestBuilder) -> Option<serde_json::Value> {
    req.timeout(Duration::from_secs(15)).send().await.ok()?.json().await.ok()
}

/// The account's e-mail (shown on the drive card) and any rclone settings the
/// service needs besides the token.
pub async fn account_info(backend: &str, token: &str) -> (Option<String>, BTreeMap<String, String>) {
    let mut options = BTreeMap::new();
    let Some(at) = access_token(token) else { return (None, options) };
    let http = reqwest::Client::new();
    let email = match backend {
        "drive" => account_email(token).await,
        "onedrive" => {
            if let Some(d) = get_json(http.get("https://graph.microsoft.com/v1.0/me/drive").bearer_auth(&at)).await {
                if let (Some(id), Some(kind)) = (d["id"].as_str(), d["driveType"].as_str()) {
                    options.insert("drive_id".into(), id.into());
                    options.insert("drive_type".into(), kind.into());
                }
            }
            get_json(http.get("https://graph.microsoft.com/v1.0/me").bearer_auth(&at))
                .await
                .and_then(|me| me["mail"].as_str().or(me["userPrincipalName"].as_str()).map(str::to_string))
        }
        "dropbox" => get_json(
            http.post("https://api.dropboxapi.com/2/users/get_current_account")
                .bearer_auth(&at)
                .header("Content-Type", "application/json")
                .body("null"),
        )
        .await
        .and_then(|v| v["email"].as_str().map(str::to_string)),
        "box" => get_json(http.get("https://api.box.com/2.0/users/me").bearer_auth(&at))
            .await
            .and_then(|v| v["login"].as_str().map(str::to_string)),
        _ => None,
    };
    (email, options)
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
