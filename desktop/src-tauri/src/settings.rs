use crate::openai::{normalize_key, normalize_noise};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub microphone_id: String,
    #[serde(default = "default_noise")]
    pub noise: String,
}

fn default_noise() -> String {
    "near_field".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            microphone_id: String::new(),
            noise: default_noise(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicSettings {
    pub has_key: bool,
    pub microphone_id: String,
    pub noise: String,
}

impl From<&Settings> for PublicSettings {
    fn from(settings: &Settings) -> Self {
        Self {
            has_key: !settings.api_key.trim().is_empty(),
            microphone_id: settings.microphone_id.clone(),
            noise: normalize_noise(&settings.noise).to_string(),
        }
    }
}

pub struct Store {
    path: PathBuf,
    inner: Mutex<Settings>,
}

impl Store {
    pub fn load(path: PathBuf) -> Self {
        let settings = read_settings(&path).unwrap_or_default();
        Self {
            path,
            inner: Mutex::new(settings),
        }
    }

    pub fn public(&self) -> PublicSettings {
        PublicSettings::from(&*self.lock())
    }

    pub fn key_and_noise(&self) -> Option<(String, String)> {
        let settings = self.lock();
        let key = settings.api_key.clone();
        if key.is_empty() {
            None
        } else {
            Some((key, settings.noise.clone()))
        }
    }

    pub fn save(
        &self,
        api_key: Option<String>,
        microphone_id: String,
        noise: String,
    ) -> Result<PublicSettings, String> {
        let mut settings = self.lock();
        if let Some(raw) = api_key {
            let key = normalize_key(&raw);
            if key.chars().count() > 400 {
                return Err("Ключ слишком длинный.".to_string());
            }
            if !key.is_empty() {
                settings.api_key = key;
            }
        }
        if settings.api_key.trim().is_empty() {
            return Err("Вставь ключ OpenAI.".to_string());
        }
        settings.microphone_id = microphone_id.trim().chars().take(256).collect();
        settings.noise = normalize_noise(&noise).to_string();
        write_settings(&self.path, &settings)?;
        Ok(PublicSettings::from(&*settings))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Settings> {
        self.inner.lock().unwrap_or_else(|poison| poison.into_inner())
    }
}

fn read_settings(path: &Path) -> Option<Settings> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_settings(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| "Не удалось сохранить настройки.".to_string())?;
    }
    let text = serde_json::to_string_pretty(settings)
        .map_err(|_| "Не удалось сохранить настройки.".to_string())?;
    fs::write(path, text).map_err(|_| "Не удалось сохранить настройки.".to_string())
}
