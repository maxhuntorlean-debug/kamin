mod openai;
mod settings;

use openai::open_client_secret;
use settings::{PublicSettings, Store};
use serde::Serialize;
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::Manager;

struct Http(reqwest::Client);

pub fn run() {
    tauri::Builder::default()
        .on_permission_request(|_webview, kind| match kind {
            PermissionKind::Microphone => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let data_dir = app.path().app_data_dir().unwrap_or_else(|_| {
                std::env::var_os("APPDATA")
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(|| std::path::PathBuf::from("."))
                    .join("app.kamin.desktop")
            });
            let _ = std::fs::create_dir_all(&data_dir);
            app.manage(Store::load(data_dir.join("settings.json")));
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .expect("http client");
            app.manage(Http(client));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            check_key,
            open_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kamin");
}

#[tauri::command]
fn get_settings(store: tauri::State<'_, Store>) -> PublicSettings {
    store.public()
}

#[tauri::command]
fn save_settings(
    store: tauri::State<'_, Store>,
    api_key: Option<String>,
    microphone_id: String,
    noise: String,
) -> Result<PublicSettings, String> {
    store.save(api_key, microphone_id, noise)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyCheck {
    ok: bool,
    message: String,
}

#[tauri::command]
async fn check_key(
    http: tauri::State<'_, Http>,
    store: tauri::State<'_, Store>,
    api_key: Option<String>,
) -> Result<KeyCheck, String> {
    let Some((key, noise)) = key_to_test(&store, api_key) else {
        return Ok(KeyCheck {
            ok: false,
            message: "Вставь ключ или сохрани его.".to_string(),
        });
    };
    match open_client_secret(&http.0, &key, &noise).await {
        Ok(_) => Ok(KeyCheck {
            ok: true,
            message: "Ключ подходит, сессия открывается.".to_string(),
        }),
        Err(message) => Ok(KeyCheck { ok: false, message }),
    }
}

#[tauri::command]
async fn open_session(
    http: tauri::State<'_, Http>,
    store: tauri::State<'_, Store>,
) -> Result<String, String> {
    let Some((key, noise)) = store.key_and_noise() else {
        return Err("Сначала сохрани ключ OpenAI в настройках.".to_string());
    };
    open_client_secret(&http.0, &key, &noise).await
}

fn key_to_test(store: &Store, api_key: Option<String>) -> Option<(String, String)> {
    let stored = store.key_and_noise();
    let noise = stored
        .as_ref()
        .map(|(_, noise)| noise.clone())
        .unwrap_or_else(|| "near_field".to_string());
    if let Some(raw) = api_key {
        let key = openai::normalize_key(&raw);
        if !key.is_empty() {
            return Some((key, noise));
        }
    }
    stored
}
