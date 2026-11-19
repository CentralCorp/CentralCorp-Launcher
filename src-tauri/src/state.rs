use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::mods::sanitize_instance_slug;
use crate::news::NewsItem;

/// TTL for memoized bootstrap configuration (`fetch_remote_config`) and `included_news`.
pub const CONFIG_CACHE_TTL: Duration = Duration::from_secs(45);

/// TTL for memoized per-instance optional mod manifests (`mods_by_instance`).
pub const MODS_CACHE_TTL: Duration = Duration::from_secs(60);

/// Cached remote bootstrap configuration + optional HTTP `ETag`.
#[derive(Debug, Clone)]
pub struct CachedRemoteConfig {
    pub fetched_at: Instant,
    pub etag: Option<String>,
    pub config: Value,
}

/// Configuration payload passed from `launcher.js` to `set_discord_rpc`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RpcConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub details: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub large_image: String,
    #[serde(default)]
    pub large_text: String,
    #[serde(default)]
    pub small_image: String,
    #[serde(default)]
    pub small_text: String,
    #[serde(default)]
    pub button1_label: String,
    #[serde(default)]
    pub button1_url: String,
    #[serde(default)]
    pub button2_label: String,
    #[serde(default)]
    pub button2_url: String,
}

struct DiscordRpcSession {
    client_id: String,
    client: DiscordIpcClient,
    started_at: i64,
}

struct LauncherStateInner {
    http: reqwest::Client,
    remote_config: Mutex<Option<CachedRemoteConfig>>,
    included_news: Mutex<Option<(Instant, Vec<NewsItem>)>>,
    mods_by_instance: Mutex<HashMap<String, (Instant, Value)>>,
    mods_io_lock: tokio::sync::Mutex<()>,
    child_pids: Mutex<HashSet<u32>>,
    close_behavior: Mutex<String>,
    discord_rpc: Mutex<Option<DiscordRpcSession>>,
}

/// Shared Tauri managed state tracking HTTP client, bootstrap caches (`remote_config`,
/// `included_news`, `mods_by_instance`), serialized optional-mods disk I/O, spawned Minecraft
/// Java PIDs, close behavior (`close-launcher`, `close-all`, `open-launcher`), and Discord RPC.
#[derive(Clone)]
pub struct LauncherState {
    inner: Arc<LauncherStateInner>,
}

impl Default for LauncherState {
    fn default() -> Self {
        Self::new()
    }
}

impl LauncherState {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("CentralCorp-Launcher/5.0.0")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        Self::with_http_client(http)
    }

    pub fn with_http_client(http: reqwest::Client) -> Self {
        Self {
            inner: Arc::new(LauncherStateInner {
                http,
                remote_config: Mutex::new(None),
                included_news: Mutex::new(None),
                mods_by_instance: Mutex::new(HashMap::new()),
                mods_io_lock: tokio::sync::Mutex::new(()),
                child_pids: Mutex::new(HashSet::new()),
                close_behavior: Mutex::new("close-launcher".to_string()),
                discord_rpc: Mutex::new(None),
            }),
        }
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.inner.http
    }

    pub fn mods_io_lock(&self) -> &tokio::sync::Mutex<()> {
        &self.inner.mods_io_lock
    }

    /// Returns memoized normalized remote configuration if younger than [`CONFIG_CACHE_TTL`].
    pub fn fresh_remote_config(&self) -> Option<Value> {
        let guard = self.inner.remote_config.lock().ok()?;
        let entry = guard.as_ref()?;
        if entry.fetched_at.elapsed() < CONFIG_CACHE_TTL {
            Some(entry.config.clone())
        } else {
            None
        }
    }

    /// Returns the currently cached remote config entry (even if older than [`CONFIG_CACHE_TTL`])
    /// so conditional `If-None-Match` requests can revalidate without re-downloading unchanged JSON.
    pub fn cached_remote_config_entry(&self) -> Option<CachedRemoteConfig> {
        self.inner.remote_config.lock().ok()?.clone()
    }

    /// Stores a newly fetched normalized remote configuration and optional `ETag`.
    pub fn store_remote_config(&self, etag: Option<String>, config: Value) {
        if let Ok(mut guard) = self.inner.remote_config.lock() {
            *guard = Some(CachedRemoteConfig {
                fetched_at: Instant::now(),
                etag,
                config,
            });
        }
    }

    /// Refreshes timestamps on HTTP `304 Not Modified` and returns the cached configuration.
    pub fn touch_all_cached_bootstrap(&self) -> Option<Value> {
        let now = Instant::now();
        let cfg = if let Ok(mut guard) = self.inner.remote_config.lock() {
            if let Some(entry) = guard.as_mut() {
                entry.fetched_at = now;
                Some(entry.config.clone())
            } else {
                None
            }
        } else {
            None
        };

        if let Ok(mut news_guard) = self.inner.included_news.lock() {
            if let Some((ts, _)) = news_guard.as_mut() {
                *ts = now;
            }
        }

        if let Ok(mut mods_guard) = self.inner.mods_by_instance.lock() {
            for (ts, _) in mods_guard.values_mut() {
                *ts = now;
            }
        }

        cfg
    }

    /// Stores normalized news included in the bootstrap response (or fetched from Panel).
    pub fn store_included_news(&self, items: Vec<NewsItem>) {
        if let Ok(mut guard) = self.inner.included_news.lock() {
            *guard = Some((Instant::now(), items));
        }
    }

    /// Returns fresh bootstrap news if younger than [`CONFIG_CACHE_TTL`].
    pub fn fresh_included_news(&self) -> Option<Vec<NewsItem>> {
        let guard = self.inner.included_news.lock().ok()?;
        let (fetched_at, items) = guard.as_ref()?;
        if fetched_at.elapsed() < CONFIG_CACHE_TTL {
            Some(items.clone())
        } else {
            None
        }
    }

    /// Stores an optional-mods manifest for `instance_slug`.
    pub fn store_instance_mods(&self, instance_slug: &str, manifest: Value) {
        let key = sanitize_instance_slug(instance_slug);
        if let Ok(mut guard) = self.inner.mods_by_instance.lock() {
            guard.insert(key, (Instant::now(), manifest));
        }
    }

    /// Returns a fresh optional-mods manifest for `instance_slug` if younger than [`MODS_CACHE_TTL`].
    pub fn fresh_instance_mods(&self, instance_slug: &str) -> Option<Value> {
        let key = sanitize_instance_slug(instance_slug);
        let guard = self.inner.mods_by_instance.lock().ok()?;
        let (fetched_at, manifest) = guard.get(&key)?;
        if fetched_at.elapsed() < MODS_CACHE_TTL {
            Some(manifest.clone())
        } else {
            None
        }
    }

    pub fn set_close_behavior(&self, behavior: &str) {
        if let Ok(mut guard) = self.inner.close_behavior.lock() {
            let clean = behavior.trim();
            *guard = if clean.is_empty() {
                "close-launcher".to_string()
            } else {
                clean.to_string()
            };
        }
    }

    pub fn close_behavior(&self) -> String {
        self.inner
            .close_behavior
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| "close-launcher".to_string())
    }

    pub fn register_child_pid(&self, pid: u32) {
        if pid == 0 {
            return;
        }
        if let Ok(mut guard) = self.inner.child_pids.lock() {
            guard.insert(pid);
        }
    }

    pub fn remove_child_pid(&self, pid: u32) {
        if let Ok(mut guard) = self.inner.child_pids.lock() {
            guard.remove(&pid);
        }
    }

    /// Terminates all tracked child Java processes (used when `close_behavior == "close-all"`
    /// and the main launcher window is closed).
    pub fn terminate_child_processes(&self) {
        let pids: Vec<u32> = match self.inner.child_pids.lock() {
            Ok(mut guard) => guard.drain().collect(),
            Err(_) => return,
        };

        for pid in pids {
            terminate_pid(pid);
        }
    }

    /// Updates or disconnects Discord Rich Presence synchronously (designed to be called inside
    /// `tokio::task::spawn_blocking`).
    pub fn update_discord_rpc_blocking(&self, cfg: RpcConfig) -> Result<(), String> {
        let mut guard = self
            .inner
            .discord_rpc
            .lock()
            .map_err(|_| "Discord RPC mutex poisoned".to_string())?;

        let client_id = cfg.client_id.trim();
        if !cfg.enabled || client_id.is_empty() {
            if let Some(mut existing) = guard.take() {
                let _ = existing.client.clear_activity();
                let _ = existing.client.close();
            }
            return Ok(());
        }

        let needs_reconnect = match guard.as_ref() {
            Some(existing) => existing.client_id != client_id,
            None => true,
        };

        if needs_reconnect {
            if let Some(mut old) = guard.take() {
                let _ = old.client.close();
            }
            let mut client = DiscordIpcClient::new(client_id)
                .map_err(|e| format!("Discord IPC init error: {e}"))?;
            client
                .connect()
                .map_err(|e| format!("Discord IPC connect error: {e}"))?;
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            *guard = Some(DiscordRpcSession {
                client_id: client_id.to_string(),
                client,
                started_at: now,
            });
        }

        if let Some(session) = guard.as_mut() {
            if let Err(err) = apply_discord_activity(&mut session.client, &cfg, session.started_at)
            {
                // Attempt single reconnect if local Discord socket rotated; reset session on failure
                let _ = session.client.close();
                if let Err(reconnect_err) = session.client.connect() {
                    *guard = None;
                    return Err(format!(
                        "Discord IPC reconnect failed ({err}): {reconnect_err}"
                    ));
                }
                if let Err(retry_err) =
                    apply_discord_activity(&mut session.client, &cfg, session.started_at)
                {
                    let _ = session.client.close();
                    *guard = None;
                    return Err(retry_err);
                }
            }
        }

        Ok(())
    }

    pub fn shutdown_discord_rpc(&self) {
        if let Ok(mut guard) = self.inner.discord_rpc.lock() {
            if let Some(mut session) = guard.take() {
                let _ = session.client.clear_activity();
                let _ = session.client.close();
            }
        }
    }
}

fn is_valid_http_url(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }
    match url::Url::parse(trimmed) {
        Ok(u) => u.scheme() == "http" || u.scheme() == "https",
        Err(_) => false,
    }
}

fn apply_discord_activity(
    client: &mut DiscordIpcClient,
    cfg: &RpcConfig,
    started_at: i64,
) -> Result<(), String> {
    let details = cfg.details.trim();
    let state = cfg.state.trim();
    let large_image = cfg.large_image.trim();
    let large_text = cfg.large_text.trim();
    let small_image = cfg.small_image.trim();
    let small_text = cfg.small_text.trim();
    let b1_label = cfg.button1_label.trim();
    let b1_url = cfg.button1_url.trim();
    let b2_label = cfg.button2_label.trim();
    let b2_url = cfg.button2_url.trim();

    let mut act = activity::Activity::new();
    if !details.is_empty() {
        act = act.details(details);
    }
    if !state.is_empty() {
        act = act.state(state);
    }
    if started_at > 0 {
        act = act.timestamps(activity::Timestamps::new().start(started_at));
    }

    let has_large = !large_image.is_empty() || !large_text.is_empty();
    let has_small = !small_image.is_empty() || !small_text.is_empty();
    if has_large || has_small {
        let mut assets = activity::Assets::new();
        if !large_image.is_empty() {
            assets = assets.large_image(large_image);
        }
        if !large_text.is_empty() {
            assets = assets.large_text(large_text);
        }
        if !small_image.is_empty() {
            assets = assets.small_image(small_image);
        }
        if !small_text.is_empty() {
            assets = assets.small_text(small_text);
        }
        act = act.assets(assets);
    }

    let mut buttons = Vec::new();
    if !b1_label.is_empty() && is_valid_http_url(b1_url) {
        buttons.push(activity::Button::new(b1_label, b1_url));
    }
    if !b2_label.is_empty() && is_valid_http_url(b2_url) {
        buttons.push(activity::Button::new(b2_label, b2_url));
    }
    if !buttons.is_empty() {
        act = act.buttons(buttons);
    }

    client
        .set_activity(act)
        .map_err(|e| format!("Failed to set Discord activity: {e}"))
}

fn terminate_pid(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
}
