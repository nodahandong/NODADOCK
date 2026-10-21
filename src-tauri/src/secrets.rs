//! Passwords and OAuth tokens live in Windows Credential Manager / macOS
//! Keychain, never in our config files.
use crate::models::Secret;
use keyring::{Entry, Error};

const SERVICE: &str = "NodaDock";

fn entry(id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &format!("drive:{id}")).map_err(|e| e.to_string())
}

pub fn load(id: &str) -> Result<Secret, String> {
    match entry(id)?.get_password() {
        Ok(json) => serde_json::from_str(&json).map_err(|e| e.to_string()),
        Err(Error::NoEntry) => Ok(Secret::default()),
        Err(e) => Err(format!("Couldn't read from the system keychain: {e}")),
    }
}

pub fn save(id: &str, secret: &Secret) -> Result<(), String> {
    if secret.is_empty() {
        return delete(id);
    }
    let json = serde_json::to_string(secret).map_err(|e| e.to_string())?;
    entry(id)?
        .set_password(&json)
        .map_err(|e| format!("Couldn't save to the system keychain: {e}"))
}

pub fn delete(id: &str) -> Result<(), String> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
