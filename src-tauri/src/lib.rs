pub mod commands;
pub mod meta;
pub mod mods;
pub mod news;
pub mod state;

use tauri::{Manager, WindowEvent};

use crate::meta::is_dev_environment;
use crate::state::LauncherState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(debug_assertions)]
    {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let _ = std::fs::write(dir.join("debug.log"), "=== CentralCorp Debug Session Started ===\n");
            }
        }
    }

    let launcher_state = LauncherState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(main_win) = app.get_webview_window("main") {
                if main_win.is_visible().unwrap_or(false) {
                    let _ = main_win.unminimize();
                    let _ = main_win.set_focus();
                    return;
                }
            }
            if let Some(splash_win) = app.get_webview_window("splash") {
                let _ = splash_win.unminimize();
                let _ = splash_win.set_focus();
            } else if let Some(main_win) = app.get_webview_window("main") {
                let _ = main_win.show();
                let _ = main_win.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(launcher_state)
        .setup(|app| {
            if is_dev_environment() {
                if let Some(main_win) = app.get_webview_window("main") {
                    let _ = main_win.show();
                    let _ = main_win.set_focus();
                    #[cfg(debug_assertions)]
                    {
                        main_win.open_devtools();
                    }
                }
                if let Some(splash_win) = app.get_webview_window("splash") {
                    let _ = splash_win.close();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed)
            {
                let state = window.state::<LauncherState>().inner().clone();
                let is_destroyed = matches!(event, WindowEvent::Destroyed);
                let should_kill_children = state.close_behavior() == "close-all";
                if should_kill_children || is_destroyed {
                    std::thread::spawn(move || {
                        if should_kill_children {
                            state.terminate_child_processes();
                        }
                        if is_destroyed {
                            state.shutdown_discord_rpc();
                        }
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_launcher_meta,
            commands::get_system_memory,
            commands::fetch_remote_config,
            commands::fetch_news,
            commands::ping_minecraft_server,
            commands::auth_azuriom_login,
            commands::auth_azuriom_verify,
            commands::auth_azuriom_logout,
            commands::auth_microsoft_login,
            commands::auth_microsoft_refresh,
            commands::sync_microsoft_panel,
            commands::upload_player_skin,
            commands::set_microsoft_cape,
            commands::list_optional_mods,
            commands::toggle_optional_mod,
            commands::sync_optional_mods,
            commands::launch_instance,
            commands::set_close_behavior,
            commands::set_discord_rpc,
            commands::open_external_url,
            commands::open_main_window,
            commands::check_app_update,
            commands::frontend_debug_log,
            commands::toggle_devtools,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CentralCorp Tauri application");
}
