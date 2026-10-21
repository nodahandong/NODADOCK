mod google;
mod models;
mod mount;
mod platform;
mod rclone;
mod secrets;
mod store;
#[cfg(test)]
mod e2e_tests;

use models::{Drive, Provider, Secret, Settings};
use rclone::Rclone;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use store::Store;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

type Res<T> = Result<T, String>;

struct Mounted {
    mount_point: String,
    fs_name: String,
}

pub struct AppState {
    store: Store,
    rc: tokio::sync::RwLock<Option<Arc<Rclone>>>,
    engine_error: Mutex<Option<String>>,
    mounts: Mutex<HashMap<String, Mounted>>,
    busy: Mutex<HashMap<String, &'static str>>,
    errors: Mutex<HashMap<String, String>>,
    /// Passwords typed in "ask every time" mode; kept in memory only.
    session_passwords: Mutex<HashMap<String, String>>,
    auth: Arc<google::AuthSession>,
    unlock_prompt_pending: AtomicBool,
    data_dir: PathBuf,
    cache_dir: PathBuf,
    log_file: PathBuf,
}

impl AppState {
    async fn rc(&self) -> Res<Arc<Rclone>> {
        if let Some(rc) = self.rc.read().await.as_ref() {
            return Ok(rc.clone());
        }
        Err(self
            .engine_error
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "The drive engine is still starting. Try again in a moment.".into()))
    }

    fn password_for(&self, drive: &Drive, secret: &Secret) -> Option<String> {
        if drive.remember_password {
            if let Some(p) = &secret.password {
                return Some(p.clone());
            }
        }
        self.session_passwords.lock().unwrap().get(&drive.id).cloned()
    }

    fn needs_password(&self, drive: &Drive) -> bool {
        drive.is_webdav()
            && !drive.remember_password
            && !self.session_passwords.lock().unwrap().contains_key(&drive.id)
    }
}

// ---------- status ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DriveView {
    #[serde(flatten)]
    drive: Drive,
    /// mounted | mounting | unmounting | unmounted | error | locked
    status: String,
    error: Option<String>,
    active_mount_point: Option<String>,
    uploads: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Transfer {
    name: String,
    size: u64,
    bytes: u64,
    percentage: u64,
    speed: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusView {
    engine_ready: bool,
    engine_version: String,
    engine_error: Option<String>,
    drives: Vec<DriveView>,
    speed: f64,
    bytes: u64,
    transfers: Vec<Transfer>,
}

#[tauri::command]
async fn get_status(state: State<'_, AppState>) -> Res<StatusView> {
    let rc = state.rc.read().await.clone();
    let mut speed = 0.0;
    let mut bytes = 0;
    let mut transfers = Vec::new();
    let mut uploads: HashMap<String, u64> = HashMap::new();

    if let Some(rc) = &rc {
        let short = Duration::from_secs(3);
        if let Ok(v) = rc.call_timeout("mount/listmounts", json!({}), short).await {
            let live: Vec<(String, String)> = v["mountPoints"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|m| (m["MountPoint"].as_str().unwrap_or("").to_string(), m["Fs"].as_str().unwrap_or("").to_string()))
                .collect();
            let busy = state.busy.lock().unwrap().clone();
            let mut mounts = state.mounts.lock().unwrap();
            mounts.retain(|id, m| {
                if busy.contains_key(id.as_str()) {
                    return true;
                }
                match live.iter().find(|(mp, _)| mp == &m.mount_point) {
                    Some((_, fs)) => {
                        m.fs_name = fs.clone();
                        true
                    }
                    None => false,
                }
            });
        }
        if let Ok(v) = rc.call_timeout("core/stats", json!({}), short).await {
            speed = v["speed"].as_f64().unwrap_or(0.0);
            bytes = v["bytes"].as_u64().unwrap_or(0);
            for t in v["transferring"].as_array().into_iter().flatten() {
                transfers.push(Transfer {
                    name: t["name"].as_str().unwrap_or("").into(),
                    size: t["size"].as_u64().unwrap_or(0),
                    bytes: t["bytes"].as_u64().unwrap_or(0),
                    percentage: t["percentage"].as_u64().unwrap_or(0),
                    speed: t["speedAvg"].as_f64().or(t["speed"].as_f64()).unwrap_or(0.0),
                });
            }
        }
        let fs_names: Vec<(String, String)> =
            state.mounts.lock().unwrap().iter().map(|(id, m)| (id.clone(), m.fs_name.clone())).collect();
        for (id, fs) in fs_names {
            if fs.is_empty() {
                continue;
            }
            if let Ok(v) = rc.call_timeout("vfs/stats", json!({ "fs": fs }), short).await {
                let c = &v["diskCache"];
                let n = c["uploadsInProgress"].as_u64().unwrap_or(0) + c["uploadsQueued"].as_u64().unwrap_or(0);
                uploads.insert(id, n);
            }
        }
    }

    let mounts = state.mounts.lock().unwrap();
    let busy = state.busy.lock().unwrap();
    let errors = state.errors.lock().unwrap();
    let drives = state
        .store
        .drives()
        .into_iter()
        .map(|d| {
            let mounted = mounts.get(&d.id);
            let status = if let Some(b) = busy.get(&d.id) {
                b.to_string()
            } else if mounted.is_some() {
                "mounted".into()
            } else if errors.contains_key(&d.id) {
                "error".into()
            } else if state.needs_password(&d) {
                "locked".into()
            } else {
                "unmounted".into()
            };
            DriveView {
                status,
                error: errors.get(&d.id).cloned(),
                active_mount_point: mounted.map(|m| m.mount_point.clone()),
                uploads: uploads.get(&d.id).copied().unwrap_or(0),
                drive: d,
            }
        })
        .collect();

    Ok(StatusView {
        engine_ready: rc.is_some(),
        engine_version: rc.as_ref().map(|r| r.version.clone()).unwrap_or_default(),
        engine_error: state.engine_error.lock().unwrap().clone(),
        drives,
        speed,
        bytes,
        transfers,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemInfo {
    os: &'static str,
    driver: platform::DriverStatus,
    free_letters: Vec<String>,
    mount_root: String,
    log_file: String,
    cache_dir: String,
    app_version: String,
}

#[tauri::command]
fn system_info(app: AppHandle, state: State<'_, AppState>) -> SystemInfo {
    SystemInfo {
        os: platform::os_name(),
        driver: platform::driver_status(),
        free_letters: platform::free_drive_letters(),
        mount_root: platform::mount_root().to_string_lossy().into_owned(),
        log_file: state.log_file.to_string_lossy().into_owned(),
        cache_dir: state.cache_dir.to_string_lossy().into_owned(),
        app_version: app.package_info().version.to_string(),
    }
}

// ---------- settings ----------

#[tauri::command]
fn get_settings(app: AppHandle, state: State<'_, AppState>) -> Settings {
    let mut s = state.store.settings();
    if let Ok(enabled) = app.autolaunch().is_enabled() {
        s.launch_at_login = enabled;
    }
    s
}

#[tauri::command]
fn save_settings(app: AppHandle, state: State<'_, AppState>, settings: Settings) -> Res<()> {
    apply_autostart(&app, settings.launch_at_login);
    state.store.set_settings(settings)
}

fn apply_autostart(app: &AppHandle, on: bool) {
    let al = app.autolaunch();
    let _ = if on { al.enable() } else { al.disable() };
}

// ---------- drives ----------

#[tauri::command]
async fn save_drive(
    state: State<'_, AppState>,
    mut drive: Drive,
    password: Option<String>,
    token: Option<String>,
    client_secret: Option<String>,
) -> Res<Drive> {
    drive.name = drive.name.trim().to_string();
    if drive.name.is_empty() {
        return Err("Give the drive a name.".into());
    }
    if let Provider::WebDav { url, .. } = &mut drive.provider {
        *url = url.trim().to_string();
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err("The server address must start with https:// or http://".into());
        }
    }
    let is_new = drive.id.is_empty();
    if is_new {
        drive.id = uuid::Uuid::new_v4().simple().to_string();
    }
    let mut secret = if is_new { Secret::default() } else { secrets::load(&drive.id)? };
    if let Some(pw) = password {
        state.session_passwords.lock().unwrap().insert(drive.id.clone(), pw.clone());
        secret.password = Some(pw);
    }
    if !drive.remember_password {
        // "Ask every time": never keep the password on disk or in the keychain.
        secret.password = None;
    }
    if let Some(t) = token {
        secret.token = Some(t);
    }
    if let Some(cs) = client_secret {
        secret.client_secret = if cs.is_empty() { None } else { Some(cs) };
    }
    if matches!(drive.provider, Provider::GoogleDrive { .. }) && secret.token.is_none() {
        return Err("Sign in with Google first.".into());
    }
    secrets::save(&drive.id, &secret)?;
    state.store.upsert_drive(drive.clone())?;
    state.errors.lock().unwrap().remove(&drive.id);
    Ok(drive)
}

#[tauri::command]
async fn delete_drive(app: AppHandle, state: State<'_, AppState>, id: String) -> Res<()> {
    if state.mounts.lock().unwrap().contains_key(&id) {
        do_unmount(&app, &state, &id, true).await?;
    }
    secrets::delete(&id)?;
    state.session_passwords.lock().unwrap().remove(&id);
    state.errors.lock().unwrap().remove(&id);
    state.store.remove_drive(&id)?;
    let _ = app.emit("status-changed", ());
    Ok(())
}

#[tauri::command]
async fn mount_drive(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
    remember: Option<bool>,
) -> Res<()> {
    do_mount(&app, &state, &id, password, remember.unwrap_or(false)).await
}

async fn do_mount(app: &AppHandle, state: &AppState, id: &str, password: Option<String>, remember: bool) -> Res<()> {
    let mut drive = state.store.drive(id).ok_or("Drive not found")?;
    if state.mounts.lock().unwrap().contains_key(id) {
        return Ok(());
    }
    {
        let mut busy = state.busy.lock().unwrap();
        if busy.contains_key(id) {
            return Err("This drive is busy. Please wait.".into());
        }
        busy.insert(id.to_string(), "mounting");
    }
    state.errors.lock().unwrap().remove(id);
    let _ = app.emit("status-changed", ());

    let typed = password.is_some();
    let result = mount_inner(state, &mut drive, password, remember).await;
    state.busy.lock().unwrap().remove(id);
    match &result {
        Ok(mp) => {
            state.mounts.lock().unwrap().insert(id.to_string(), Mounted { mount_point: mp.clone(), fs_name: String::new() });
        }
        Err(e) if e == "PASSWORD_REQUIRED" => {}
        // A mistyped password is shown in the unlock dialog; the drive stays locked.
        Err(e) if typed && e == mount::BAD_PASSWORD && !drive.remember_password => {}
        Err(e) => {
            state.errors.lock().unwrap().insert(id.to_string(), e.clone());
        }
    }
    let _ = app.emit("status-changed", ());
    result.map(|_| ())
}

async fn mount_inner(state: &AppState, drive: &mut Drive, password: Option<String>, remember: bool) -> Res<String> {
    let rc = state.rc().await?;
    let mut secret = secrets::load(&drive.id)?;
    let typed = password.is_some();
    let password = match password {
        Some(p) => Some(p),
        None => state.password_for(drive, &secret),
    };
    if drive.is_webdav() && password.is_none() && !drive.remember_password {
        return Err("PASSWORD_REQUIRED".into());
    }

    let fs = mount::fs_string(drive, &secret, password.as_deref())?;

    if drive.is_webdav() {
        // Check credentials first so a wrong password fails fast and clearly.
        rc.call_timeout(
            "operations/list",
            json!({ "fs": fs, "remote": "", "opt": { "dirsOnly": true } }),
            Duration::from_secs(30),
        )
        .await
        .map_err(|e| mount::friendly_error(&e))?;
    }

    if typed {
        let pw = password.clone().unwrap();
        state.session_passwords.lock().unwrap().insert(drive.id.clone(), pw.clone());
        if remember {
            drive.remember_password = true;
            state.store.upsert_drive(drive.clone())?;
        }
        if drive.remember_password {
            secret.password = Some(pw);
            secrets::save(&drive.id, &secret)?;
        }
    }

    let taken: Vec<String> = state.mounts.lock().unwrap().values().map(|m| m.mount_point.clone()).collect();
    let mount_point = mount::resolve_mount_point(drive, &taken)?;
    if !platform::is_drive_letter(&mount_point) {
        std::fs::create_dir_all(&mount_point).map_err(|e| format!("Couldn't create {mount_point}: {e}"))?;
    }
    let settings = state.store.settings();
    rc.call("mount/mount", mount::mount_params(drive, &fs, &mount_point, &settings))
        .await
        .map_err(|e| mount::friendly_error(&e))?;
    Ok(mount_point)
}

#[tauri::command]
async fn unmount_drive(app: AppHandle, state: State<'_, AppState>, id: String, force: Option<bool>) -> Res<()> {
    do_unmount(&app, &state, &id, force.unwrap_or(false)).await
}

async fn pending_uploads(state: &AppState, rc: &Rclone, id: Option<&str>) -> u64 {
    let fs_names: Vec<String> = state
        .mounts
        .lock()
        .unwrap()
        .iter()
        .filter(|(k, _)| id.map_or(true, |id| k.as_str() == id))
        .map(|(_, m)| m.fs_name.clone())
        .collect();
    let mut n = 0;
    for fs in fs_names.into_iter().filter(|f| !f.is_empty()) {
        if let Ok(v) = rc.call_timeout("vfs/stats", json!({ "fs": fs }), Duration::from_secs(3)).await {
            let c = &v["diskCache"];
            n += c["uploadsInProgress"].as_u64().unwrap_or(0) + c["uploadsQueued"].as_u64().unwrap_or(0);
        }
    }
    n
}

async fn do_unmount(app: &AppHandle, state: &AppState, id: &str, force: bool) -> Res<()> {
    let rc = state.rc().await?;
    let mp = match state.mounts.lock().unwrap().get(id) {
        Some(m) => m.mount_point.clone(),
        None => return Ok(()),
    };
    if !force {
        let n = pending_uploads(state, &rc, Some(id)).await;
        if n > 0 {
            return Err(format!("PENDING_UPLOADS:{n}"));
        }
    }
    state.busy.lock().unwrap().insert(id.to_string(), "unmounting");
    let _ = app.emit("status-changed", ());
    let res = rc.call("mount/unmount", json!({ "mountPoint": mp })).await;
    state.busy.lock().unwrap().remove(id);
    if res.is_ok() || res.as_ref().is_err_and(|e| e.contains("not found")) {
        state.mounts.lock().unwrap().remove(id);
    }
    let _ = app.emit("status-changed", ());
    res.map(|_| ()).map_err(|e| mount::friendly_error(&e))
}

#[tauri::command]
async fn mount_all(app: AppHandle, state: State<'_, AppState>) -> Res<()> {
    mount_all_inner(&app, &state, false).await;
    Ok(())
}

async fn mount_all_inner(app: &AppHandle, state: &AppState, only_auto: bool) {
    for d in state.store.drives() {
        if only_auto && !d.auto_mount {
            continue;
        }
        if state.needs_password(&d) {
            continue;
        }
        let _ = do_mount(app, state, &d.id, None, false).await;
    }
}

#[tauri::command]
async fn unmount_all(app: AppHandle, state: State<'_, AppState>, force: Option<bool>) -> Res<()> {
    let ids: Vec<String> = state.mounts.lock().unwrap().keys().cloned().collect();
    let mut errs = Vec::new();
    for id in ids {
        if let Err(e) = do_unmount(&app, &state, &id, force.unwrap_or(false)).await {
            errs.push(e);
        }
    }
    errs.into_iter().next().map_or(Ok(()), Err)
}

/// Drives that should mount at startup but need their password typed in.
/// Returned once per app launch so the UI can show the unlock dialog.
#[tauri::command]
fn take_unlock_prompt(state: State<'_, AppState>) -> Vec<String> {
    if !state.unlock_prompt_pending.swap(false, Ordering::SeqCst) {
        return Vec::new();
    }
    locked_auto_drives(&state)
}

fn locked_auto_drives(state: &AppState) -> Vec<String> {
    let mounts = state.mounts.lock().unwrap();
    state
        .store
        .drives()
        .into_iter()
        .filter(|d| d.auto_mount && !mounts.contains_key(&d.id) && state.needs_password(d))
        .map(|d| d.id)
        .collect()
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct Usage {
    total: Option<u64>,
    used: Option<u64>,
    free: Option<u64>,
}

fn usage_from(v: &Value) -> Usage {
    Usage { total: v["total"].as_u64(), used: v["used"].as_u64(), free: v["free"].as_u64() }
}

/// Checks that a drive's settings work before saving: lists the root folder
/// and reads the storage quota if the server reports one.
#[tauri::command]
async fn test_connection(
    state: State<'_, AppState>,
    drive: Drive,
    password: Option<String>,
    token: Option<String>,
    client_secret: Option<String>,
) -> Res<Usage> {
    let rc = state.rc().await?;
    let mut secret = if drive.id.is_empty() { Secret::default() } else { secrets::load(&drive.id).unwrap_or_default() };
    if token.is_some() {
        secret.token = token;
    }
    if client_secret.is_some() {
        secret.client_secret = client_secret;
    }
    let password = password.or_else(|| state.password_for(&drive, &secret));
    let fs = mount::fs_string(&drive, &secret, password.as_deref())?;
    rc.call_timeout(
        "operations/list",
        json!({ "fs": fs, "remote": "", "opt": { "dirsOnly": true } }),
        Duration::from_secs(30),
    )
    .await
    .map_err(|e| mount::friendly_error(&e))?;
    let about = rc.call_timeout("operations/about", json!({ "fs": fs }), Duration::from_secs(15)).await;
    Ok(about.map(|v| usage_from(&v)).unwrap_or_default())
}

#[tauri::command]
async fn drive_usage(state: State<'_, AppState>, id: String) -> Res<Usage> {
    let rc = state.rc().await?;
    let fs = state.mounts.lock().unwrap().get(&id).map(|m| m.fs_name.clone()).unwrap_or_default();
    if fs.is_empty() {
        return Ok(Usage::default());
    }
    let v = rc.call_timeout("operations/about", json!({ "fs": fs }), Duration::from_secs(15)).await?;
    Ok(usage_from(&v))
}

#[tauri::command]
async fn open_drive(app: AppHandle, state: State<'_, AppState>, id: String) -> Res<()> {
    use tauri_plugin_opener::OpenerExt;
    let mp = state.mounts.lock().unwrap().get(&id).map(|m| m.mount_point.clone()).ok_or("The drive isn't connected.")?;
    let path = if platform::is_drive_letter(&mp) { format!("{mp}\\") } else { mp };
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_logs(app: AppHandle, state: State<'_, AppState>) -> Res<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().reveal_item_in_dir(&state.log_file).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Res<()> {
    use tauri_plugin_opener::OpenerExt;
    if !url.starts_with("https://") && !url.starts_with("http://127.0.0.1") {
        return Err("Unsupported link".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

// ---------- Google ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GoogleAuth {
    token: String,
    email: Option<String>,
}

#[tauri::command]
async fn google_sign_in(app: AppHandle, state: State<'_, AppState>, client_id: String, client_secret: String) -> Res<GoogleAuth> {
    let rc = state.rc().await?;
    let opener_app = app.clone();
    let token = google::authorize(&rc.bin, client_id.trim(), client_secret.trim(), state.auth.clone(), move |url| {
        use tauri_plugin_opener::OpenerExt;
        let _ = opener_app.opener().open_url(&url, None::<&str>);
        let _ = opener_app.emit("google-auth-url", url);
    })
    .await?;
    let email = google::account_email(&token).await;
    Ok(GoogleAuth { token, email })
}

#[tauri::command]
fn google_cancel(state: State<'_, AppState>) {
    state.auth.cancel();
}

#[tauri::command]
async fn google_shared_drives(token: String) -> Res<Vec<google::SharedDrive>> {
    google::shared_drives(&token).await
}

// ---------- app lifecycle ----------

#[tauri::command]
async fn quit_app(app: AppHandle, state: State<'_, AppState>, force: bool) -> Res<()> {
    if !force {
        if let Ok(rc) = state.rc().await {
            let n = pending_uploads(&state, &rc, None).await;
            if n > 0 {
                return Err(format!("PENDING_UPLOADS:{n}"));
            }
        }
    }
    app.exit(0);
    Ok(())
}

#[tauri::command]
async fn restart_engine(app: AppHandle) -> Res<()> {
    let state = app.state::<AppState>();
    if let Some(rc) = state.rc.write().await.take() {
        let _ = rc.call_timeout("mount/unmountall", json!({}), Duration::from_secs(20)).await;
        rc.shutdown();
    }
    state.mounts.lock().unwrap().clear();
    start_engine(&app).await;
    mount_all_inner(&app, &state, true).await;
    Ok(())
}

async fn start_engine(app: &AppHandle) {
    let state = app.state::<AppState>();
    *state.engine_error.lock().unwrap() = None;
    let result = match rclone::find_binary() {
        None => Err("The rclone engine wasn't found. Please reinstall NodaDock.".to_string()),
        Some(bin) => Rclone::start(bin, &state.data_dir, &state.cache_dir, &state.log_file).await,
    };
    match result {
        Ok(rc) => *state.rc.write().await = Some(Arc::new(rc)),
        Err(e) => *state.engine_error.lock().unwrap() = Some(e),
    }
    let _ = app.emit("status-changed", ());
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn request_quit(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let pending = match state.rc().await {
            Ok(rc) => pending_uploads(&state, &rc, None).await,
            Err(_) => 0,
        };
        if pending == 0 {
            app.exit(0);
        } else {
            show_window(&app);
            let _ = app.emit("quit-blocked", pending);
        }
    });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open NodaDock", true, None::<&str>)?;
    let mount = MenuItem::with_id(app, "mount_all", "Connect all drives", true, None::<&str>)?;
    let unmount = MenuItem::with_id(app, "unmount_all", "Disconnect all drives", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit NodaDock", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &sep, &mount, &unmount, &sep2, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("NodaDock")
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_window(app),
            "mount_all" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    mount_all_inner(&app, &state, false).await;
                });
            }
            "unmount_all" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    let ids: Vec<String> = state.mounts.lock().unwrap().keys().cloned().collect();
                    for id in ids {
                        if let Err(e) = do_unmount(&app, &state, &id, false).await {
                            if e.starts_with("PENDING_UPLOADS") {
                                show_window(&app);
                                let _ = app.emit("unmount-blocked", id);
                            }
                        }
                    }
                });
            }
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let paths = app.path();
            let config_dir = paths.app_config_dir()?;
            let data_dir = paths.app_data_dir()?;
            let cache_dir = paths.app_cache_dir()?;
            let log_file = paths.app_log_dir()?.join("rclone.log");
            let store = Store::open(config_dir);
            let first_run = !store.dir().join("settings.json").exists();
            let settings = store.settings();
            if first_run {
                let _ = store.set_settings(settings.clone());
                apply_autostart(&handle, settings.launch_at_login);
            }

            app.manage(AppState {
                store,
                rc: tokio::sync::RwLock::new(None),
                engine_error: Mutex::new(None),
                mounts: Mutex::new(HashMap::new()),
                busy: Mutex::new(HashMap::new()),
                errors: Mutex::new(HashMap::new()),
                session_passwords: Mutex::new(HashMap::new()),
                auth: Arc::new(google::AuthSession::default()),
                unlock_prompt_pending: AtomicBool::new(true),
                data_dir,
                cache_dir,
                log_file,
            });

            build_tray(&handle)?;

            let autostarted = std::env::args().any(|a| a == "--autostart");
            if !(autostarted && settings.start_minimized) {
                show_window(&handle);
            }

            tauri::async_runtime::spawn(async move {
                start_engine(&handle).await;
                let state = handle.state::<AppState>();
                mount_all_inner(&handle, &state, true).await;
                // Drives set to "ask for password" need the window, even when
                // we started quietly in the tray after a reboot.
                if !locked_auto_drives(&state).is_empty() {
                    show_window(&handle);
                    let _ = handle.emit("unlock-needed", ());
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if state.store.settings().close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    api.prevent_close();
                    request_quit(window.app_handle());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            system_info,
            get_settings,
            save_settings,
            save_drive,
            delete_drive,
            mount_drive,
            unmount_drive,
            mount_all,
            unmount_all,
            take_unlock_prompt,
            test_connection,
            drive_usage,
            open_drive,
            open_logs,
            open_url,
            google_sign_in,
            google_cancel,
            google_shared_drives,
            quit_app,
            restart_engine,
        ])
        .build(tauri::generate_context!())
        .expect("error while building NodaDock");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            let state = app.state::<AppState>();
            state.auth.cancel();
            let rc = tauri::async_runtime::block_on(async { state.rc.write().await.take() });
            if let Some(rc) = rc {
                let _ = tauri::async_runtime::block_on(rc.call_timeout(
                    "mount/unmountall",
                    json!({}),
                    Duration::from_secs(20),
                ));
                rc.shutdown();
            }
        }
    });
}
