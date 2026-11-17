use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Frontend state of a single optional mod in `<game_root>/instances/<slug>/mods/`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OptionalModState {
    pub file: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub recommanded: bool,
    pub recommended: bool,
    pub enabled: bool,
    pub installed: bool,
    pub info_missing: bool,
}

#[derive(Debug, Clone, Default)]
pub struct RemoteModMeta {
    pub name: Option<String>,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub recommended: bool,
    pub info_missing: bool,
}

/// Sanitizes an instance slug so it cannot traverse outside `<data_directory>/instances/`.
pub fn sanitize_instance_slug(slug: &str) -> String {
    let trimmed = slug.trim();
    if trimmed.is_empty() {
        return "default".to_string();
    }
    let clean: String = trimmed
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '-',
            _ => c,
        })
        .collect::<String>()
        .trim_matches('.')
        .trim()
        .to_string();

    if clean.is_empty() {
        "default".to_string()
    } else {
        clean
    }
}

/// Sanitizes a mod filename (e.g. `sodium.jar`) ensuring it is a single basename without path separators.
pub fn sanitize_mod_filename(mod_file: &str) -> Result<String, String> {
    let trimmed = mod_file.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || trimmed.contains('\0')
    {
        return Err(format!("Invalid optional mod filename: '{mod_file}'"));
    }

    // Strip any accidental `-disable` or `.disable` suffix so canonical `file` is always `*.jar`
    if let Some(stem) = trimmed.strip_suffix(".jar-disable") {
        return Ok(format!("{stem}.jar"));
    }
    if let Some(stem) = trimmed.strip_suffix(".jar.disable") {
        return Ok(format!("{stem}.jar"));
    }
    Ok(trimmed.to_string())
}

/// Canonical disabled filename using `.jar-disable` (matching `minecraft-rust-core` bundle checker!).
pub fn disabled_mod_filename(canonical_jar: &str) -> String {
    if let Some(stem) = canonical_jar.strip_suffix(".jar") {
        format!("{stem}.jar-disable")
    } else {
        format!("{canonical_jar}-disable")
    }
}

/// Legacy v4 broken disabled filename (`.jar.disable`) migrated automatically to `.jar-disable`.
fn legacy_disabled_mod_filename(canonical_jar: &str) -> String {
    if let Some(stem) = canonical_jar.strip_suffix(".jar") {
        format!("{stem}.jar.disable")
    } else {
        format!("{canonical_jar}.disable")
    }
}

pub fn instance_root_dir(data_directory: &Path, instance_slug: &str) -> PathBuf {
    data_directory
        .join("instances")
        .join(sanitize_instance_slug(instance_slug))
}

fn mods_config_path(instance_dir: &Path) -> PathBuf {
    instance_dir.join("launcher_config").join("mods_config.json")
}

fn read_mods_config(instance_dir: &Path) -> BTreeMap<String, bool> {
    let cfg_path = mods_config_path(instance_dir);
    let Ok(bytes) = fs::read(&cfg_path) else {
        return BTreeMap::new();
    };
    serde_json::from_slice::<BTreeMap<String, bool>>(&bytes).unwrap_or_default()
}

fn write_mods_config(instance_dir: &Path, map: &BTreeMap<String, bool>) -> Result<(), String> {
    let cfg_path = mods_config_path(instance_dir);
    if let Some(parent) = cfg_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create launcher_config directory: {e}"))?;
    }
    let serialized = serde_json::to_vec_pretty(map)
        .map_err(|e| format!("Failed to serialize mods_config.json: {e}"))?;
    fs::write(&cfg_path, serialized)
        .map_err(|e| format!("Failed to write mods_config.json: {e}"))
}

/// Migrates any legacy `*.jar.disable` files in `<instance_dir>/mods` to canonical `*.jar-disable`.
pub fn migrate_legacy_dot_disable_files(mods_dir: &Path) {
    let Ok(entries) = fs::read_dir(mods_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if let Some(stem) = name.strip_suffix(".jar.disable") {
            let new_path = mods_dir.join(format!("{stem}.jar-disable"));
            if !new_path.exists() {
                let _ = fs::rename(&path, &new_path);
            } else {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

/// Parses the backend optional mods manifest JSON (`GET /utils/instances/{slug}/mods` or
/// `GET /api/centralcorp/instances/{slug}/mods`).
pub fn parse_optional_mods_manifest(raw: &Value) -> Vec<(String, RemoteModMeta)> {
    let optional_files: Vec<String> = match raw.get("optionalMods") {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str())
            .filter_map(|s| sanitize_mod_filename(s).ok())
            .collect(),
        Some(Value::Object(map)) => map
            .values()
            .filter_map(|v| v.as_str())
            .filter_map(|s| sanitize_mod_filename(s).ok())
            .collect(),
        _ => Vec::new(),
    };

    let mods_obj = raw.get("mods").and_then(|v| v.as_object());
    let mut results = Vec::with_capacity(optional_files.len());

    for file in optional_files {
        if let Some(info) = mods_obj.and_then(|m| m.get(&file)).and_then(|v| v.as_object()) {
            let name = info
                .get("name")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let description = info
                .get("description")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let icon = info
                .get("icon")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let recommended = info
                .get("recommended")
                .and_then(|v| v.as_bool())
                .or_else(|| info.get("recommanded").and_then(|v| v.as_bool()))
                .unwrap_or(false);

            results.push((
                file,
                RemoteModMeta {
                    name,
                    description,
                    icon,
                    recommended,
                    info_missing: false,
                },
            ));
        } else {
            results.push((
                file,
                RemoteModMeta {
                    name: None,
                    description: None,
                    icon: None,
                    recommended: false,
                    info_missing: true,
                },
            ));
        }
    }

    results
}

/// Reconciles remote optional mod definitions against `<instance_dir>/mods` and `mods_config.json`.
pub fn resolve_optional_mods_state(
    data_directory: &Path,
    instance_slug: &str,
    manifest: &Value,
) -> Result<Vec<OptionalModState>, String> {
    let parsed = parse_optional_mods_manifest(manifest);
    if parsed.is_empty() {
        return Ok(Vec::new());
    }

    let inst_dir = instance_root_dir(data_directory, instance_slug);
    let mods_dir = inst_dir.join("mods");
    migrate_legacy_dot_disable_files(&mods_dir);

    let mut cfg_map = read_mods_config(&inst_dir);
    let mut cfg_dirty = false;
    let mut states = Vec::with_capacity(parsed.len());

    for (file, meta) in parsed {
        let enabled_path = mods_dir.join(&file);
        let disabled_path = mods_dir.join(disabled_mod_filename(&file));

        let has_enabled = enabled_path.exists();
        let has_disabled = disabled_path.exists();
        let installed = has_enabled || has_disabled;

        let desired_enabled = if let Some(&saved) = cfg_map.get(&file) {
            saved
        } else {
            let initial = if has_disabled && !has_enabled {
                false
            } else if has_enabled {
                // Newly downloaded bundle `.jar`: respect `recommended` flag if first-time setup,
                // or default to true when info_missing so manually placed mods aren't unexpectedly disabled
                if meta.info_missing {
                    true
                } else {
                    meta.recommended
                }
            } else {
                meta.recommended
            };
            cfg_map.insert(file.clone(), initial);
            cfg_dirty = true;
            initial
        };

        if installed {
            let _ = apply_mod_file_state(&mods_dir, &file, desired_enabled);
        }

        states.push(OptionalModState {
            file,
            name: meta.name,
            description: meta.description,
            icon: meta.icon,
            recommanded: meta.recommended,
            recommended: meta.recommended,
            enabled: desired_enabled,
            installed,
            info_missing: meta.info_missing,
        });
    }

    if cfg_dirty {
        let _ = write_mods_config(&inst_dir, &cfg_map);
    }

    Ok(states)
}

/// Toggles an optional mod (`*.jar` <-> `*.jar-disable`) and saves `launcher_config/mods_config.json`.
pub fn toggle_optional_mod_on_disk(
    data_directory: &Path,
    instance_slug: &str,
    mod_file: &str,
    enabled: bool,
) -> Result<OptionalModState, String> {
    let canonical = sanitize_mod_filename(mod_file)?;
    let inst_dir = instance_root_dir(data_directory, instance_slug);
    let mods_dir = inst_dir.join("mods");
    migrate_legacy_dot_disable_files(&mods_dir);

    let installed = apply_mod_file_state(&mods_dir, &canonical, enabled)?;

    let mut cfg_map = read_mods_config(&inst_dir);
    cfg_map.insert(canonical.clone(), enabled);
    write_mods_config(&inst_dir, &cfg_map)?;

    Ok(OptionalModState {
        file: canonical,
        name: None,
        description: None,
        icon: None,
        recommanded: false,
        recommended: false,
        enabled,
        installed,
        info_missing: false,
    })
}

/// Synchronizes all optional mods in `<data_directory>/instances/<slug>/mods` with `mods_config.json`
/// right before launching the game.
pub fn sync_optional_mods_on_disk(
    data_directory: &Path,
    instance_slug: &str,
) -> Result<(), String> {
    let inst_dir = instance_root_dir(data_directory, instance_slug);
    let mods_dir = inst_dir.join("mods");
    if !mods_dir.exists() {
        return Ok(());
    }

    migrate_legacy_dot_disable_files(&mods_dir);
    let cfg_map = read_mods_config(&inst_dir);

    for (mod_file, &enabled) in &cfg_map {
        if let Ok(canonical) = sanitize_mod_filename(mod_file) {
            let _ = apply_mod_file_state(&mods_dir, &canonical, enabled);
        }
    }

    Ok(())
}

fn apply_mod_file_state(mods_dir: &Path, canonical_jar: &str, enabled: bool) -> Result<bool, String> {
    let enabled_path = mods_dir.join(canonical_jar);
    let disabled_path = mods_dir.join(disabled_mod_filename(canonical_jar));
    let legacy_path = mods_dir.join(legacy_disabled_mod_filename(canonical_jar));

    if legacy_path.exists() {
        if !disabled_path.exists() {
            let _ = fs::rename(&legacy_path, &disabled_path);
        } else {
            let _ = fs::remove_file(&legacy_path);
        }
    }

    if enabled {
        if disabled_path.exists() {
            if enabled_path.exists() {
                let _ = fs::remove_file(&disabled_path);
            } else {
                fs::rename(&disabled_path, &enabled_path)
                    .map_err(|e| format!("Failed to enable mod '{canonical_jar}': {e}"))?;
            }
        }
        Ok(enabled_path.exists())
    } else {
        if enabled_path.exists() {
            if disabled_path.exists() {
                let _ = fs::remove_file(&enabled_path);
            } else {
                fs::rename(&enabled_path, &disabled_path)
                    .map_err(|e| format!("Failed to disable mod '{canonical_jar}': {e}"))?;
            }
        }
        Ok(disabled_path.exists())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_optional_mods_lifecycle_and_dot_disable_migration() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mods_dir = root.join("instances").join("survival").join("mods");
        fs::create_dir_all(&mods_dir).unwrap();

        // Simulate one active `.jar` and one legacy broken `.jar.disable`
        fs::write(mods_dir.join("sodium.jar"), b"jar-bytes").unwrap();
        fs::write(mods_dir.join("minimap.jar.disable"), b"legacy-disabled").unwrap();

        let manifest = json!({
            "optionalMods": ["sodium.jar", "minimap.jar"],
            "mods": {
                "sodium.jar": {
                    "name": "Sodium",
                    "description": "Renderer optimization",
                    "recommanded": true
                },
                "minimap.jar": {
                    "name": "Xaero Minimap",
                    "description": "HUD minimap",
                    "recommended": false
                }
            }
        });

        let states = resolve_optional_mods_state(root, "survival", &manifest).unwrap();
        assert_eq!(states.len(), 2);
        assert!(states[0].enabled);
        assert!(states[0].installed);
        assert!(!states[1].enabled);
        assert!(states[1].installed);

        // Legacy `.jar.disable` must have been migrated to `.jar-disable`
        assert!(!mods_dir.join("minimap.jar.disable").exists());
        assert!(mods_dir.join("minimap.jar-disable").exists());

        // Disable sodium.jar -> sodium.jar-disable
        let toggled = toggle_optional_mod_on_disk(root, "survival", "sodium.jar", false).unwrap();
        assert!(!toggled.enabled);
        assert!(mods_dir.join("sodium.jar-disable").exists());
        assert!(!mods_dir.join("sodium.jar").exists());

        // Simulate bundle re-downloading sodium.jar and verify pre-launch sync disables it again
        fs::write(mods_dir.join("sodium.jar"), b"fresh-jar").unwrap();
        sync_optional_mods_on_disk(root, "survival").unwrap();
        assert!(!mods_dir.join("sodium.jar").exists());
        assert!(mods_dir.join("sodium.jar-disable").exists());

        // Re-enable minimap.jar
        let reenabled = toggle_optional_mod_on_disk(root, "survival", "minimap.jar", true).unwrap();
        assert!(reenabled.enabled);
        assert!(mods_dir.join("minimap.jar").exists());
        assert!(!mods_dir.join("minimap.jar-disable").exists());
    }

    #[test]
    fn test_path_traversal_rejected() {
        assert!(sanitize_mod_filename("../evil.jar").is_err());
        assert!(sanitize_mod_filename("sub/evil.jar").is_err());
        assert_eq!(sanitize_mod_filename("iris.jar-disable").unwrap(), "iris.jar");
    }
}
