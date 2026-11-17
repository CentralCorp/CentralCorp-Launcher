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
                let state = window.state::<LauncherState>();
                if state.close_behavior() == "close-all" {
                    state.terminate_child_processes();
                }
                if matches!(event, WindowEvent::Destroyed) {
                    state.shutdown_discord_rpc();
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
            commands::upload_player_skin,
            commands::set_microsoft_cape,
            commands::list_optional_mods,
            commands::toggle_optional_mod,
            commands::sync_optional_mods,
            commands::launch_instance,
            commands::set_discord_rpc,
            commands::open_external_url,
            commands::open_main_window,
            commands::check_app_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CentralCorp Tauri application");
}
