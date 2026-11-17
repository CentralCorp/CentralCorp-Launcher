use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Embedded `package.json` preserving historic CentralCorp admin configuration fields.
pub const EMBEDDED_PACKAGE_JSON: &str = include_str!("../../package.json");

/// Runtime launcher metadata replacing Node `require('../package.json')`, `os.platform()`, and `process.env`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherMeta {
    pub name: String,
    pub product_name: String,
    pub version: String,
    pub env: String,
    pub settings_url: String,
    pub user_subpath: String,
    pub platform: String,
    pub arch: String,
    pub is_dev: bool,
    pub data_root: String,
    pub repository: Option<String>,
}

/// System RAM totals in GiB rounded to `0.5` GB steps.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct SystemMemoryInfo {
    pub total_gb: f64,
    pub free_gb: f64,
}

/// Result of checking GitHub Releases for a newer launcher version.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppUpdateInfo {
    pub update_available: bool,
    pub version: Option<String>,
    pub download_url: Option<String>,
}

/// Normalizes Rust `std::env::consts::OS` to Node-compatible platform identifiers (`win32`, `darwin`, `linux`).
pub fn normalized_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/// Normalizes Rust `std::env::consts::ARCH` to Node-compatible architecture identifiers (`x64`, `arm64`, `ia32`).
pub fn normalized_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    }
}

/// Computes the base OS directory under which game directories live:
/// - Windows: `%APPDATA%` (so `resolveGameRoot` yields `%APPDATA%\.<dir>`)
/// - macOS: `~/Library/Application Support` (so `resolveGameRoot` yields `~/Library/Application Support/<dir>`)
/// - Linux: `$HOME` (so `resolveGameRoot` yields `~/.<dir>`)
pub fn default_os_data_root() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            if !appdata.trim().is_empty() {
                return PathBuf::from(appdata);
            }
        }
        return dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    }

    #[cfg(target_os = "macos")]
    {
        return dirs::data_dir().unwrap_or_else(|| {
            dirs::home_dir()
                .map(|h| h.join("Library").join("Application Support"))
                .unwrap_or_else(|| PathBuf::from("."))
        });
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
    }
}

pub fn is_dev_environment() -> bool {
    std::env::var("NODE_ENV")
        .ok()
        .map(|v| v.eq_ignore_ascii_case("dev") || v.eq_ignore_ascii_case("development"))
        .unwrap_or(false)
        || std::env::var("TAURI_ENV_DEBUG")
            .ok()
            .map(|v| v.eq_ignore_ascii_case("true") || v == "1")
            .unwrap_or(false)
}

/// Parses embedded `package.json` and merges OS/runtime paths into [`LauncherMeta`].
pub fn read_launcher_meta() -> Result<LauncherMeta, String> {
    parse_launcher_meta_from_str(EMBEDDED_PACKAGE_JSON)
}

pub fn parse_launcher_meta_from_str(pkg_json: &str) -> Result<LauncherMeta, String> {
    let raw: Value =
        serde_json::from_str(pkg_json).map_err(|e| format!("Invalid package.json: {e}"))?;

    let name = raw
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("centralcorp")
        .trim()
        .to_string();

    let product_name = raw
        .get("productName")
        .or_else(|| raw.get("preductname"))
        .and_then(|v| v.as_str())
        .unwrap_or("CentralCorp Launcher")
        .trim()
        .to_string();

    let version = raw
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("5.0.0")
        .trim()
        .to_string();

    let env = raw
        .get("env")
        .and_then(|v| v.as_str())
        .unwrap_or("panel")
        .trim()
        .to_lowercase();

    let settings_url = raw
        .get("settings")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();

    let user_subpath = raw
        .get("user")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .trim_matches('/')
        .to_string();

    let repository = match raw.get("repository") {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(Value::Object(obj)) => obj
            .get("url")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        _ => None,
    };

    let base_settings = if user_subpath.is_empty() || env == "azuriom" {
        settings_url
    } else {
        format!("{}/{}", settings_url.trim_end_matches('/'), user_subpath)
    };

    Ok(LauncherMeta {
        name,
        product_name,
        version,
        env,
        settings_url: base_settings,
        user_subpath,
        platform: normalized_platform().to_string(),
        arch: normalized_arch().to_string(),
        is_dev: is_dev_environment(),
        data_root: default_os_data_root().to_string_lossy().into_owned(),
        repository,
    })
}

/// Resolves the primary configuration endpoint (`/api/centralcorp/options` for Azuriom plugin,
/// `/utils/api` for CentralPanel).
pub fn resolve_remote_config_url(meta: &LauncherMeta) -> Result<String, String> {
    let base = meta.settings_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("Launcher 'settings' URL in package.json is empty".to_string());
    }
    let parsed = url::Url::parse(base).map_err(|e| format!("Invalid settings URL '{base}': {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(format!("Unsupported URL scheme '{}'", parsed.scheme()));
    }

    if meta.env == "azuriom" {
        Ok(format!("{base}/api/centralcorp/options"))
    } else {
        Ok(format!("{base}/utils/api"))
    }
}

/// Converts a JSON value that might be a JSON array, a PHP associative object (`{"0":"a","2":"b"}`),
/// or null into a clean `Vec<Value>`.
fn value_to_vec(val: Option<&Value>) -> Vec<Value> {
    match val {
        Some(Value::Array(arr)) => arr.clone(),
        Some(Value::Object(map)) => map.values().cloned().collect(),
        _ => Vec::new(),
    }
}

/// Normalizes the remote backend configuration JSON so:
/// 1. `auth_mode` always defaults cleanly (`"azuriom"` | `"microsoft"` | `"both"`).
/// 2. `dataDirectory` is always populated.
/// 3. `instances` is ALWAYS a non-empty array of normalized `InstancePayload` objects (synthesizing
///    a `default` instance from top-level fields if connected to a legacy v1 backend).
pub fn normalize_remote_config(mut raw: Value, meta: &LauncherMeta) -> Result<Value, String> {
    let obj = raw
        .as_object_mut()
        .ok_or_else(|| "Backend configuration response is not a JSON object".to_string())?;

    let base = meta.settings_url.trim().trim_end_matches('/');

    // 1. Normalize `auth_mode`
    let inferred_auth_mode = match obj.get("auth_mode").and_then(|v| v.as_str()) {
        Some(mode)
            if matches!(
                mode.trim().to_ascii_lowercase().as_str(),
                "azuriom" | "microsoft" | "both"
            ) =>
        {
            mode.trim().to_ascii_lowercase()
        }
        _ => {
            if meta.env == "azuriom" {
                "azuriom".to_string()
            } else {
                let ms = obj
                    .get("microsoft_auth")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let az = obj
                    .get("azuriom_auth")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                match (az, ms) {
                    (true, true) => "both".to_string(),
                    (false, true) => "microsoft".to_string(),
                    _ => "azuriom".to_string(),
                }
            }
        }
    };
    obj.insert("auth_mode".to_string(), Value::String(inferred_auth_mode));

    // 2. Ensure `dataDirectory` exists
    let has_data_dir = obj
        .get("dataDirectory")
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if !has_data_dir {
        let fallback_dir = if meta.name.trim().is_empty() {
            "centralcorp".to_string()
        } else {
            meta.name.trim().to_string()
        };
        obj.insert("dataDirectory".to_string(), Value::String(fallback_dir));
    }

    // Normalize top-level array fields in case a legacy PHP backend returned associative objects
    for key in [
        "ignored",
        "whitelist",
        "whitelist_roles",
        "maintenance_bypass_roles",
        "maintenance_bypass_users",
    ] {
        if obj.contains_key(key) {
            let arr = value_to_vec(obj.get(key));
            obj.insert(key.to_string(), Value::Array(arr));
        }
    }

    // 3. Normalize or synthesize `instances[]`
    let existing_instances = match obj.get("instances") {
        Some(Value::Array(arr)) if !arr.is_empty() => Some(arr.clone()),
        _ => None,
    };

    let normalized_instances = if let Some(list) = existing_instances {
        list.into_iter()
            .enumerate()
            .map(|(idx, item)| normalize_instance_entry(item, idx, obj, base, &meta.env))
            .collect::<Vec<Value>>()
    } else {
        vec![synthesize_default_instance(obj, base, &meta.env)]
    };

    obj.insert("instances".to_string(), Value::Array(normalized_instances));

    Ok(raw)
}

fn synthesize_default_instance(
    top: &serde_json::Map<String, Value>,
    base_url: &str,
    env: &str,
) -> Value {
    let default_name = top
        .get("status")
        .and_then(|s| s.get("nameServer"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            top.get("name")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or("Default");

    let files_url = if env == "azuriom" {
        format!("{base_url}/api/centralcorp/files")
    } else {
        format!("{base_url}/data")
    };
    let mods_url = if env == "azuriom" {
        format!("{base_url}/api/centralcorp/mods")
    } else {
        format!("{base_url}/utils/mods")
    };

    json!({
        "id": 1,
        "slug": "default",
        "name": default_name,
        "description": "",
        "icon": top.get("server_icon").cloned().unwrap_or(Value::Null),
        "background": top.get("role_background").and_then(|b| b.get("default")).cloned().unwrap_or(Value::Null),
        "is_default": true,
        "position": 0,
        "maintenance": false,
        "maintenance_message": top.get("maintenance_message").cloned().unwrap_or(Value::Null),
        "maintenance_bypass_roles": value_to_vec(top.get("maintenance_bypass_roles")),
        "maintenance_bypass_users": value_to_vec(top.get("maintenance_bypass_users")),
        "game_version": top.get("game_version").and_then(|v| v.as_str()).unwrap_or("1.20.1"),
        "verify": top.get("verify").and_then(|v| v.as_bool()).unwrap_or(true),
        "modde": top.get("modde").and_then(|v| v.as_bool()).unwrap_or(true),
        "java": top.get("java").and_then(|v| v.as_bool()).unwrap_or(true),
        "java_version": top.get("java_version").cloned().unwrap_or(Value::Null),
        "jvm_args": value_to_vec(top.get("jvm_args")),
        "game_args": value_to_vec(top.get("game_args")),
        "auto_connect": top.get("auto_connect").and_then(|v| v.as_bool()).unwrap_or(false),
        "ram_min": top.get("ram_min").cloned().unwrap_or_else(|| json!(2)),
        "ram_max": top.get("ram_max").cloned().unwrap_or_else(|| json!(4)),
        "status": top.get("status").cloned().unwrap_or_else(|| json!({})),
        "server_icon": top.get("server_icon").cloned().unwrap_or(Value::Null),
        "loader": top.get("loader").cloned().unwrap_or_else(|| json!({
            "type": "forge",
            "build": "latest",
            "enable": false
        })),
        "whitelist_activate": top.get("whitelist_activate").and_then(|v| v.as_bool()).unwrap_or(false),
        "whitelist": value_to_vec(top.get("whitelist")),
        "whitelist_roles": value_to_vec(top.get("whitelist_roles")),
        "ignored": value_to_vec(top.get("ignored")),
        "files_url": files_url,
        "mods_url": mods_url,
    })
}

fn normalize_instance_entry(
    mut entry: Value,
    idx: usize,
    top: &serde_json::Map<String, Value>,
    base_url: &str,
    env: &str,
) -> Value {
    let Some(map) = entry.as_object_mut() else {
        return synthesize_default_instance(top, base_url, env);
    };

    let slug = map
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
    map.insert("slug".to_string(), Value::String(slug.clone()));

    let has_name = map
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if !has_name {
        map.insert("name".to_string(), Value::String(slug.clone()));
    }

    for arr_key in [
        "ignored",
        "whitelist",
        "whitelist_roles",
        "maintenance_bypass_roles",
        "maintenance_bypass_users",
        "jvm_args",
        "game_args",
    ] {
        let arr = value_to_vec(map.get(arr_key));
        map.insert(arr_key.to_string(), Value::Array(arr));
    }

    let has_files_url = map
        .get("files_url")
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if !has_files_url && !base_url.is_empty() {
        let fallback_files = if env == "azuriom" {
            format!("{base_url}/api/centralcorp/instances/{slug}/files")
        } else {
            format!("{base_url}/utils/instances/{slug}/files")
        };
        map.insert("files_url".to_string(), Value::String(fallback_files));
    }

    let has_mods_url = map
        .get("mods_url")
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if !has_mods_url && !base_url.is_empty() {
        let fallback_mods = if env == "azuriom" {
            format!("{base_url}/api/centralcorp/instances/{slug}/mods")
        } else {
            format!("{base_url}/utils/instances/{slug}/mods")
        };
        map.insert("mods_url".to_string(), Value::String(fallback_mods));
    }

    entry
}

/// Rounds byte counts to GiB in `0.5` GB increments.
pub fn round_bytes_to_half_gb(bytes: u64) -> f64 {
    let gb = (bytes as f64) / 1_073_741_824.0;
    ((gb * 2.0).round() / 2.0).max(0.5)
}

/// Extracts `(owner, repo)` from a GitHub repository URL (`git+https://github.com/Owner/Repo.git`, etc.).
pub fn parse_github_owner_repo(repo_url: &str) -> Option<(String, String)> {
    let cleaned = repo_url
        .trim()
        .trim_start_matches("git+")
        .trim_end_matches('/')
        .trim_end_matches(".git");

    if let Ok(parsed) = url::Url::parse(cleaned) {
        if parsed
            .host_str()
            .map(|h| h.eq_ignore_ascii_case("github.com"))
            .unwrap_or(false)
        {
            let segments: Vec<&str> = parsed
                .path_segments()
                .map(|s| s.filter(|seg| !seg.is_empty()).collect())
                .unwrap_or_default();
            if segments.len() >= 2 {
                return Some((segments[0].to_string(), segments[1].to_string()));
            }
        }
    }
    None
}

/// Evaluates a GitHub `/releases/latest` JSON payload against `current_version`.
pub fn evaluate_github_release(
    release_json: &Value,
    current_version_str: &str,
    platform: &str,
) -> AppUpdateInfo {
    let tag_raw = match release_json.get("tag_name").and_then(|v| v.as_str()) {
        Some(t) if !t.trim().is_empty() => t.trim().trim_start_matches(['v', 'V']),
        _ => {
            return AppUpdateInfo {
                update_available: false,
                version: None,
                download_url: None,
            }
        }
    };

    let Ok(latest_ver) = semver::Version::parse(tag_raw) else {
        return AppUpdateInfo {
            update_available: false,
            version: None,
            download_url: None,
        };
    };

    let current_clean = current_version_str.trim().trim_start_matches(['v', 'V']);
    let Ok(current_ver) = semver::Version::parse(current_clean) else {
        return AppUpdateInfo {
            update_available: false,
            version: Some(latest_ver.to_string()),
            download_url: None,
        };
    };

    if latest_ver <= current_ver {
        return AppUpdateInfo {
            update_available: false,
            version: Some(latest_ver.to_string()),
            download_url: None,
        };
    }

    let html_url = release_json
        .get("html_url")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    let asset_url = release_json
        .get("assets")
        .and_then(|v| v.as_array())
        .and_then(|assets| pick_platform_asset(assets, platform));

    AppUpdateInfo {
        update_available: true,
        version: Some(latest_ver.to_string()),
        download_url: asset_url.or(html_url),
    }
}

fn pick_platform_asset(assets: &[Value], platform: &str) -> Option<String> {
    let exts: &[&str] = match platform {
        "win32" => &[".msi", "-setup.exe", ".exe"],
        "darwin" => &[".dmg", ".app.tar.gz"],
        _ => &[".appimage", ".deb", ".rpm"],
    };

    for ext in exts {
        for asset in assets {
            let name = asset
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            // Skip updater signature files (`.sig`)
            if name.ends_with(".sig") {
                continue;
            }
            if name.ends_with(ext) {
                if let Some(url) = asset
                    .get("browser_download_url")
                    .and_then(|v| v.as_str())
                    .filter(|u| !u.trim().is_empty())
                {
                    return Some(url.to_string());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_embedded_package_json_parses() {
        let meta = read_launcher_meta().expect("embedded package.json should parse");
        assert_eq!(meta.version, "5.0.0");
        assert!(!meta.settings_url.is_empty());
        assert!(matches!(meta.platform.as_str(), "win32" | "darwin" | "linux"));
    }

    #[test]
    fn test_normalize_legacy_config_synthesizes_default_instance() {
        let meta = parse_launcher_meta_from_str(
            r#"{
                "name": "conflictura",
                "version": "5.0.0",
                "env": "azuriom",
                "settings": "https://conflictura.eu",
                "user": ""
            }"#,
        )
        .unwrap();

        let legacy_raw = json!({
            "game_version": "1.20.1",
            "modde": true,
            "verify": true,
            "ram_min": 3,
            "ram_max": 6,
            "status": { "nameServer": "Conflictura", "ip": "play.conflictura.eu", "port": 25565 },
            "loader": { "type": "forge", "build": "1.20.1-47.3.0", "enable": true },
            "ignored": { "0": "options.txt", "2": "shaderpacks" }
        });

        let normalized = normalize_remote_config(legacy_raw, &meta).unwrap();
        assert_eq!(normalized["auth_mode"], "azuriom");
        assert_eq!(normalized["dataDirectory"], "conflictura");

        let instances = normalized["instances"].as_array().unwrap();
        assert_eq!(instances.len(), 1);
        assert_eq!(instances[0]["slug"], "default");
        assert_eq!(instances[0]["name"], "Conflictura");
        assert_eq!(instances[0]["game_version"], "1.20.1");
        assert_eq!(
            instances[0]["files_url"],
            "https://conflictura.eu/api/centralcorp/files"
        );
        assert_eq!(instances[0]["ignored"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn test_github_release_semver_comparison() {
        assert_eq!(
            parse_github_owner_repo("git+https://github.com/CentralCorp/CentralCorp-Launcher.git"),
            Some((
                "CentralCorp".to_string(),
                "CentralCorp-Launcher".to_string()
            ))
        );

        let release = json!({
            "tag_name": "v5.1.0",
            "html_url": "https://github.com/CentralCorp/CentralCorp-Launcher/releases/tag/v5.1.0",
            "assets": [
                {
                    "name": "Conflictura_5.1.0_amd64.AppImage.sig",
                    "browser_download_url": "https://example.com/app.AppImage.sig"
                },
                {
                    "name": "Conflictura_5.1.0_amd64.AppImage",
                    "browser_download_url": "https://example.com/app.AppImage"
                }
            ]
        });

        let up = evaluate_github_release(&release, "5.0.0", "linux");
        assert!(up.update_available);
        assert_eq!(up.version.as_deref(), Some("5.1.0"));
        assert_eq!(
            up.download_url.as_deref(),
            Some("https://example.com/app.AppImage")
        );

        let same = evaluate_github_release(&release, "5.1.0", "linux");
        assert!(!same.update_available);
    }
}
