use crate::models::{Drive, Settings};
use serde::{de::DeserializeOwned, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Non-secret app data: the list of drives and the app settings, as JSON
/// files in the app's config folder.
pub struct Store {
    dir: PathBuf,
    drives: Mutex<Vec<Drive>>,
    settings: Mutex<Settings>,
}

impl Store {
    pub fn open(dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&dir);
        let drives = read_json(&dir.join("drives.json")).unwrap_or_default();
        let settings = read_json(&dir.join("settings.json")).unwrap_or_default();
        Store { dir, drives: Mutex::new(drives), settings: Mutex::new(settings) }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn drives(&self) -> Vec<Drive> {
        self.drives.lock().unwrap().clone()
    }

    pub fn drive(&self, id: &str) -> Option<Drive> {
        self.drives.lock().unwrap().iter().find(|d| d.id == id).cloned()
    }

    pub fn upsert_drive(&self, drive: Drive) -> Result<(), String> {
        let mut drives = self.drives.lock().unwrap();
        match drives.iter_mut().find(|d| d.id == drive.id) {
            Some(existing) => *existing = drive,
            None => drives.push(drive),
        }
        write_json(&self.dir.join("drives.json"), &*drives)
    }

    pub fn remove_drive(&self, id: &str) -> Result<(), String> {
        let mut drives = self.drives.lock().unwrap();
        drives.retain(|d| d.id != id);
        write_json(&self.dir.join("drives.json"), &*drives)
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    pub fn set_settings(&self, settings: Settings) -> Result<(), String> {
        let mut current = self.settings.lock().unwrap();
        *current = settings;
        write_json(&self.dir.join("settings.json"), &*current)
    }
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}
