use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use minecraft_rust_core::auth::azauth::{AzAuthClient, AzAuthLoginResult};
use minecraft_rust_core::auth::microsoft::MicrosoftClient;
use minecraft_rust_core::auth::{
    AuthAccount, MinecraftProfile, RoleInfo, SkinInfo, SkinVariant, UserInfo,
};
use minecraft_rust_core::config::LaunchOptions;
use minecraft_rust_core::events::LaunchEvent;
use minecraft_rust_core::launch::Launcher;
use minecraft_rust_core::status::{ServerStatusClient, ServerStatusResponse};
use serde::Serialize;
use serde_json::Value;
use tauri::window::{ProgressBarState, ProgressBarStatus};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;

use crate::meta::{
    evaluate_github_release, normalize_remote_config, parse_github_owner_repo, read_launcher_meta,
    resolve_remote_config_url, round_bytes_to_half_gb, AppUpdateInfo, LauncherMeta,
    SystemMemoryInfo,
};
use crate::mods::{
    resolve_optional_mods_state, sync_optional_mods_on_disk, toggle_optional_mod_on_disk,
    OptionalModState,
};
use crate::news::{merge_and_sort_news, normalize_panel_news, parse_azuriom_rss, NewsItem};
use crate::state::{LauncherState, RpcConfig};

// ---------------------------------------------------------------------------
// 1. Metadata, System Memory & Remote Configuration
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_launcher_meta() -> Result<LauncherMeta, String> {
    read_launcher_meta()
}

#[tauri::command]
pub fn get_system_memory() -> Result<SystemMemoryInfo, String> {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();

    let total_bytes = sys.total_memory();
    let avail = sys.available_memory();
    let free_bytes = if avail > 0 { avail } else { sys.free_memory() };

    let total_gb = round_bytes_to_half_gb(total_bytes).max(1.0);
    let free_gb = round_bytes_to_half_gb(free_bytes).min(total_gb);

    Ok(SystemMemoryInfo { total_gb, free_gb })
}

#[tauri::command]
pub async fn fetch_remote_config(state: State<'_, LauncherState>) -> Result<Value, String> {
    let meta = read_launcher_meta()?;
    let config_url = resolve_remote_config_url(&meta)?;

    let resp = state
        .http()
        .get(&config_url)
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend configuration '{config_url}': {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!(
            "Backend configuration endpoint '{config_url}' returned HTTP {status}"
        ));
    }

    let raw_json: Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid JSON from '{config_url}': {e}"))?;

    normalize_remote_config(raw_json, &meta)
}

// ---------------------------------------------------------------------------
// 2. News Feed (Panel JSON + Azuriom RSS 2.0 XML + Merged Mode)
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "snake_case")]
pub async fn fetch_news(
    state: State<'_, LauncherState>,
    news_source: Option<String>,
    news_url: Option<String>,
    azauth_url: Option<String>,
) -> Result<Vec<NewsItem>, String> {
    let meta = read_launcher_meta()?;
    let mode = news_source
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| {
            if meta.env == "azuriom" {
                "azuriom".to_string()
            } else {
                "panel".to_string()
            }
        });

    let resolved_panel_news_url = news_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            if meta.env != "azuriom" && !meta.settings_url.trim().is_empty() {
                Some(format!(
                    "{}/utils/news",
                    meta.settings_url.trim().trim_end_matches('/')
                ))
            } else {
                None
            }
        });

    let resolved_rss_url = azauth_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|u| format!("{}/api/rss", u.trim_end_matches('/')))
        .or_else(|| {
            if meta.env == "azuriom" && !meta.settings_url.trim().is_empty() {
                Some(format!(
                    "{}/api/rss",
                    meta.settings_url.trim().trim_end_matches('/')
                ))
            } else {
                None
            }
        });

    let http = state.http();

    match mode.as_str() {
        "panel" => {
            let Some(url) = resolved_panel_news_url else {
                return Ok(Vec::new());
            };
            fetch_panel_news_from_url(http, &url).await
        }
        "azuriom" | "rss" => {
            let Some(url) = resolved_rss_url else {
                return Ok(Vec::new());
            };
            fetch_rss_news_from_url(http, &url).await
        }
        "both" => {
            let panel_fut = async {
                match resolved_panel_news_url {
                    Some(ref url) => fetch_panel_news_from_url(http, url).await.unwrap_or_default(),
                    None => Vec::new(),
                }
            };
            let rss_fut = async {
                match resolved_rss_url {
                    Some(ref url) => fetch_rss_news_from_url(http, url).await.unwrap_or_default(),
                    None => Vec::new(),
                }
            };
            let (panel_items, rss_items) = tokio::join!(panel_fut, rss_fut);
            Ok(merge_and_sort_news(panel_items, rss_items))
        }
        _ => Ok(Vec::new()),
    }
}

async fn fetch_panel_news_from_url(
    http: &reqwest::Client,
    url: &str,
) -> Result<Vec<NewsItem>, String> {
    let resp = http
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Panel news '{url}': {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Panel news endpoint '{url}' returned HTTP {}",
            resp.status()
        ));
    }

    let raw: Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid Panel news JSON from '{url}': {e}"))?;

    Ok(normalize_panel_news(raw))
}

async fn fetch_rss_news_from_url(
    http: &reqwest::Client,
    url: &str,
) -> Result<Vec<NewsItem>, String> {
    let resp = http
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Azuriom RSS feed '{url}': {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Azuriom RSS endpoint '{url}' returned HTTP {}",
            resp.status()
        ));
    }

    let xml_body = resp
        .text()
        .await
        .map_err(|e| format!("Failed reading RSS body from '{url}': {e}"))?;

    parse_azuriom_rss(&xml_body)
}

// ---------------------------------------------------------------------------
// 3. Minecraft Server Status Ping (+ mcsrvstat.us HTTP Fallback)
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "snake_case")]
pub async fn ping_minecraft_server(
    state: State<'_, LauncherState>,
    host: String,
    port: u16,
) -> Result<ServerStatusResponse, String> {
    let trimmed_host = host.trim();
    if trimmed_host.is_empty() {
        return Ok(offline_server_status());
    }
    let resolved_port = if port == 0 { 25565 } else { port };

    if let Ok(direct) = ServerStatusClient::new(trimmed_host, resolved_port)
        .with_timeout(3_000)
        .ping()
        .await
    {
        if direct.online {
            return Ok(direct);
        }
    }

    // Fallback to HTTP status API when outbound TCP 25565 is filtered by firewall
    if let Some(fallback) =
        ping_via_mcsrvstat_fallback(state.http(), trimmed_host, resolved_port).await
    {
        return Ok(fallback);
    }

    Ok(offline_server_status())
}

fn offline_server_status() -> ServerStatusResponse {
    ServerStatusResponse {
        online: false,
        latency_ms: 0,
        version: String::new(),
        players_online: 0,
        players_max: 0,
        motd: String::new(),
        favicon: None,
    }
}

async fn ping_via_mcsrvstat_fallback(
    http: &reqwest::Client,
    host: &str,
    port: u16,
) -> Option<ServerStatusResponse> {
    let target = if port == 25565 {
        host.to_string()
    } else {
        format!("{host}:{port}")
    };
    let api_url = format!("https://api.mcsrvstat.us/3/{target}");

    let resp = http
        .get(&api_url)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }

    let body: Value = resp.json().await.ok()?;
    let online = body.get("online").and_then(|v| v.as_bool()).unwrap_or(false);
    if !online {
        return Some(offline_server_status());
    }

    let players_online = body
        .get("players")
        .and_then(|p| p.get("online"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let players_max = body
        .get("players")
        .and_then(|p| p.get("max"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let version = body
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let motd = body
        .get("motd")
        .and_then(|m| m.get("clean"))
        .and_then(|c| c.as_array())
        .map(|lines| {
            lines
                .iter()
                .filter_map(|l| l.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let favicon = body
        .get("icon")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    Some(ServerStatusResponse {
        online: true,
        latency_ms: 0,
        version,
        players_online,
        players_max,
        motd,
        favicon,
    })
}

// ---------------------------------------------------------------------------
// 4. Azuriom Authentication (`AzAuthClient`)
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "snake_case")]
pub async fn auth_azuriom_login(
    base_url: String,
    username: String,
    password: String,
    two_factor_code: Option<String>,
) -> Result<AzAuthLoginResult, String> {
    let resolved_base = resolve_azauth_base(&base_url)?;
    let client = AzAuthClient::new(&resolved_base).map_err(|e| e.to_string())?;
    client
        .login(&username, &password, two_factor_code.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn auth_azuriom_verify(
    base_url: String,
    access_token: String,
) -> Result<AuthAccount, String> {
    let resolved_base = resolve_azauth_base(&base_url)?;
    let client = AzAuthClient::new(&resolved_base).map_err(|e| e.to_string())?;
    client
        .verify(&access_token)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn auth_azuriom_logout(
    base_url: String,
    access_token: String,
) -> Result<bool, String> {
    let resolved_base = resolve_azauth_base(&base_url)?;
    let client = AzAuthClient::new(&resolved_base).map_err(|e| e.to_string())?;
    client
        .logout(&access_token)
        .await
        .map_err(|e| e.to_string())
}

fn resolve_azauth_base(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim();
    if !trimmed.is_empty() {
        return Ok(trimmed.to_string());
    }
    let meta = read_launcher_meta()?;
    if !meta.settings_url.trim().is_empty() {
        Ok(meta.settings_url)
    } else {
        Err("Azuriom base URL is not configured".to_string())
    }
}

// ---------------------------------------------------------------------------
// 5. Microsoft OAuth2 WebviewWindow Login, Refresh & Panel Sync
// ---------------------------------------------------------------------------

const MS_POPUP_WINDOW_LABEL: &str = "ms-oauth-login";

#[tauri::command(rename_all = "snake_case")]
pub async fn auth_microsoft_login(
    app: AppHandle,
    state: State<'_, LauncherState>,
    client_id: Option<String>,
    panel_base_url: Option<String>,
) -> Result<Option<AuthAccount>, String> {
    let ms_client = MicrosoftClient::new(client_id.as_deref());
    let auth_url_str = ms_client.authorization_url();
    let auth_url: tauri::Url = auth_url_str
        .parse()
        .map_err(|e| format!("Invalid Microsoft authorization URL: {e}"))?;

    // Close any stale OAuth2 popup before opening a fresh login flow
    if let Some(existing) = app.get_webview_window(MS_POPUP_WINDOW_LABEL) {
        let _ = existing.close();
    }

    let (tx, rx) = tokio::sync::oneshot::channel::<Option<Result<String, String>>>();
    let tx_holder = Arc::new(Mutex::new(Some(tx)));

    let nav_tx = Arc::clone(&tx_holder);
    let nav_app = app.clone();

    let mut builder =
        WebviewWindowBuilder::new(&app, MS_POPUP_WINDOW_LABEL, WebviewUrl::External(auth_url))
            .title("Connexion Microsoft")
            .inner_size(480.0, 640.0)
            .min_inner_size(380.0, 500.0)
            .resizable(true)
            .center()
            .focused(true)
            .on_navigation(move |navigated_url| {
                if let Some(outcome) =
                    MicrosoftClient::extract_code_from_redirect_url(navigated_url.as_str())
                {
                    if let Ok(mut guard) = nav_tx.lock() {
                        if let Some(sender) = guard.take() {
                            let _ = sender.send(Some(outcome));
                        }
                    }
                    // Close asynchronously outside WebKitGTK navigation callback to avoid deadlock
                    let close_handle = nav_app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(win) = close_handle.get_webview_window(MS_POPUP_WINDOW_LABEL) {
                            let _ = win.close();
                        }
                    });
                    return false;
                }
                true
            });

    if let Some(main_win) = app.get_webview_window("main") {
        if let Ok(b) = builder.parent(&main_win) {
            builder = b;
        } else {
            // Re-initialize if `.parent()` failed on a platform without native parent support
            let fallback_url: tauri::Url = auth_url_str.parse().unwrap();
            let nav_tx2 = Arc::clone(&tx_holder);
            let nav_app2 = app.clone();
            builder = WebviewWindowBuilder::new(
                &app,
                MS_POPUP_WINDOW_LABEL,
                WebviewUrl::External(fallback_url),
            )
            .title("Connexion Microsoft")
            .inner_size(480.0, 640.0)
            .min_inner_size(380.0, 500.0)
            .resizable(true)
            .center()
            .focused(true)
            .on_navigation(move |navigated_url| {
                if let Some(outcome) =
                    MicrosoftClient::extract_code_from_redirect_url(navigated_url.as_str())
                {
                    if let Ok(mut guard) = nav_tx2.lock() {
                        if let Some(sender) = guard.take() {
                            let _ = sender.send(Some(outcome));
                        }
                    }
                    let close_handle = nav_app2.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(win) = close_handle.get_webview_window(MS_POPUP_WINDOW_LABEL) {
                            let _ = win.close();
                        }
                    });
                    return false;
                }
                true
            });
        }
    }

    let popup = builder
        .build()
        .map_err(|e| format!("Failed to open Microsoft login window: {e}"))?;

    let destroy_tx = Arc::clone(&tx_holder);
    popup.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            if let Ok(mut guard) = destroy_tx.lock() {
                if let Some(sender) = guard.take() {
                    let _ = sender.send(None);
                }
            }
        }
    });

    let auth_code = match rx.await {
        Ok(None) | Err(_) => return Ok(None),
        Ok(Some(Err(err_desc))) => {
            let lower = err_desc.to_ascii_lowercase();
            if lower.contains("access_denied") || lower.contains("user_cancel") || lower.contains("cancel") {
                return Ok(None);
            }
            return Err(format!("Microsoft OAuth2 error: {err_desc}"));
        }
        Ok(Some(Ok(code))) => code,
    };

    let mut account = ms_client
        .authenticate_with_code(&auth_code)
        .await
        .map_err(|e| e.to_string())?;

    sync_microsoft_account_if_panel(state.http(), panel_base_url.as_deref(), &mut account).await?;

    Ok(Some(account))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn auth_microsoft_refresh(
    state: State<'_, LauncherState>,
    account: AuthAccount,
    client_id: Option<String>,
    panel_base_url: Option<String>,
) -> Result<AuthAccount, String> {
    let ms_client = MicrosoftClient::new(client_id.as_deref());
    let mut refreshed = ms_client
        .refresh(&account)
        .await
        .map_err(|e| e.to_string())?;

    sync_microsoft_account_if_panel(state.http(), panel_base_url.as_deref(), &mut refreshed)
        .await?;

    Ok(refreshed)
}

/// Synchronizes a Microsoft-authenticated player with CentralPanel `POST {base}/utils/auth/microsoft/sync`
/// when running in Panel mode (`env != "azuriom"`), populating `account.user_info` (`role`, `money`,
/// `banned`, `verified`, `maintenance_bypass`) and rejecting banned accounts.
async fn sync_microsoft_account_if_panel(
    http: &reqwest::Client,
    panel_base_url: Option<&str>,
    account: &mut AuthAccount,
) -> Result<(), String> {
    let meta = read_launcher_meta()?;
    if meta.env == "azuriom" && panel_base_url.map(str::trim).filter(|s| !s.is_empty()).is_none() {
        if account.user_info.is_none() {
            account.user_info = Some(default_microsoft_user_info(&account.uuid));
        }
        return Ok(());
    }

    let resolved_panel = panel_base_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| meta.settings_url.trim())
        .trim_end_matches('/');

    if resolved_panel.is_empty() {
        if account.user_info.is_none() {
            account.user_info = Some(default_microsoft_user_info(&account.uuid));
        }
        return Ok(());
    }

    let sync_url = format!("{resolved_panel}/utils/auth/microsoft/sync");
    let xuid = account.xbox.as_ref().map(|x| x.xuid.as_str());
    let skin_url = account.profile.as_ref().and_then(|p| {
        p.skins
            .iter()
            .find(|s| s.state.as_deref() == Some("ACTIVE"))
            .or_else(|| p.skins.first())
            .map(|s| s.url.as_str())
    });
    let cape_url = account.profile.as_ref().and_then(|p| {
        p.capes
            .iter()
            .find(|c| c.state.as_deref() == Some("ACTIVE"))
            .map(|c| c.url.as_str())
    });

    #[derive(Serialize)]
    struct MsSyncPayload<'a> {
        access_token: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        xuid: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        skin_url: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cape_url: Option<&'a str>,
    }

    let resp = match http
        .post(&sync_url)
        .json(&MsSyncPayload {
            access_token: &account.access_token,
            xuid,
            skin_url,
            cape_url,
        })
        .send()
        .await
    {
        Ok(r) => r,
        Err(err) => {
            tracing::warn!("Panel Microsoft sync unreachable ({sync_url}): {err}");
            if account.user_info.is_none() {
                account.user_info = Some(default_microsoft_user_info(&account.uuid));
            }
            return Ok(());
        }
    };

    let status = resp.status();
    if status.as_u16() == 404 {
        // Legacy CentralPanel v1 without Microsoft sync endpoint: preserve default unbanned profile
        if account.user_info.is_none() {
            account.user_info = Some(default_microsoft_user_info(&account.uuid));
        }
        return Ok(());
    }

    let body: Value = resp.json().await.unwrap_or(Value::Null);

    let is_banned = body
        .get("banned")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        || body.get("reason").and_then(|v| v.as_str()) == Some("user_banned")
        || status.as_u16() == 403;

    if is_banned {
        let ban_msg = body
            .get("ban_reason")
            .or_else(|| body.get("message"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("This account is banned from the server.");
        return Err(format!("Authentication error (user_banned): {ban_msg}"));
    }

    if !status.is_success() {
        let err_msg = body
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Panel Microsoft synchronization failed");
        return Err(format!("Panel sync error (HTTP {status}): {err_msg}"));
    }

    let money = body
        .get("money")
        .or_else(|| body.get("monnaie"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let verified = body
        .get("verified")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let maintenance_bypass = body
        .get("maintenance_bypass")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let ban_reason = body
        .get("ban_reason")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    let role: Option<RoleInfo> = match body.get("role") {
        Some(Value::String(name)) if !name.trim().is_empty() => Some(RoleInfo {
            id: None,
            name: name.clone(),
            color: None,
            background: None,
        }),
        Some(v @ Value::Object(_)) => serde_json::from_value(v.clone()).ok(),
        _ => None,
    };

    account.user_info = Some(UserInfo {
        id: Some(account.uuid.clone()),
        banned: false,
        money,
        role,
        verified,
        maintenance_bypass,
        ban_reason,
    });

    Ok(())
}

fn default_microsoft_user_info(uuid: &str) -> UserInfo {
    UserInfo {
        id: Some(uuid.to_string()),
        banned: false,
        money: 0.0,
        role: None,
        verified: true,
        maintenance_bypass: false,
        ban_reason: None,
    }
}

// ---------------------------------------------------------------------------
// 6. Player Skin Upload & Official Microsoft Capes
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "snake_case")]
pub async fn upload_player_skin(
    mut account: AuthAccount,
    base_url: Option<String>,
    png_base64: String,
    slim: bool,
) -> Result<AuthAccount, String> {
    let png_bytes = decode_png_base64(&png_base64)?;

    if account
        .meta
        .account_type
        .eq_ignore_ascii_case("microsoft")
    {
        let variant = if slim {
            SkinVariant::Slim
        } else {
            SkinVariant::Classic
        };
        let updated_profile = MicrosoftClient::new(None)
            .upload_skin(&account.access_token, &png_bytes, variant)
            .await
            .map_err(|e| e.to_string())?;
        account.profile = Some(updated_profile);
        return Ok(account);
    }

    // Azuriom `skin-api` upload
    let az_base = resolve_azauth_base(base_url.as_deref().unwrap_or_default())?;
    let az_client = AzAuthClient::new(&az_base).map_err(|e| e.to_string())?;
    az_client
        .upload_skin(&account.access_token, &png_bytes)
        .await
        .map_err(|e| e.to_string())?;

    // Refresh Azuriom session to obtain fresh skin URL/base64, or update in-place on fallback
    if let Ok(verified) = az_client.verify(&account.access_token).await {
        return Ok(verified);
    }

    let data_uri = format!("data:image/png;base64,{}", BASE64_STANDARD.encode(&png_bytes));
    let skin_id = account
        .user_info
        .as_ref()
        .and_then(|u| u.id.as_deref())
        .unwrap_or(&account.uuid);
    let skin_url = format!("{}/{}", az_client.skin_base_url(), skin_id);

    let profile = account.profile.get_or_insert_with(|| MinecraftProfile {
        id: account.uuid.clone(),
        name: account.name.clone(),
        skins: Vec::new(),
        capes: Vec::new(),
    });
    profile.skins = vec![SkinInfo {
        id: None,
        state: Some("ACTIVE".to_string()),
        url: skin_url,
        texture_key: None,
        variant: Some(if slim {
            SkinVariant::Slim
        } else {
            SkinVariant::Classic
        }),
        alias: None,
        base64: Some(data_uri),
    }];

    Ok(account)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn set_microsoft_cape(
    access_token: String,
    cape_id: Option<String>,
) -> Result<MinecraftProfile, String> {
    MicrosoftClient::new(None)
        .set_active_cape(&access_token, cape_id.as_deref())
        .await
        .map_err(|e| e.to_string())
}

fn decode_png_base64(input: &str) -> Result<Vec<u8>, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Skin PNG base64 string cannot be empty".to_string());
    }
    let payload = match trimmed.split_once(";base64,") {
        Some((_, b64)) => b64.trim(),
        None => trimmed.trim_start_matches("data:image/png,"),
    };
    BASE64_STANDARD
        .decode(payload)
        .map_err(|e| format!("Invalid base64 PNG data: {e}"))
}

// ---------------------------------------------------------------------------
// 7. Instance-Scoped Optional Mods (`list`, `toggle`, `sync`)
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "snake_case")]
pub async fn list_optional_mods(
    state: State<'_, LauncherState>,
    data_directory: String,
    instance_slug: String,
    mods_url: String,
) -> Result<Vec<OptionalModState>, String> {
    let trimmed_url = mods_url.trim();
    if trimmed_url.is_empty() {
        return Ok(Vec::new());
    }

    let resp = state
        .http()
        .get(trimmed_url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch optional mods manifest '{trimmed_url}': {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Optional mods endpoint '{trimmed_url}' returned HTTP {}",
            resp.status()
        ));
    }

    let manifest: Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid optional mods JSON from '{trimmed_url}': {e}"))?;

    let root = PathBuf::from(data_directory.trim());
    resolve_optional_mods_state(&root, &instance_slug, &manifest)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn toggle_optional_mod(
    data_directory: String,
    instance_slug: String,
    mod_file: String,
    enabled: bool,
) -> Result<OptionalModState, String> {
    let root = PathBuf::from(data_directory.trim());
    toggle_optional_mod_on_disk(&root, &instance_slug, &mod_file, enabled)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn sync_optional_mods(
    data_directory: String,
    instance_slug: String,
) -> Result<(), String> {
    let root = PathBuf::from(data_directory.trim());
    sync_optional_mods_on_disk(&root, &instance_slug)
}

// ---------------------------------------------------------------------------
// 8. Game Launch Orchestration & Event Streaming (`launch-event`)
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "snake_case")]
pub async fn launch_instance(
    app: AppHandle,
    state: State<'_, LauncherState>,
    mut options: LaunchOptions,
    close_behavior: String,
) -> Result<u32, String> {
    // Always protect `<instance_dir>/launcher_config` from bundle cleaner deletion
    if !options
        .ignored
        .iter()
        .any(|entry| entry.trim().eq_ignore_ascii_case("launcher_config"))
    {
        options.ignored.push("launcher_config".to_string());
    }

    state.set_close_behavior(&close_behavior);

    let tracked_pid_slot = Arc::new(Mutex::new(0_u32));
    let cb_pid_slot = Arc::clone(&tracked_pid_slot);
    let cb_state = state.inner().clone();
    let cb_app = app.clone();

    let callback: Arc<dyn Fn(LaunchEvent) + Send + Sync + 'static> = Arc::new(move |event| {
        #[cfg(debug_assertions)]
        match &event {
            LaunchEvent::Data { line, .. } => write_debug_trace(&format!("[GameLog] {line}")),
            LaunchEvent::Error { message, .. } => write_debug_trace(&format!("[LaunchError] {message}")),
            LaunchEvent::Close { exit_code, .. } => write_debug_trace(&format!("[GameClose] exit code: {exit_code:?}")),
            LaunchEvent::Patch { line, .. } => write_debug_trace(&format!("[LoaderPatch] {line}")),
            LaunchEvent::Extract { message, .. } => write_debug_trace(&format!("[Extract] {message}")),
            _ => {}
        }

        update_taskbar_progress_from_event(&cb_app, &event);

        if matches!(event, LaunchEvent::Close { .. }) {
            if let Ok(guard) = cb_pid_slot.lock() {
                if *guard != 0 {
                    cb_state.remove_child_pid(*guard);
                }
            }
        }

        let _ = cb_app.emit("launch-event", &event);
    });

    let launcher = Launcher::new(options);
    let pid = match launcher.launch(callback).await {
        Ok(pid) => pid,
        Err(err) => {
            clear_taskbar_progress(&app);
            return Err(err.to_string());
        }
    };

    if let Ok(mut guard) = tracked_pid_slot.lock() {
        *guard = pid;
    }
    state.register_child_pid(pid);

    Ok(pid)
}

fn update_taskbar_progress_from_event(app: &AppHandle, event: &LaunchEvent) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };

    match event {
        LaunchEvent::Check { current, total, .. } if *total > 0 => {
            let pct = ((*current as u64).saturating_mul(100) / (*total as u64)).min(100);
            let _ = win.set_progress_bar(ProgressBarState {
                status: Some(ProgressBarStatus::Normal),
                progress: Some(pct),
            });
        }
        LaunchEvent::Progress {
            downloaded, total, ..
        } if *total > 0 => {
            let pct = (downloaded.saturating_mul(100) / *total).min(100);
            let _ = win.set_progress_bar(ProgressBarState {
                status: Some(ProgressBarStatus::Normal),
                progress: Some(pct),
            });
        }
        LaunchEvent::Data { .. } | LaunchEvent::Close { .. } | LaunchEvent::Error { .. } => {
            let _ = win.set_progress_bar(ProgressBarState {
                status: Some(ProgressBarStatus::None),
                progress: None,
            });
        }
        _ => {}
    }
}

fn clear_taskbar_progress(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_progress_bar(ProgressBarState {
            status: Some(ProgressBarStatus::None),
            progress: None,
        });
    }
}

// ---------------------------------------------------------------------------
// 9. Discord Rich Presence, External URLs, Window Routing & App Updates
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "snake_case")]
pub async fn set_discord_rpc(
    state: State<'_, LauncherState>,
    config: RpcConfig,
) -> Result<(), String> {
    let state_clone = state.inner().clone();
    tokio::task::spawn_blocking(move || state_clone.update_discord_rpc_blocking(config))
        .await
        .map_err(|e| format!("Discord RPC task panicked: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();
    let parsed =
        url::Url::parse(trimmed).map_err(|e| format!("Rejected malformed URL '{trimmed}': {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(format!(
            "Blocked non-HTTP(S) URL scheme '{}'",
            parsed.scheme()
        ));
    }

    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| format!("Failed to open external URL: {e}"))
}

#[tauri::command]
pub fn open_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.show();
        let _ = main_win.unminimize();
        let _ = main_win.set_focus();
        #[cfg(debug_assertions)]
        {
            main_win.open_devtools();
        }
    } else {
        return Err("Main launcher window is not registered".to_string());
    }

    if let Some(splash_win) = app.get_webview_window("splash") {
        let _ = splash_win.close();
    }

    Ok(())
}

pub fn write_debug_trace(line: &str) {
    #[cfg(debug_assertions)]
    {
        use std::io::Write;
        let ts = chrono::Local::now().format("%H:%M:%S%.3f");
        let formatted = format!("[{ts}] {line}\n");
        eprint!("{formatted}");
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                if let Ok(mut f) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(dir.join("debug.log"))
                {
                    let _ = f.write_all(formatted.as_bytes());
                }
            }
        }
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = line;
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn frontend_debug_log(level: String, source: String, message: String) {
    write_debug_trace(&format!("[UI:{source}][{level}] {message}"));
}

#[tauri::command]
pub fn toggle_devtools(window: tauri::WebviewWindow) {
    #[cfg(debug_assertions)]
    {
        if window.is_devtools_open() {
            window.close_devtools();
        } else {
            window.open_devtools();
        }
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = window;
    }
}

#[tauri::command]
pub async fn check_app_update(state: State<'_, LauncherState>) -> Result<AppUpdateInfo, String> {
    let meta = read_launcher_meta()?;
    let Some(ref repo_url) = meta.repository else {
        return Ok(AppUpdateInfo {
            update_available: false,
            version: None,
            download_url: None,
        });
    };

    let Some((owner, repo)) = parse_github_owner_repo(repo_url) else {
        return Ok(AppUpdateInfo {
            update_available: false,
            version: None,
            download_url: None,
        });
    };

    let api_url = format!("https://api.github.com/repos/{owner}/{repo}/releases/latest");
    let resp = match state
        .http()
        .get(&api_url)
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(6))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => {
            return Ok(AppUpdateInfo {
                update_available: false,
                version: None,
                download_url: None,
            })
        }
    };

    if !resp.status().is_success() {
        return Ok(AppUpdateInfo {
            update_available: false,
            version: None,
            download_url: None,
        });
    }

    let release_json: Value = match resp.json().await {
        Ok(j) => j,
        Err(_) => {
            return Ok(AppUpdateInfo {
                update_available: false,
                version: None,
                download_url: None,
            })
        }
    };

    Ok(evaluate_github_release(
        &release_json,
        &meta.version,
        &meta.platform,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use minecraft_rust_core::auth::{AccountMeta, XboxInfo};
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn test_decode_png_base64_raw_and_data_uri() {
        let raw = BASE64_STANDARD.encode([137_u8, 80, 78, 71]);
        assert_eq!(decode_png_base64(&raw).unwrap(), vec![137, 80, 78, 71]);

        let uri = format!("data:image/png;base64,{raw}");
        assert_eq!(decode_png_base64(&uri).unwrap(), vec![137, 80, 78, 71]);
    }

    #[test]
    fn test_frontend_launch_options_json_deserializes_cleanly() {
        let payload = json!({
            "url": "https://panel.example.com/utils/instances/survival/files",
            "authenticator": {
                "access_token": "mc-jwt-token",
                "client_token": "069a79f444e94726a5befca90e38aaf5",
                "refresh_token": "ms-refresh",
                "expires_at": 1999999999,
                "uuid": "069a79f444e94726a5befca90e38aaf5",
                "name": "Notch",
                "user_properties": "{}",
                "meta": {
                    "online": true,
                    "type": "Microsoft",
                    "offline": false
                },
                "user_info": {
                    "id": "069a79f444e94726a5befca90e38aaf5",
                    "role": {
                        "id": 1,
                        "name": "Admin",
                        "color": "#00bd7a",
                        "background": "https://panel.example.com/storage/bg.png"
                    },
                    "money": 250,
                    "verified": true,
                    "banned": false,
                    "maintenance_bypass": true
                },
                "xbox": {
                    "xuid": "25354123456789"
                }
            },
            "timeout_ms": 15000,
            "path": "/home/player/.conflictura",
            "version": "1.20.1",
            "instance": "survival",
            "detached": true,
            "intel_enabled_mac": false,
            "concurrent_downloads": 30,
            "bypass_offline": false,
            "loader": {
                "type": "forge",
                "build": "1.20.1-47.3.0",
                "enable": true
            },
            "mcp": null,
            "verify": true,
            "ignored": ["options.txt", "shaderpacks", "launcher_config"],
            "jvm_args": ["-XX:+UseG1GC"],
            "game_args": [],
            "auto_connect": {
                "host": "play.example.com",
                "port": 25565
            },
            "java": {
                "path": null,
                "version": null,
                "type": "jre"
            },
            "screen": {
                "width": null,
                "height": null,
                "fullscreen": false
            },
            "memory": {
                "min": "2048M",
                "max": "4096M"
            }
        });

        let opts: LaunchOptions =
            serde_json::from_value(payload).expect("Frontend LaunchOptions JSON must deserialize");
        assert_eq!(opts.instance_slug().as_deref(), Some("survival"));
        assert_eq!(opts.authenticator.name, "Notch");
        assert_eq!(
            opts.auto_connect.as_ref().map(|s| s.host.as_str()),
            Some("play.example.com")
        );
        assert_eq!(opts.memory.min, "2048M");
        assert_eq!(opts.memory.max, "4096M");
    }

    #[tokio::test]
    async fn test_panel_microsoft_sync_populates_role_and_rejects_ban() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            // 1st request: 200 OK with role + money
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = [0_u8; 4096];
                let _ = socket.read(&mut buf).await;
                let body = r##"{"status":"success","money":420,"banned":false,"verified":true,"maintenance_bypass":true,"role":{"id":2,"name":"Fondateur","color":"#ff5555","background":"https://example.com/bg.png"}}"##;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = socket.write_all(resp.as_bytes()).await;
            }
            // 2nd request: 403 user_banned
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = [0_u8; 4096];
                let _ = socket.read(&mut buf).await;
                let body = r#"{"status":"error","reason":"user_banned","banned":true,"ban_reason":"Cheating"}"#;
                let resp = format!(
                    "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = socket.write_all(resp.as_bytes()).await;
            }
        });

        let http = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap();
        let base_url = format!("http://{addr}");

        let mut account = AuthAccount {
            access_token: "mc-token".to_string(),
            client_token: "uuid-1".to_string(),
            refresh_token: Some("rt".to_string()),
            expires_at: Some(9999999999),
            uuid: "069a79f444e94726a5befca90e38aaf5".to_string(),
            name: "Notch".to_string(),
            user_properties: "{}".to_string(),
            meta: AccountMeta {
                online: true,
                account_type: "Microsoft".to_string(),
                offline: Some(false),
                access_token_expires_in: None,
                demo: Some(false),
            },
            user_info: None,
            profile: None,
            xbox: Some(XboxInfo {
                xuid: "12345".to_string(),
                gamertag: Some("Notch".to_string()),
                age_group: None,
            }),
        };

        sync_microsoft_account_if_panel(&http, Some(&base_url), &mut account)
            .await
            .expect("Active Microsoft player sync should succeed");
        let info = account.user_info.as_ref().unwrap();
        assert_eq!(info.money, 420.0);
        assert!(info.maintenance_bypass);
        assert_eq!(
            info.role.as_ref().map(|r| r.name.as_str()),
            Some("Fondateur")
        );

        let err = sync_microsoft_account_if_panel(&http, Some(&base_url), &mut account)
            .await
            .expect_err("Banned Microsoft player must be rejected");
        assert!(err.contains("user_banned"));

        let _ = server.await;
    }

    #[tokio::test]
    async fn test_live_php_backend_to_rust_tauri_and_core_end_to_end_contract() {
        use minecraft_rust_core::bundle::BundleManager;
        use std::collections::HashMap;

        // If E2E_LIVE_BUNDLE is set by the Phase 4 live PHP+JS harness, verify the exact live
        // bytes generated by centralpanel-v2, centralcorp-panel-plugin, and home.js; otherwise
        // verify representative Panel + Plugin wire payloads so `cargo test` is 100% standalone.
        let bundle: Value = if let Ok(path) = std::env::var("E2E_LIVE_BUNDLE") {
            let raw = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("Failed to read E2E_LIVE_BUNDLE '{path}': {e}"));
            serde_json::from_str(&raw).expect("E2E_LIVE_BUNDLE must be valid JSON")
        } else {
            let panel_api_body = r##"{"auth_mode":"both","azuriom_auth":true,"microsoft_auth":true,"client_id":"00000000402b5328","news_source":"both","news_url":"http://panel.centralcorp.test/utils/news","azauth":"https://azuriom.centralcorp.test","dataDirectory":"centralcorp","game_version":"1.20.1","ram_min":2.5,"ram_max":6,"java":true,"role_data":{"panel_role2":{"name":"Admin","background":"http://panel.centralcorp.test/storage/backgrounds/admin_bg.png"}},"instances":[{"id":1,"slug":"survival","name":"Survie 1.20.1","is_default":true,"game_version":"1.20.1","verify":true,"modde":true,"java":true,"java_version":17,"jvm_args":["-XX:+UseG1GC"],"game_args":["--demo-flag-test"],"auto_connect":true,"ram_min":2.5,"ram_max":6,"status":{"nameServer":"Survie Moddée","ip":"survie.centralcorp.fr","port":25565},"loader":{"type":"forge","build":"47.2.0","enable":true},"whitelist_activate":true,"whitelist":["GlobalPlayer","Riptiaz"],"whitelist_roles":["Admin"],"ignored":["options.txt","shaderpacks"],"files_url":"http://panel.centralcorp.test/utils/instances/survival/files","mods_url":"http://panel.centralcorp.test/utils/instances/survival/mods"},{"id":2,"slug":"skyblock","name":"Skyblock 1.21.1","is_default":false,"game_version":"1.21.1","verify":false,"modde":true,"java":false,"java_version":21,"jvm_args":[],"game_args":[],"auto_connect":false,"ram_min":2,"ram_max":4,"status":{"nameServer":"Skyblock Neo","ip":"sky.centralcorp.fr","port":25566},"loader":{"type":"neoforge","build":"latest","enable":true},"whitelist_activate":false,"whitelist":["GlobalPlayer"],"whitelist_roles":["Admin"],"ignored":["options.txt"],"files_url":"http://panel.centralcorp.test/utils/instances/skyblock/files","mods_url":"http://panel.centralcorp.test/utils/instances/skyblock/mods"}]}"##;
            let panel_news_body = r##"[{"id":1,"title":"Bienvenue sur CentralCorp v2","content":"<p>Lancement officiel multi-instances !</p>","author":"Riptiaz","publish_date":"2026-11-16T12:00:00+00:00","image":null,"badge":"Officiel","is_pinned":true,"external_url":"https://centralcorp.fr/news/v2"}]"##;
            let survival_mods_body = r##"{"optionalMods":["minimap.jar","sodium.jar"],"mods":{"sodium.jar":{"name":"Sodium","description":"Optimisation FPS","icon":"","recommanded":true,"recommended":true},"minimap.jar":{"name":"Xaero Minimap","description":"Minimap HUD","icon":"","recommanded":false,"recommended":false}}}"##;
            let survival_files_body = r##"[{"path":"mods/sodium.jar","size":18,"hash":"4a7d1ed414474e4033ac29ccb8653d9b00000001","url":"http://panel.centralcorp.test/storage/instances/survival/mods/sodium.jar"},{"path":"mods/minimap.jar","size":19,"hash":"4a7d1ed414474e4033ac29ccb8653d9b00000002","url":"http://panel.centralcorp.test/storage/instances/survival/mods/minimap.jar"}]"##;
            let ms_sync_ok_body = r##"{"status":"success","uuid":"069a79f444e94726a5befca90e38aaf5","username":"Riptiaz","money":2500,"banned":false,"ban_reason":null,"verified":true,"maintenance_bypass":true,"role":{"id":2,"name":"Admin","color":"#ef4444","background":"http://panel.centralcorp.test/storage/backgrounds/admin_bg.png"}}"##;
            let plugin_opts_body = r##"{"auth_mode":"azuriom","azuriom_auth":true,"microsoft_auth":false,"client_id":"","azauth":"https://azuriom.centralcorp.test","news_source":"azuriom","news_url":"https://azuriom.centralcorp.test/api/rss","dataDirectory":"azcraft","game_version":"1.20.1","ram_min":2.5,"ram_max":4,"role_data":{},"instances":[{"id":1,"slug":"faction","name":"Faction 1.20.1","is_default":true,"game_version":"1.20.1","verify":true,"modde":true,"java":true,"java_version":17,"jvm_args":["-XX:+UnlockExperimentalVMOptions"],"game_args":[],"auto_connect":true,"ram_min":2.5,"ram_max":4,"status":{"nameServer":"Azuriom Faction","ip":"faction.azuriom.test","port":25565},"loader":{"type":"forge","build":"47.2.0","enable":true},"whitelist_activate":true,"whitelist":["Riptiaz"],"whitelist_roles":[],"ignored":["resourcepacks"],"files_url":"https://azuriom.centralcorp.test/api/centralcorp/instances/faction/files","mods_url":"https://azuriom.centralcorp.test/api/centralcorp/instances/faction/mods"}]}"##;
            let faction_mods_body = r##"{"optionalMods":["iris.jar"],"mods":{"iris.jar":{"name":"Iris Shaders","description":"Shaders support","icon":"","recommanded":true,"recommended":true}}}"##;
            let faction_files_body = r##"[{"path":"mods/iris.jar","size":18,"hash":"4a7d1ed414474e4033ac29ccb8653d9b00000003","url":"https://azuriom.centralcorp.test/storage/instances/faction/mods/iris.jar"}]"##;

            json!({
                "panel": {
                    "api": { "status": 200, "body": panel_api_body },
                    "news": { "status": 200, "body": panel_news_body },
                    "survival_mods": { "status": 200, "body": survival_mods_body },
                    "skyblock_mods": { "status": 200, "body": r#"{"optionalMods":[],"mods":{}}"# },
                    "survival_files": { "status": 200, "body": survival_files_body },
                    "ms_sync_ok": { "status": 200, "body": ms_sync_ok_body },
                    "ms_sync_banned": { "status": 403, "body": r#"{"status":"error","reason":"user_banned","message":"FlyHack"}"# }
                },
                "plugin": {
                    "options": { "status": 200, "body": plugin_opts_body },
                    "faction_mods": { "status": 200, "body": faction_mods_body },
                    "faction_files": { "status": 200, "body": faction_files_body }
                }
            })
        };

        // 1. Parse Panel `/utils/api` and Plugin `/api/centralcorp/options` via `normalize_remote_config`
        let panel_meta = LauncherMeta {
            name: "centralcorp-launcher".to_string(),
            product_name: "CentralCorp".to_string(),
            version: "5.0.0".to_string(),
            env: "panel".to_string(),
            settings_url: "http://panel.centralcorp.test".to_string(),
            user_subpath: "centralcorp".to_string(),
            platform: "linux".to_string(),
            arch: "x64".to_string(),
            is_dev: false,
            data_root: "/home/player".to_string(),
            repository: None,
        };
        let panel_api_raw: Value =
            serde_json::from_str(bundle["panel"]["api"]["body"].as_str().unwrap()).unwrap();
        let panel_cfg = normalize_remote_config(panel_api_raw, &panel_meta).unwrap();
        assert_eq!(panel_cfg["auth_mode"], "both");
        assert_eq!(panel_cfg["microsoft_auth"], true);
        assert_eq!(panel_cfg["azuriom_auth"], true);
        assert_eq!(panel_cfg["instances"].as_array().unwrap().len(), 2);
        assert_eq!(panel_cfg["instances"][0]["ram_min"], 2.5);
        assert_eq!(panel_cfg["instances"][1]["java"], false);
        assert!(panel_cfg["role_data"].is_object());

        let plugin_meta = LauncherMeta {
            env: "azuriom".to_string(),
            settings_url: "https://azuriom.centralcorp.test".to_string(),
            ..panel_meta
        };
        let plugin_opts_raw: Value =
            serde_json::from_str(bundle["plugin"]["options"]["body"].as_str().unwrap()).unwrap();
        let plugin_cfg = normalize_remote_config(plugin_opts_raw, &plugin_meta).unwrap();
        assert_eq!(plugin_cfg["auth_mode"], "azuriom");
        assert_eq!(plugin_cfg["azuriom_auth"], true);
        assert_eq!(plugin_cfg["microsoft_auth"], false);
        assert_eq!(plugin_cfg["instances"][0]["slug"], "faction");
        assert_eq!(plugin_cfg["instances"][0]["ram_min"], 2.5);
        assert!(plugin_cfg["role_data"].is_object());

        // 2. Parse Panel `/utils/news` + Azuriom `/api/rss` and merge chronologically with pinned priority
        let panel_news_raw: Value =
            serde_json::from_str(bundle["panel"]["news"]["body"].as_str().unwrap()).unwrap();
        let panel_news = normalize_panel_news(panel_news_raw);
        assert_eq!(panel_news.len(), 1, "Unpublished drafts must never leak into /utils/news");
        assert!(panel_news[0].is_pinned);

        let rss_items = parse_azuriom_rss(
            r#"<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><item><title>Event PvP</title><description>Tournoi ce soir</description><pubDate>Tue, 17 Nov 2026 20:00:00 +0000</pubDate></item></channel></rss>"#,
        )
        .unwrap();
        let merged_news = merge_and_sort_news(panel_news, rss_items);
        assert_eq!(merged_news.len(), 2);
        assert_eq!(merged_news[0].title, "Bienvenue sur CentralCorp v2");

        // 3. Reconcile Optional Mods manifests from BOTH Panel (`survival` + empty `skyblock`) and Plugin (`faction`)
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("instances/survival/mods")).unwrap();
        std::fs::write(tmp.path().join("instances/survival/mods/sodium.jar"), b"jar").unwrap();
        std::fs::write(tmp.path().join("instances/survival/mods/minimap.jar"), b"jar").unwrap();
        std::fs::create_dir_all(tmp.path().join("instances/faction/mods")).unwrap();
        std::fs::write(tmp.path().join("instances/faction/mods/iris.jar"), b"jar").unwrap();

        let survival_mods_val: Value =
            serde_json::from_str(bundle["panel"]["survival_mods"]["body"].as_str().unwrap()).unwrap();
        let survival_states =
            resolve_optional_mods_state(tmp.path(), "survival", &survival_mods_val).unwrap();
        assert_eq!(survival_states.len(), 2);
        let sodium = survival_states.iter().find(|m| m.file == "sodium.jar").unwrap();
        let minimap = survival_states.iter().find(|m| m.file == "minimap.jar").unwrap();
        assert!(sodium.enabled && sodium.recommended);
        assert!(!minimap.enabled && !minimap.recommended);
        assert!(tmp.path().join("instances/survival/mods/minimap.jar-disable").exists());

        let skyblock_mods_val: Value =
            serde_json::from_str(bundle["panel"]["skyblock_mods"]["body"].as_str().unwrap()).unwrap();
        assert!(skyblock_mods_val["mods"].is_object());
        let skyblock_states =
            resolve_optional_mods_state(tmp.path(), "skyblock", &skyblock_mods_val).unwrap();
        assert!(skyblock_states.is_empty());

        let faction_mods_val: Value =
            serde_json::from_str(bundle["plugin"]["faction_mods"]["body"].as_str().unwrap()).unwrap();
        let faction_states =
            resolve_optional_mods_state(tmp.path(), "faction", &faction_mods_val).unwrap();
        assert_eq!(faction_states.len(), 1);
        assert!(faction_states[0].enabled);

        // 4. Live Local HTTP Server serving exact PHP wire payloads to `sync_microsoft_account_if_panel`
        //    AND `BundleManager::fetch_custom_distribution`!
        let mut routes: HashMap<String, (u16, String)> = HashMap::new();
        routes.insert(
            "/utils/instances/survival/files".to_string(),
            (200, bundle["panel"]["survival_files"]["body"].as_str().unwrap().to_string()),
        );
        routes.insert(
            "/api/centralcorp/instances/faction/files".to_string(),
            (200, bundle["plugin"]["faction_files"]["body"].as_str().unwrap().to_string()),
        );
        let sync_ok_body = bundle["panel"]["ms_sync_ok"]["body"].as_str().unwrap().to_string();
        let sync_ban_body = bundle["panel"]["ms_sync_banned"]["body"].as_str().unwrap().to_string();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let routes_arc = Arc::new(routes);

        let server = tokio::spawn(async move {
            for _ in 0..4 {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let mut buf = vec![0_u8; 8192];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req_str = String::from_utf8_lossy(&buf[..n]);
                let first_line = req_str.lines().next().unwrap_or("");
                let path = first_line.split_whitespace().nth(1).unwrap_or("/");

                let (status, body) = if path == "/utils/auth/microsoft/sync" {
                    if req_str.contains("banned-cheater-token") {
                        (403_u16, sync_ban_body.clone())
                    } else {
                        (200_u16, sync_ok_body.clone())
                    }
                } else if let Some((st, b)) = routes_arc.get(path) {
                    (*st, b.clone())
                } else {
                    (404_u16, r#"{"error":"not_found"}"#.to_string())
                };

                let reason = if status == 200 { "OK" } else { "Forbidden" };
                let resp = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });

        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let base = format!("http://{addr}");

        let mut riptiaz_acc = AuthAccount {
            access_token: "valid-riptiaz-token".to_string(),
            client_token: "069a79f444e94726a5befca90e38aaf5".to_string(),
            refresh_token: Some("rt".to_string()),
            expires_at: Some(9999999999),
            uuid: "069a79f444e94726a5befca90e38aaf5".to_string(),
            name: "Riptiaz".to_string(),
            user_properties: "{}".to_string(),
            meta: AccountMeta {
                online: true,
                account_type: "Microsoft".to_string(),
                offline: Some(false),
                access_token_expires_in: None,
                demo: Some(false),
            },
            user_info: None,
            profile: None,
            xbox: Some(XboxInfo {
                xuid: "2535499999999999".to_string(),
                gamertag: Some("Riptiaz".to_string()),
                age_group: None,
            }),
        };

        sync_microsoft_account_if_panel(&http, Some(&base), &mut riptiaz_acc)
            .await
            .expect("Live PHP ms_sync_ok response must sync cleanly");
        let ui = riptiaz_acc.user_info.as_ref().unwrap();
        assert_eq!(ui.money, 2500.0);
        assert!(ui.maintenance_bypass);
        assert_eq!(ui.role.as_ref().map(|r| r.name.as_str()), Some("Admin"));

        let mut cheater_acc = riptiaz_acc.clone();
        cheater_acc.access_token = "banned-cheater-token".to_string();
        let ban_err = sync_microsoft_account_if_panel(&http, Some(&base), &mut cheater_acc)
            .await
            .expect_err("Live PHP ms_sync_banned 403 must reject login");
        assert!(ban_err.contains("user_banned") && ban_err.contains("FlyHack"));

        let bm_panel = BundleManager::new(
            tmp.path().to_path_buf(),
            tmp.path().join("instances/survival"),
            true,
            &["options.txt".to_string(), "shaderpacks".to_string()],
        );
        let dist_panel = bm_panel
            .fetch_custom_distribution(&http, Some(&format!("{base}/utils/instances/survival/files")))
            .await
            .expect("Panel files manifest must parse into BundleItems");
        assert_eq!(dist_panel.len(), 2);

        let bm_plugin = BundleManager::new(
            tmp.path().to_path_buf(),
            tmp.path().join("instances/faction"),
            true,
            &["resourcepacks".to_string()],
        );
        let dist_plugin = bm_plugin
            .fetch_custom_distribution(
                &http,
                Some(&format!("{base}/api/centralcorp/instances/faction/files")),
            )
            .await
            .expect("Plugin files manifest must parse into BundleItems");
        assert_eq!(dist_plugin.len(), 1);

        let _ = server.await;

        // 5. If JS-generated LaunchOptions payloads were included in E2E_LIVE_BUNDLE, deserialize and
        //    verify every field (`2560M` integer RAM, `java.path` system vs embedded, AZauth + Microsoft)!
        if let Some(js_opts_arr) = bundle.get("js_launch_options").and_then(|v| v.as_array()) {
            assert_eq!(js_opts_arr.len(), 3);
            for raw_opt in js_opts_arr {
                let parsed: LaunchOptions = serde_json::from_value(raw_opt.clone())
                    .expect("JS home.js LaunchOptions must deserialize cleanly into Rust LaunchOptions");
                assert!(!parsed.memory.min.contains('.'), "JVM -Xms must never contain float decimal");
                assert!(!parsed.memory.max.contains('.'), "JVM -Xmx must never contain float decimal");
            }
            let p_surv: LaunchOptions = serde_json::from_value(js_opts_arr[0].clone()).unwrap();
            assert_eq!(p_surv.memory.min, "2560M");
            assert_eq!(p_surv.memory.max, "6144M");
            assert!(p_surv.java.path.is_none());
            assert_eq!(p_surv.authenticator.meta.account_type, "Microsoft");

            let p_sky: LaunchOptions = serde_json::from_value(js_opts_arr[1].clone()).unwrap();
            assert_eq!(p_sky.java.path.as_deref(), Some(std::path::Path::new("system")));

            let p_fac: LaunchOptions = serde_json::from_value(js_opts_arr[2].clone()).unwrap();
            assert_eq!(p_fac.memory.min, "2560M");
            assert_eq!(p_fac.authenticator.meta.account_type, "AZauth");
        }
    }
}

