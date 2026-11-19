use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
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

static TOTAL_SYSTEM_RAM_GB: OnceLock<f64> = OnceLock::new();

#[tauri::command]
pub async fn get_system_memory() -> Result<SystemMemoryInfo, String> {
    tokio::task::spawn_blocking(|| {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();

        let total_gb = *TOTAL_SYSTEM_RAM_GB
            .get_or_init(|| round_bytes_to_half_gb(sys.total_memory()).max(1.0));
        let avail = sys.available_memory();
        let free_bytes = if avail > 0 { avail } else { sys.free_memory() };
        let free_gb = round_bytes_to_half_gb(free_bytes).min(total_gb);

        SystemMemoryInfo { total_gb, free_gb }
    })
    .await
    .map_err(|e| format!("System memory probe failed: {e}"))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fetch_remote_config(
    state: State<'_, LauncherState>,
    force_refresh: Option<bool>,
) -> Result<Value, String> {
    let meta = read_launcher_meta()?;
    fetch_remote_config_inner(state.inner(), &meta, force_refresh.unwrap_or(false)).await
}

fn append_bootstrap_include_query(base_url: &str) -> String {
    if let Ok(mut parsed) = url::Url::parse(base_url) {
        let has_include = parsed
            .query_pairs()
            .any(|(k, _)| k.eq_ignore_ascii_case("include"));
        if !has_include {
            parsed.query_pairs_mut().append_pair("include", "news,mods");
        }
        parsed.into()
    } else if base_url.contains('?') {
        format!("{base_url}&include=news,mods")
    } else {
        format!("{base_url}?include=news,mods")
    }
}

fn is_mods_manifest_object(val: &Value) -> bool {
    val.as_object()
        .map(|obj| obj.contains_key("optionalMods"))
        .unwrap_or(false)
}

/// Extracts optional bootstrap `included_news` and per-instance optional-mods manifests from a
/// `/utils/api?include=news,mods` or `/api/centralcorp/options?include=news,mods` response,
/// caching them inside [`LauncherState`] and removing bulky transient bootstrap keys before IPC.
fn extract_and_cache_bootstrap_extras(state: &LauncherState, raw: &mut Value) {
    let Some(obj) = raw.as_object_mut() else {
        return;
    };

    // 1. Extract bootstrap news (`included_news` or `news`)
    let news_payload = obj.remove("included_news").or_else(|| {
        if obj
            .get("news")
            .map(|v| v.is_array() || v.is_object())
            .unwrap_or(false)
        {
            obj.remove("news")
        } else {
            None
        }
    });
    if let Some(news_val) = news_payload {
        let parsed = normalize_panel_news(news_val);
        state.store_included_news(parsed);
    }

    // Determine primary fallback slug for single-instance manifests
    let first_slug = obj
        .get("instances")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|inst| inst.get("slug"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("default")
        .to_string();

    // 2. Extract top-level `included_mods` / `mods_by_instance` / `mods`
    for top_key in ["included_mods", "mods_by_instance"] {
        if let Some(mods_val) = obj.remove(top_key) {
            cache_mods_payload(state, &mods_val, &first_slug);
        }
    }
    if let Some(top_mods) = obj.get("mods") {
        if top_mods.is_object() {
            cache_mods_payload(state, top_mods, &first_slug);
        }
    }

    // 3. Extract per-instance embedded mod manifests if present
    if let Some(Value::Array(instances)) = obj.get_mut("instances") {
        for (idx, inst) in instances.iter_mut().enumerate() {
            let Some(inst_map) = inst.as_object_mut() else {
                continue;
            };
            let slug = inst_map
                .get("slug")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    if idx == 0 {
                        "default".to_string()
                    } else {
                        format!("instance-{}", idx + 1)
                    }
                });

            for inst_key in ["included_mods", "optional_mods", "mods_manifest"] {
                if let Some(m_val) = inst_map.remove(inst_key) {
                    if is_mods_manifest_object(&m_val) {
                        state.store_instance_mods(&slug, m_val);
                    }
                }
            }
            if let Some(m_val) = inst_map.get("mods") {
                if is_mods_manifest_object(m_val) {
                    state.store_instance_mods(&slug, m_val.clone());
                }
            }
        }
    }
}

fn cache_mods_payload(state: &LauncherState, payload: &Value, default_slug: &str) {
    if is_mods_manifest_object(payload) {
        state.store_instance_mods(default_slug, payload.clone());
        if default_slug != "default" {
            state.store_instance_mods("default", payload.clone());
        }
        return;
    }

    if let Some(map) = payload.as_object() {
        for (slug, entry) in map {
            if is_mods_manifest_object(entry) {
                state.store_instance_mods(slug, entry.clone());
            }
        }
    }
}

async fn fetch_remote_config_inner(
    state: &LauncherState,
    meta: &LauncherMeta,
    force_refresh: bool,
) -> Result<Value, String> {
    if !force_refresh {
        if let Some(cached) = state.fresh_remote_config() {
            return Ok(cached);
        }
    }

    let base_config_url = resolve_remote_config_url(meta)?;
    let request_url = append_bootstrap_include_query(&base_config_url);
    let cached_entry = state.cached_remote_config_entry();

    let mut req = state.http().get(&request_url);
    if let Some(etag) = cached_entry.as_ref().and_then(|c| c.etag.as_deref()) {
        if !etag.trim().is_empty() {
            req = req.header(reqwest::header::IF_NONE_MATCH, etag);
        }
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend configuration '{base_config_url}': {e}"))?;

    let status = resp.status();
    if status == reqwest::StatusCode::NOT_MODIFIED {
        if let Some(touched) = state.touch_all_cached_bootstrap() {
            return Ok(touched);
        }
        if let Some(prev) = cached_entry {
            return Ok(prev.config);
        }
    }

    if !status.is_success() {
        return Err(format!(
            "Backend configuration endpoint '{base_config_url}' returned HTTP {status}"
        ));
    }

    let etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let mut raw_json: Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid JSON from '{base_config_url}': {e}"))?;

    extract_and_cache_bootstrap_extras(state, &mut raw_json);
    let normalized = normalize_remote_config(raw_json, meta)?;
    state.store_remote_config(etag, normalized.clone());

    Ok(normalized)
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
    fetch_news_inner(
        state.inner(),
        &meta,
        news_source.as_deref(),
        news_url.as_deref(),
        azauth_url.as_deref(),
    )
    .await
}

async fn fetch_news_inner(
    state: &LauncherState,
    meta: &LauncherMeta,
    news_source: Option<&str>,
    news_url: Option<&str>,
    azauth_url: Option<&str>,
) -> Result<Vec<NewsItem>, String> {
    let mode = news_source
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
            if let Some(cached_news) = state.fresh_included_news() {
                return Ok(merge_and_sort_news(cached_news, Vec::new()));
            }
            let Some(url) = resolved_panel_news_url else {
                return Ok(Vec::new());
            };
            let items = fetch_panel_news_from_url(http, &url).await?;
            state.store_included_news(items.clone());
            Ok(merge_and_sort_news(items, Vec::new()))
        }
        "azuriom" | "rss" => {
            if let Some(cached_news) = state.fresh_included_news() {
                if !cached_news.is_empty() {
                    return Ok(merge_and_sort_news(cached_news, Vec::new()));
                }
            }
            let Some(url) = resolved_rss_url else {
                return Ok(Vec::new());
            };
            fetch_rss_news_from_url(http, &url).await
        }
        "both" => {
            if let Some(cached_panel_items) = state.fresh_included_news() {
                let rss_items = match resolved_rss_url {
                    Some(ref url) => fetch_rss_news_from_url(http, url).await.unwrap_or_default(),
                    None => Vec::new(),
                };
                return Ok(merge_and_sort_news(cached_panel_items, rss_items));
            }

            let panel_fut = async {
                match resolved_panel_news_url {
                    Some(ref url) => {
                        let fetched = fetch_panel_news_from_url(http, url).await.unwrap_or_default();
                        state.store_included_news(fetched.clone());
                        fetched
                    }
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

/// Returns `true` when `host` is empty, `localhost`, loopback, link-local, or RFC1918 private
/// so we never leak internal/LAN addresses or waste 5s querying `api.mcsrvstat.us`.
pub fn is_private_or_local_host(host: &str) -> bool {
    let clean = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();

    if clean.is_empty()
        || clean == "localhost"
        || clean.ends_with(".localhost")
        || clean.ends_with(".local")
        || clean.ends_with(".internal")
        || clean.ends_with(".lan")
        || clean.ends_with(".home")
    {
        return true;
    }

    if let Ok(ip) = clean.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => {
                v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || v4.is_unspecified()
                    || v4.is_broadcast()
            }
            IpAddr::V6(v6) => {
                if let Some(mapped) = v6.to_ipv4_mapped() {
                    mapped.is_loopback()
                        || mapped.is_private()
                        || mapped.is_link_local()
                        || mapped.is_unspecified()
                } else {
                    let seg0 = v6.segments()[0];
                    v6.is_loopback()
                        || v6.is_unspecified()
                        || (seg0 & 0xfe00) == 0xfc00 // fc00::/7 unique local
                        || (seg0 & 0xffc0) == 0xfe80 // fe80::/10 link-local
                }
            }
        };
    }

    false
}

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
        .with_timeout(2_500)
        .ping()
        .await
    {
        if direct.online {
            return Ok(direct);
        }
    }

    // Fallback to HTTP status API only for public routable hostnames/IPs
    if !is_private_or_local_host(trimmed_host) {
        if let Some(fallback) =
            ping_via_mcsrvstat_fallback(state.http(), trimmed_host, resolved_port).await
        {
            return Ok(fallback);
        }
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
        .timeout(Duration::from_secs(4))
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

#[tauri::command(rename_all = "snake_case")]
pub async fn sync_microsoft_panel(
    state: State<'_, LauncherState>,
    mut account: AuthAccount,
    panel_base_url: Option<String>,
) -> Result<AuthAccount, String> {
    sync_microsoft_account_if_panel(state.http(), panel_base_url.as_deref(), &mut account).await?;
    Ok(account)
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
    state: State<'_, LauncherState>,
    mut account: AuthAccount,
    base_url: Option<String>,
    panel_base_url: Option<String>,
    png_base64: String,
    slim: bool,
) -> Result<AuthAccount, String> {
    let png_bytes = decode_png_base64(&png_base64)?;
    let requested_variant = if slim {
        SkinVariant::Slim
    } else {
        SkinVariant::Classic
    };

    if account
        .meta
        .account_type
        .eq_ignore_ascii_case("microsoft")
    {
        let updated_profile = MicrosoftClient::new(None)
            .upload_skin(&account.access_token, &png_bytes, requested_variant)
            .await
            .map_err(|e| e.to_string())?;
        account.profile = Some(updated_profile);
        let _ =
            sync_microsoft_account_if_panel(state.http(), panel_base_url.as_deref(), &mut account)
                .await;
        return Ok(account);
    }

    // Azuriom `skin-api` upload
    let az_base = resolve_azauth_base(base_url.as_deref().unwrap_or_default())?;
    let az_client = AzAuthClient::new(&az_base).map_err(|e| e.to_string())?;
    az_client
        .upload_skin(&account.access_token, &png_bytes)
        .await
        .map_err(|e| e.to_string())?;

    let data_uri = format!("data:image/png;base64,{}", BASE64_STANDARD.encode(&png_bytes));

    // Refresh Azuriom session and stamp fresh base64 + chosen Classic/Slim variant for instant 3D preview
    if let Ok(mut verified) = az_client.verify(&account.access_token).await {
        let skin_id = verified
            .user_info
            .as_ref()
            .and_then(|u| u.id.as_deref())
            .unwrap_or(&verified.uuid)
            .to_string();
        let fallback_url = format!("{}/{}", az_client.skin_base_url(), skin_id);
        let profile = verified.profile.get_or_insert_with(|| MinecraftProfile {
            id: verified.uuid.clone(),
            name: verified.name.clone(),
            skins: Vec::new(),
            capes: Vec::new(),
        });
        if let Some(first_skin) = profile.skins.first_mut() {
            first_skin.variant = Some(requested_variant);
            first_skin.base64 = Some(data_uri);
        } else {
            profile.skins.push(SkinInfo {
                id: None,
                state: Some("ACTIVE".to_string()),
                url: fallback_url,
                texture_key: None,
                variant: Some(requested_variant),
                alias: None,
                base64: Some(data_uri),
            });
        }
        return Ok(verified);
    }

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
        variant: Some(requested_variant),
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

async fn get_or_fetch_mods_manifest(
    state: &LauncherState,
    instance_slug: &str,
    mods_url: &str,
    timeout_secs: u64,
) -> Result<Value, String> {
    if let Some(cached) = state.fresh_instance_mods(instance_slug) {
        return Ok(cached);
    }

    let trimmed_url = mods_url.trim();
    if trimmed_url.is_empty() {
        return Ok(serde_json::json!({ "optionalMods": [], "mods": {} }));
    }

    let resp = state
        .http()
        .get(trimmed_url)
        .timeout(Duration::from_secs(timeout_secs))
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

    state.store_instance_mods(instance_slug, manifest.clone());
    Ok(manifest)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn list_optional_mods(
    state: State<'_, LauncherState>,
    data_directory: String,
    instance_slug: String,
    mods_url: String,
) -> Result<Vec<OptionalModState>, String> {
    let trimmed_url = mods_url.trim();
    if trimmed_url.is_empty() && state.fresh_instance_mods(&instance_slug).is_none() {
        return Ok(Vec::new());
    }

    let manifest = get_or_fetch_mods_manifest(state.inner(), &instance_slug, trimmed_url, 10).await?;
    let root = PathBuf::from(data_directory.trim());
    let slug = instance_slug.clone();

    let _io_guard = state.mods_io_lock().lock().await;
    tokio::task::spawn_blocking(move || resolve_optional_mods_state(&root, &slug, &manifest))
        .await
        .map_err(|e| format!("Optional mods worker panicked: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn toggle_optional_mod(
    state: State<'_, LauncherState>,
    data_directory: String,
    instance_slug: String,
    mod_file: String,
    enabled: bool,
) -> Result<OptionalModState, String> {
    let root = PathBuf::from(data_directory.trim());
    let _io_guard = state.mods_io_lock().lock().await;
    tokio::task::spawn_blocking(move || {
        toggle_optional_mod_on_disk(&root, &instance_slug, &mod_file, enabled)
    })
    .await
    .map_err(|e| format!("Optional mods toggle worker panicked: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn sync_optional_mods(
    state: State<'_, LauncherState>,
    data_directory: String,
    instance_slug: String,
    mods_url: Option<String>,
) -> Result<(), String> {
    let cached_or_fetched = if let Some(cached) = state.fresh_instance_mods(&instance_slug) {
        Some(cached)
    } else if let Some(url) = mods_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        get_or_fetch_mods_manifest(state.inner(), &instance_slug, url, 5)
            .await
            .ok()
    } else {
        None
    };

    let root = PathBuf::from(data_directory.trim());
    let slug = instance_slug.clone();
    let _io_guard = state.mods_io_lock().lock().await;
    tokio::task::spawn_blocking(move || {
        if let Some(manifest) = cached_or_fetched {
            if resolve_optional_mods_state(&root, &slug, &manifest).is_ok() {
                return Ok(());
            }
        }
        sync_optional_mods_on_disk(&root, &slug)
    })
    .await
    .map_err(|e| format!("Optional mods sync worker panicked: {e}"))?
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
    mods_url: Option<String>,
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
    let already_closed = Arc::new(AtomicBool::new(false));
    let last_taskbar_state = Arc::new(Mutex::new((0_u8, 0_u64)));

    let cb_pid_slot = Arc::clone(&tracked_pid_slot);
    let cb_already_closed = Arc::clone(&already_closed);
    let cb_taskbar = Arc::clone(&last_taskbar_state);
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

        update_taskbar_progress_from_event(&cb_app, &event, &cb_taskbar);

        if matches!(event, LaunchEvent::Close { .. }) {
            cb_already_closed.store(true, Ordering::SeqCst);
            if let Ok(guard) = cb_pid_slot.lock() {
                if *guard != 0 {
                    cb_state.remove_child_pid(*guard);
                }
            }
        }

        let _ = cb_app.emit("launch-event", &event);
    });

    let post_prepare_root = options.path.clone();
    let post_prepare_slug = options
        .instance_slug()
        .unwrap_or_else(|| "default".to_string());
    let post_prepare_modded = options.url.is_some();

    let launcher = Launcher::new(options);
    let prepared = match launcher.prepare(Arc::clone(&callback)).await {
        Ok(prep) => prep,
        Err(err) => {
            clear_taskbar_progress(&app);
            return Err(err.to_string());
        }
    };

    // Reconcile optional mods AFTER bundle/ZIP extraction and BEFORE spawning the JVM so even
    // on a brand-new first launch, non-recommended (`recommended: false`) or previously disabled
    // optional mods extracted from `mods-optional` packages are renamed to `.jar-disable`.
    if post_prepare_modded {
        reconcile_optional_mods_with_state(
            state.inner(),
            &post_prepare_root,
            &post_prepare_slug,
            mods_url.as_deref(),
        )
        .await;
    }

    let pid = match launcher.spawn_prepared(&prepared, callback).await {
        Ok(pid) => pid,
        Err(err) => {
            clear_taskbar_progress(&app);
            return Err(err.to_string());
        }
    };

    if !already_closed.load(Ordering::SeqCst) {
        if let Ok(mut guard) = tracked_pid_slot.lock() {
            *guard = pid;
        }
        state.register_child_pid(pid);
        if already_closed.load(Ordering::SeqCst) {
            state.remove_child_pid(pid);
        }
    }

    Ok(pid)
}

async fn reconcile_optional_mods_with_state(
    state: &LauncherState,
    data_directory: &std::path::Path,
    instance_slug: &str,
    mods_url: Option<&str>,
) {
    let manifest_opt = if let Some(cached) = state.fresh_instance_mods(instance_slug) {
        Some(cached)
    } else if let Some(trimmed_url) = mods_url.map(str::trim).filter(|s| !s.is_empty()) {
        get_or_fetch_mods_manifest(state, instance_slug, trimmed_url, 5)
            .await
            .ok()
    } else {
        None
    };

    let root = data_directory.to_path_buf();
    let slug = instance_slug.to_string();
    let _io_guard = state.mods_io_lock().lock().await;
    let _ = tokio::task::spawn_blocking(move || {
        if let Some(manifest) = manifest_opt {
            if resolve_optional_mods_state(&root, &slug, &manifest).is_ok() {
                return;
            }
        }
        let _ = sync_optional_mods_on_disk(&root, &slug);
    })
    .await;
}

#[cfg(test)]
async fn reconcile_optional_mods_post_prepare(
    http: &reqwest::Client,
    data_directory: &std::path::Path,
    instance_slug: &str,
    mods_url: Option<&str>,
) {
    let temp_state = LauncherState::with_http_client(http.clone());
    reconcile_optional_mods_with_state(&temp_state, data_directory, instance_slug, mods_url).await;
}

fn update_taskbar_progress_from_event(
    app: &AppHandle,
    event: &LaunchEvent,
    last_state: &Mutex<(u8, u64)>,
) {
    let desired: Option<(u8, u64, ProgressBarState)> = match event {
        LaunchEvent::Check { current, total, .. } if *total > 0 => {
            let pct = ((*current as u64).saturating_mul(100) / (*total as u64)).min(100);
            Some((
                1,
                pct,
                ProgressBarState {
                    status: Some(ProgressBarStatus::Normal),
                    progress: Some(pct),
                },
            ))
        }
        LaunchEvent::Progress {
            downloaded, total, ..
        } if *total > 0 => {
            let pct = (downloaded.saturating_mul(100) / *total).min(100);
            Some((
                1,
                pct,
                ProgressBarState {
                    status: Some(ProgressBarStatus::Normal),
                    progress: Some(pct),
                },
            ))
        }
        LaunchEvent::Extract { .. } => Some((
            2,
            0,
            ProgressBarState {
                status: Some(ProgressBarStatus::Indeterminate),
                progress: None,
            },
        )),
        LaunchEvent::Data { .. } | LaunchEvent::Close { .. } | LaunchEvent::Error { .. } => Some((
            0,
            0,
            ProgressBarState {
                status: Some(ProgressBarStatus::None),
                progress: None,
            },
        )),
        _ => None,
    };

    let Some((tag, pct, bar_state)) = desired else {
        return;
    };

    if let Ok(mut prev) = last_state.lock() {
        if *prev == (tag, pct) {
            return;
        }
        *prev = (tag, pct);
    }

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_progress_bar(bar_state);
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
pub fn set_close_behavior(state: State<'_, LauncherState>, behavior: String) {
    state.set_close_behavior(&behavior);
}

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

#[cfg(debug_assertions)]
fn debug_log_sender() -> &'static std::sync::mpsc::Sender<String> {
    static SENDER: OnceLock<std::sync::mpsc::Sender<String>> = OnceLock::new();
    SENDER.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let _ = std::thread::Builder::new()
            .name("centralcorp-debug-log".to_string())
            .spawn(move || {
                use std::io::Write;
                let mut file_opt = std::env::current_exe()
                    .ok()
                    .and_then(|exe| exe.parent().map(|d| d.join("debug.log")))
                    .and_then(|path| {
                        std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(path)
                            .ok()
                    });
                while let Ok(msg) = rx.recv() {
                    eprint!("{msg}");
                    if let Some(ref mut f) = file_opt {
                        let _ = f.write_all(msg.as_bytes());
                    }
                }
            });
        tx
    })
}

pub fn write_debug_trace(line: &str) {
    #[cfg(debug_assertions)]
    {
        let ts = chrono::Local::now().format("%H:%M:%S%.3f");
        let formatted = format!("[{ts}] {line}\n");
        let _ = debug_log_sender().send(formatted);
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

    #[tokio::test]
    async fn test_packaged_zip_distribution_and_first_launch_optional_mods_reconciliation() {
        use minecraft_rust_core::bundle::BundleManager;
        use minecraft_rust_core::downloader::Downloader;
        use sha1::{Digest, Sha1};
        use std::collections::HashMap;
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        use zip::{CompressionMethod, ZipWriter};

        fn sha1_hex(bytes: &[u8]) -> String {
            let mut h = Sha1::new();
            h.update(bytes);
            hex::encode(h.finalize())
        }

        fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
            let mut cursor = std::io::Cursor::new(Vec::new());
            {
                let mut writer = ZipWriter::new(&mut cursor);
                for &(rel_path, data) in entries {
                    let method = if rel_path.ends_with(".jar") {
                        CompressionMethod::Stored
                    } else {
                        CompressionMethod::Deflated
                    };
                    let opts = SimpleFileOptions::default().compression_method(method);
                    writer.start_file(rel_path, opts).unwrap();
                    writer.write_all(data).unwrap();
                }
                writer.finish().unwrap();
            }
            cursor.into_inner()
        }

        let core_jar = b"required-core-mod-v1";
        let sodium_jar = b"optional-sodium-mod-v1";
        let minimap_jar = b"optional-minimap-mod-v1";
        let config_v1 = b"fov = 90\n";
        let config_v2 = b"fov = 110\nrenderDistance = 16\n";

        let zip_mods = build_zip(&[("mods/core.jar", core_jar)]);
        let zip_mods_opt = build_zip(&[
            ("mods/minimap.jar", minimap_jar),
            ("mods/sodium.jar", sodium_jar),
        ]);
        let zip_cfg_v1 = build_zip(&[("config/client.toml", config_v1)]);
        let zip_cfg_v2 = build_zip(&[("config/client.toml", config_v2)]);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{addr}");

        let manifest_v1 = json!({
            "version": 2,
            "packages": [
                {
                    "id": "pkg-config-p1-v1",
                    "folder": "config",
                    "part": 1,
                    "url": format!("{base}/utils/packages/survival/pkg-config-p1-v1.zip"),
                    "hash": sha1_hex(&zip_cfg_v1),
                    "size": zip_cfg_v1.len(),
                    "files_count": 1
                },
                {
                    "id": "pkg-mods-p1-v1",
                    "folder": "mods",
                    "part": 1,
                    "url": format!("{base}/utils/packages/survival/pkg-mods-p1-v1.zip"),
                    "hash": sha1_hex(&zip_mods),
                    "size": zip_mods.len(),
                    "files_count": 1
                },
                {
                    "id": "pkg-mods-optional-p1-v1",
                    "folder": "mods-optional",
                    "part": 1,
                    "url": format!("{base}/utils/packages/survival/pkg-mods-optional-p1-v1.zip"),
                    "hash": sha1_hex(&zip_mods_opt),
                    "size": zip_mods_opt.len(),
                    "files_count": 2
                }
            ],
            "files": [
                {
                    "path": "config/client.toml",
                    "size": config_v1.len(),
                    "hash": sha1_hex(config_v1),
                    "url": format!("{base}/storage/instances/survival/config/client.toml"),
                    "package": "pkg-config-p1-v1"
                },
                {
                    "path": "mods/core.jar",
                    "size": core_jar.len(),
                    "hash": sha1_hex(core_jar),
                    "url": format!("{base}/storage/instances/survival/mods/core.jar"),
                    "package": "pkg-mods-p1-v1"
                },
                {
                    "path": "mods/minimap.jar",
                    "size": minimap_jar.len(),
                    "hash": sha1_hex(minimap_jar),
                    "url": format!("{base}/storage/instances/survival/mods/minimap.jar"),
                    "package": "pkg-mods-optional-p1-v1"
                },
                {
                    "path": "mods/sodium.jar",
                    "size": sodium_jar.len(),
                    "hash": sha1_hex(sodium_jar),
                    "url": format!("{base}/storage/instances/survival/mods/sodium.jar"),
                    "package": "pkg-mods-optional-p1-v1"
                }
            ]
        });

        let manifest_v2 = json!({
            "version": 2,
            "packages": [
                {
                    "id": "pkg-config-p1-v2",
                    "folder": "config",
                    "part": 1,
                    "url": format!("{base}/utils/packages/survival/pkg-config-p1-v2.zip"),
                    "hash": sha1_hex(&zip_cfg_v2),
                    "size": zip_cfg_v2.len(),
                    "files_count": 1
                },
                {
                    "id": "pkg-mods-p1-v1",
                    "folder": "mods",
                    "part": 1,
                    "url": format!("{base}/utils/packages/survival/pkg-mods-p1-v1.zip"),
                    "hash": sha1_hex(&zip_mods),
                    "size": zip_mods.len(),
                    "files_count": 1
                },
                {
                    "id": "pkg-mods-optional-p1-v1",
                    "folder": "mods-optional",
                    "part": 1,
                    "url": format!("{base}/utils/packages/survival/pkg-mods-optional-p1-v1.zip"),
                    "hash": sha1_hex(&zip_mods_opt),
                    "size": zip_mods_opt.len(),
                    "files_count": 2
                }
            ],
            "files": [
                {
                    "path": "config/client.toml",
                    "size": config_v2.len(),
                    "hash": sha1_hex(config_v2),
                    "url": format!("{base}/storage/instances/survival/config/client.toml"),
                    "package": "pkg-config-p1-v2"
                },
                {
                    "path": "mods/core.jar",
                    "size": core_jar.len(),
                    "hash": sha1_hex(core_jar),
                    "url": format!("{base}/storage/instances/survival/mods/core.jar"),
                    "package": "pkg-mods-p1-v1"
                },
                {
                    "path": "mods/minimap.jar",
                    "size": minimap_jar.len(),
                    "hash": sha1_hex(minimap_jar),
                    "url": format!("{base}/storage/instances/survival/mods/minimap.jar"),
                    "package": "pkg-mods-optional-p1-v1"
                },
                {
                    "path": "mods/sodium.jar",
                    "size": sodium_jar.len(),
                    "hash": sha1_hex(sodium_jar),
                    "url": format!("{base}/storage/instances/survival/mods/sodium.jar"),
                    "package": "pkg-mods-optional-p1-v1"
                }
            ]
        });

        let mods_manifest = json!({
            "optionalMods": ["sodium.jar", "minimap.jar"],
            "mods": {
                "sodium.jar": {
                    "name": "Sodium",
                    "description": "FPS boost",
                    "recommanded": true,
                    "recommended": true
                },
                "minimap.jar": {
                    "name": "Xaero Minimap",
                    "description": "Minimap",
                    "recommanded": false,
                    "recommended": false
                }
            }
        });

        let active_generation = Arc::new(Mutex::new(1_u8));
        let hit_counts: Arc<Mutex<HashMap<String, usize>>> = Arc::new(Mutex::new(HashMap::new()));
        let saw_accept_packages = Arc::new(Mutex::new(false));

        let gen_srv = Arc::clone(&active_generation);
        let hits_srv = Arc::clone(&hit_counts);
        let hdr_srv = Arc::clone(&saw_accept_packages);
        let m1_str = serde_json::to_vec(&manifest_v1).unwrap();
        let m2_str = serde_json::to_vec(&manifest_v2).unwrap();
        let mods_str = serde_json::to_vec(&mods_manifest).unwrap();

        let server = tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = vec![0_u8; 8192];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    continue;
                }
                let req_str = String::from_utf8_lossy(&buf[..n]);
                if req_str.to_ascii_lowercase().contains("x-accept-packages: 1") {
                    *hdr_srv.lock().unwrap() = true;
                }
                let path = req_str
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("/")
                    .to_string();

                *hits_srv.lock().unwrap().entry(path.clone()).or_insert(0) += 1;

                let (ctype, body): (&str, Vec<u8>) = match path.as_str() {
                    "/utils/instances/survival/files" => {
                        let g = *gen_srv.lock().unwrap();
                        if g == 1 {
                            ("application/json", m1_str.clone())
                        } else {
                            ("application/json", m2_str.clone())
                        }
                    }
                    "/utils/instances/survival/mods" => ("application/json", mods_str.clone()),
                    "/utils/packages/survival/pkg-config-p1-v1.zip" => {
                        ("application/zip", zip_cfg_v1.clone())
                    }
                    "/utils/packages/survival/pkg-config-p1-v2.zip" => {
                        ("application/zip", zip_cfg_v2.clone())
                    }
                    "/utils/packages/survival/pkg-mods-p1-v1.zip" => {
                        ("application/zip", zip_mods.clone())
                    }
                    "/utils/packages/survival/pkg-mods-optional-p1-v1.zip" => {
                        ("application/zip", zip_mods_opt.clone())
                    }
                    _ => ("application/json", br#"{"error":"not_found"}"#.to_vec()),
                };

                let status = if body == br#"{"error":"not_found"}"# {
                    "404 Not Found"
                } else {
                    "200 OK"
                };
                let header = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = sock.write_all(header.as_bytes()).await;
                let _ = sock.write_all(&body).await;
            }
        });

        let tmp = tempfile::tempdir().unwrap();
        let game_root = tmp.path();
        let inst_dir = game_root.join("instances/survival");
        let bm = BundleManager::new(
            game_root.to_path_buf(),
            inst_dir.clone(),
            true,
            &["options.txt".to_string(), "launcher_config".to_string()],
        );
        let downloader = Downloader::new(4, 10_000);
        let http = downloader.client().clone();
        let files_url = format!("{base}/utils/instances/survival/files");
        let mods_url = format!("{base}/utils/instances/survival/mods");
        let extract_events = Arc::new(Mutex::new(Vec::<String>::new()));
        let ext_cb = Arc::clone(&extract_events);
        let cb: Arc<dyn Fn(LaunchEvent) + Send + Sync> = Arc::new(move |ev| {
            if let LaunchEvent::Extract { message } = ev {
                ext_cb.lock().unwrap().push(message);
            }
        });

        // --- Launch 1: Brand-new install (3 ZIP packages + post-prepare optional mod reconciliation) ---
        let dist1 = bm
            .fetch_custom_distribution_packaged(&http, Some(&files_url))
            .await
            .unwrap();
        assert!(*saw_accept_packages.lock().unwrap(), "X-Accept-Packages: 1 header must be sent");
        assert_eq!(dist1.packages.len(), 3);
        bm.sync_bundle(&downloader, &dist1.items, &dist1.packages, &cb)
            .await
            .unwrap();
        reconcile_optional_mods_post_prepare(&http, game_root, "survival", Some(&mods_url)).await;

        assert_eq!(std::fs::read(inst_dir.join("mods/core.jar")).unwrap(), core_jar);
        assert_eq!(std::fs::read(inst_dir.join("mods/sodium.jar")).unwrap(), sodium_jar);
        assert!(
            !inst_dir.join("mods/minimap.jar").exists()
                && inst_dir.join("mods/minimap.jar-disable").exists(),
            "Non-recommended optional mod extracted from ZIP must be renamed to .jar-disable before JVM launch!"
        );
        assert_eq!(
            std::fs::read(inst_dir.join("config/client.toml")).unwrap(),
            config_v1
        );
        assert_eq!(extract_events.lock().unwrap().len(), 3);

        // --- Launch 2: Up-to-date re-launch (0 ZIP packages re-downloaded!) ---
        hit_counts.lock().unwrap().clear();
        let dist2 = bm
            .fetch_custom_distribution_packaged(&http, Some(&files_url))
            .await
            .unwrap();
        bm.sync_bundle(&downloader, &dist2.items, &dist2.packages, &cb)
            .await
            .unwrap();
        reconcile_optional_mods_post_prepare(&http, game_root, "survival", Some(&mods_url)).await;
        {
            let hits = hit_counts.lock().unwrap();
            assert_eq!(hits.get("/utils/packages/survival/pkg-config-p1-v1.zip").copied().unwrap_or(0), 0);
            assert_eq!(hits.get("/utils/packages/survival/pkg-mods-p1-v1.zip").copied().unwrap_or(0), 0);
            assert_eq!(hits.get("/utils/packages/survival/pkg-mods-optional-p1-v1.zip").copied().unwrap_or(0), 0);
        }

        // --- Launch 3: Server modifies ONLY `config/client.toml` -> ONLY `pkg-config-p1-v2.zip` downloaded! ---
        *active_generation.lock().unwrap() = 2;
        hit_counts.lock().unwrap().clear();
        let dist3 = bm
            .fetch_custom_distribution_packaged(&http, Some(&files_url))
            .await
            .unwrap();
        bm.sync_bundle(&downloader, &dist3.items, &dist3.packages, &cb)
            .await
            .unwrap();
        reconcile_optional_mods_post_prepare(&http, game_root, "survival", Some(&mods_url)).await;
        {
            let hits = hit_counts.lock().unwrap();
            assert_eq!(
                hits.get("/utils/packages/survival/pkg-config-p1-v2.zip").copied().unwrap_or(0),
                1,
                "Modified config ZIP must be downloaded once"
            );
            assert_eq!(
                hits.get("/utils/packages/survival/pkg-mods-p1-v1.zip").copied().unwrap_or(0),
                0,
                "Unchanged mods ZIP must NOT be downloaded"
            );
            assert_eq!(
                hits.get("/utils/packages/survival/pkg-mods-optional-p1-v1.zip").copied().unwrap_or(0),
                0,
                "Unchanged mods-optional ZIP must NOT be downloaded"
            );
        }
        assert_eq!(
            std::fs::read(inst_dir.join("config/client.toml")).unwrap(),
            config_v2
        );
        assert!(inst_dir.join("mods/minimap.jar-disable").exists());

        server.abort();
    }

    #[test]
    fn test_is_private_or_local_host_guard() {
        assert!(is_private_or_local_host(""));
        assert!(is_private_or_local_host("localhost"));
        assert!(is_private_or_local_host("mc.local"));
        assert!(is_private_or_local_host("127.0.0.1"));
        assert!(is_private_or_local_host("10.0.4.12"));
        assert!(is_private_or_local_host("192.168.1.50"));
        assert!(is_private_or_local_host("172.16.0.1"));
        assert!(is_private_or_local_host("172.31.255.254"));
        assert!(is_private_or_local_host("::1"));
        assert!(is_private_or_local_host("[::1]"));

        assert!(!is_private_or_local_host("172.15.0.1"));
        assert!(!is_private_or_local_host("172.32.0.1"));
        assert!(!is_private_or_local_host("play.conflictura.eu"));
        assert!(!is_private_or_local_host("1.1.1.1"));
    }

    #[tokio::test]
    async fn test_bootstrap_memoization_etag_and_included_news_mods() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let api_hits = Arc::new(Mutex::new(0_usize));
        let news_hits = Arc::new(Mutex::new(0_usize));
        let mods_hits = Arc::new(Mutex::new(0_usize));
        let rss_hits = Arc::new(Mutex::new(0_usize));
        let saw_include = Arc::new(Mutex::new(false));
        let saw_if_none_match = Arc::new(Mutex::new(false));

        let api_h = Arc::clone(&api_hits);
        let news_h = Arc::clone(&news_hits);
        let mods_h = Arc::clone(&mods_hits);
        let rss_h = Arc::clone(&rss_hits);
        let inc_h = Arc::clone(&saw_include);
        let inm_h = Arc::clone(&saw_if_none_match);

        let server = tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = vec![0_u8; 8192];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    continue;
                }
                let req = String::from_utf8_lossy(&buf[..n]);
                let first_line = req.lines().next().unwrap_or("");
                let target = first_line.split_whitespace().nth(1).unwrap_or("/");

                if target.starts_with("/utils/api") {
                    *api_h.lock().unwrap() += 1;
                    if target.contains("include=news%2Cmods") || target.contains("include=news,mods") {
                        *inc_h.lock().unwrap() = true;
                    }
                    if req.to_ascii_lowercase().contains("if-none-match: \"v2-etag-1\"") {
                        *inm_h.lock().unwrap() = true;
                        let resp = "HTTP/1.1 304 Not Modified\r\nETag: \"v2-etag-1\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                        let _ = sock.write_all(resp.as_bytes()).await;
                        continue;
                    }
                    let payload = json!({
                        "auth_mode": "both",
                        "news_source": "both",
                        "dataDirectory": "centralcorp",
                        "included_news": [
                            {
                                "title": "Bootstrap News",
                                "content": "<p>Zero extra round-trip</p>",
                                "author": "Admin",
                                "publish_date": "2026-11-18T08:00:00+00:00",
                                "is_pinned": true
                            }
                        ],
                        "included_mods": {
                            "survival": {
                                "optionalMods": ["sodium.jar"],
                                "mods": {
                                    "sodium.jar": {
                                        "name": "Sodium",
                                        "description": "Fast",
                                        "recommended": true
                                    }
                                }
                            }
                        },
                        "instances": [
                            {
                                "slug": "survival",
                                "name": "Survival",
                                "game_version": "1.20.1"
                            }
                        ]
                    });
                    let body = serde_json::to_string(&payload).unwrap();
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nETag: \"v2-etag-1\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                } else if target.starts_with("/utils/news") {
                    *news_h.lock().unwrap() += 1;
                    let body = "[]";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                } else if target.starts_with("/utils/instances/survival/mods") {
                    *mods_h.lock().unwrap() += 1;
                    let body = r#"{"optionalMods":[],"mods":{}}"#;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                } else if target.starts_with("/api/rss") {
                    *rss_h.lock().unwrap() += 1;
                    let body = r#"<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><item><title>RSS Item</title><description>From Azuriom</description></item></channel></rss>"#;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                }
            }
        });

        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let state = LauncherState::with_http_client(http);
        let base = format!("http://{addr}");
        let meta = LauncherMeta {
            name: "centralcorp".to_string(),
            product_name: "CentralCorp".to_string(),
            version: "5.0.0".to_string(),
            env: "panel".to_string(),
            settings_url: base.clone(),
            user_subpath: String::new(),
            platform: "linux".to_string(),
            arch: "x64".to_string(),
            is_dev: false,
            data_root: "/tmp".to_string(),
            repository: None,
        };

        // 1. Splash bootstrap call -> 1 HTTP GET with ?include=news,mods
        let cfg1 = fetch_remote_config_inner(&state, &meta, false).await.unwrap();
        assert!(*saw_include.lock().unwrap());
        assert_eq!(*api_hits.lock().unwrap(), 1);
        assert!(cfg1.get("included_news").is_none());
        assert!(cfg1.get("included_mods").is_none());

        // 2. Main window call right after splash -> 0 extra HTTP GETs!
        let cfg2 = fetch_remote_config_inner(&state, &meta, false).await.unwrap();
        assert_eq!(*api_hits.lock().unwrap(), 1);
        assert_eq!(cfg1, cfg2);

        // 3. Force refresh -> sends If-None-Match and receives 304 Not Modified!
        let cfg3 = fetch_remote_config_inner(&state, &meta, true).await.unwrap();
        assert!(*saw_if_none_match.lock().unwrap());
        assert_eq!(*api_hits.lock().unwrap(), 2);
        assert_eq!(cfg1, cfg3);

        // 4. Panel news -> served from bootstrap cache with 0 HTTP calls!
        let panel_news = fetch_news_inner(&state, &meta, Some("panel"), None, None)
            .await
            .unwrap();
        assert_eq!(panel_news.len(), 1);
        assert_eq!(panel_news[0].title, "Bootstrap News");
        assert_eq!(*news_hits.lock().unwrap(), 0);

        // 5. Merged "both" news -> combines cached Panel news + 1 RSS HTTP call (0 Panel HTTP calls)!
        let both_news = fetch_news_inner(&state, &meta, Some("both"), None, Some(&base))
            .await
            .unwrap();
        assert_eq!(both_news.len(), 2);
        assert_eq!(both_news[0].title, "Bootstrap News");
        assert_eq!(*news_hits.lock().unwrap(), 0);
        assert_eq!(*rss_hits.lock().unwrap(), 1);

        // 6. Optional mods manifest -> served from bootstrap cache with 0 HTTP calls!
        let mods_manifest = get_or_fetch_mods_manifest(
            &state,
            "survival",
            &format!("{base}/utils/instances/survival/mods"),
            5,
        )
        .await
        .unwrap();
        assert_eq!(mods_manifest["optionalMods"][0], "sodium.jar");
        assert_eq!(*mods_hits.lock().unwrap(), 0);

        server.abort();
    }
}

