use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use serde::{Deserialize, Serialize};

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
    child_pids: Mutex<HashSet<u32>>,
    close_behavior: Mutex<String>,
    discord_rpc: Mutex<Option<DiscordRpcSession>>,
}

/// Shared Tauri managed state tracking HTTP client, spawned Minecraft Java PIDs,
/// close behavior (`close-launcher`, `close-all`, `open-launcher`), and Discord Rich Presence.
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

        Self {
            inner: Arc::new(LauncherStateInner {
                http,
                child_pids: Mutex::new(HashSet::new()),
                close_behavior: Mutex::new("close-launcher".to_string()),
                discord_rpc: Mutex::new(None),
            }),
        }
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.inner.http
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
            let mut client =
                DiscordIpcClient::new(client_id).map_err(|e| format!("Discord IPC init error: {e}"))?;
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
            if let Err(err) = apply_discord_activity(&mut session.client, &cfg, session.started_at) {
                // Attempt single reconnect if local Discord socket rotated
                let _ = session.client.close();
                session
                    .client
                    .connect()
                    .map_err(|e| format!("Discord IPC reconnect failed ({err}): {e}"))?;
                apply_discord_activity(&mut session.client, &cfg, session.started_at)?;
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

    if !large_image.is_empty() || !small_image.is_empty() {
        let mut assets = activity::Assets::new();
        if !large_image.is_empty() {
            assets = assets.large_image(large_image);
            if !large_text.is_empty() {
                assets = assets.large_text(large_text);
            }
        }
        if !small_image.is_empty() {
            assets = assets.small_image(small_image);
            if !small_text.is_empty() {
                assets = assets.small_text(small_text);
            }
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
