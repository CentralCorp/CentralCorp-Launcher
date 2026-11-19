/**
 * CentralCorp Launcher — Tauri v2 IPC & Window Bridge
 * Provides native Rust IPC invocations and window lifecycle helpers for the WebView renderer.
 */
'use strict';

function getTauri() {
    if (typeof window !== 'undefined' && window.__TAURI__) {
        return window.__TAURI__;
    }
    throw new Error('Tauri runtime API (window.__TAURI__) is not available.');
}

export async function invoke(command, args = {}) {
    return getTauri().core.invoke(command, args);
}

export async function listen(eventName, handler) {
    return getTauri().event.listen(eventName, (event) => {
        handler(event.payload, event);
    });
}

export function getCurrentWindow() {
    return getTauri().window.getCurrentWindow();
}

let cachedMetaPromise = null;

export function getLauncherMeta() {
    if (!cachedMetaPromise) {
        cachedMetaPromise = invoke('get_launcher_meta').catch((err) => {
            cachedMetaPromise = null;
            throw err;
        });
    }
    return cachedMetaPromise;
}

export function resolveGameRoot(meta, dataDirectoryName) {
    const cleanName = String(dataDirectoryName || 'minecraft')
        .replace(/^\.+/, '')
        .replace(/^[/\\]+|[/\\]+$/g, '');
    if (!meta || !meta.data_root) {
        return `.${cleanName}`;
    }
    const root = meta.data_root.replace(/[/\\]+$/, '');
    if (meta.platform === 'darwin') {
        return `${root}/${cleanName}`;
    }
    const sep = meta.platform === 'win32' ? '\\' : '/';
    return `${root}${sep}.${cleanName}`;
}

export async function minimizeWindow() {
    return getCurrentWindow().minimize();
}

export async function toggleMaximizeWindow() {
    const win = getCurrentWindow();
    await win.toggleMaximize();
    return win.isMaximized();
}

export async function closeWindow() {
    return getCurrentWindow().close();
}

export async function hideWindow() {
    return getCurrentWindow().hide();
}

export async function showWindow() {
    return getCurrentWindow().show();
}

let lastProgressPct = null;

export async function setWindowProgress(downloaded, total) {
    try {
        const win = getCurrentWindow();
        if (!total || total <= 0 || Number.isNaN(downloaded) || Number.isNaN(total)) {
            if (lastProgressPct !== -1) {
                lastProgressPct = -1;
                await win.setProgressBar({ status: 'none' });
            }
            return;
        }
        const pct = Math.max(0, Math.min(100, Math.round((downloaded / total) * 100)));
        if (lastProgressPct === pct) return;
        lastProgressPct = pct;
        await win.setProgressBar({ status: 'normal', progress: pct });
    } catch (_) {
        // Ignore on window managers that do not implement taskbar progress
    }
}

export async function resetWindowProgress() {
    try {
        if (lastProgressPct === -1) return;
        lastProgressPct = -1;
        await getCurrentWindow().setProgressBar({ status: 'none' });
    } catch (_) {
        // Ignore on unsupported window managers
    }
}

// ---------------------------------------------------------------------------
// Typed wrappers for all Tauri Rust commands
// ---------------------------------------------------------------------------

export async function getSystemMemory() {
    return invoke('get_system_memory');
}

export async function fetchRemoteConfig(force_refresh = false) {
    return invoke('fetch_remote_config', {
        force_refresh: Boolean(force_refresh),
    });
}

export async function fetchNews({ news_source = null, news_url = null, azauth_url = null } = {}) {
    return invoke('fetch_news', { news_source, news_url, azauth_url });
}

export async function pingMinecraftServer(host, port = 25565) {
    return invoke('ping_minecraft_server', {
        host: String(host || ''),
        port: Number(port) || 25565,
    });
}

export async function authAzuriomLogin(base_url, username, password, two_factor_code = null) {
    return invoke('auth_azuriom_login', {
        base_url,
        username,
        password,
        two_factor_code: two_factor_code || null,
    });
}

export async function authAzuriomVerify(base_url, access_token) {
    return invoke('auth_azuriom_verify', { base_url, access_token });
}

export async function authAzuriomLogout(base_url, access_token) {
    return invoke('auth_azuriom_logout', { base_url, access_token });
}

export async function authMicrosoftLogin(client_id = null, panel_base_url = null) {
    return invoke('auth_microsoft_login', {
        client_id: client_id || null,
        panel_base_url: panel_base_url || null,
    });
}

export async function authMicrosoftRefresh(account, client_id = null, panel_base_url = null) {
    return invoke('auth_microsoft_refresh', {
        account,
        client_id: client_id || null,
        panel_base_url: panel_base_url || null,
    });
}

export async function syncMicrosoftPanel(accountOrOpts, panel_base_url = null) {
    if (accountOrOpts && typeof accountOrOpts === 'object' && 'account' in accountOrOpts) {
        return invoke('sync_microsoft_panel', {
            account: accountOrOpts.account,
            panel_base_url: accountOrOpts.panel_base_url || null,
        });
    }
    return invoke('sync_microsoft_panel', {
        account: accountOrOpts,
        panel_base_url: panel_base_url || null,
    });
}

export async function uploadPlayerSkin(
    accountOrOpts,
    base_url = null,
    png_base64 = '',
    slim = false,
    panel_base_url = null
) {
    if (accountOrOpts && typeof accountOrOpts === 'object' && 'account' in accountOrOpts) {
        return invoke('upload_player_skin', {
            account: accountOrOpts.account,
            base_url: accountOrOpts.base_url || null,
            panel_base_url: accountOrOpts.panel_base_url || null,
            png_base64: accountOrOpts.png_base64,
            slim: Boolean(accountOrOpts.slim),
        });
    }
    return invoke('upload_player_skin', {
        account: accountOrOpts,
        base_url: base_url || null,
        panel_base_url: panel_base_url || null,
        png_base64,
        slim: Boolean(slim),
    });
}

export async function setMicrosoftCape(access_token, cape_id = null) {
    return invoke('set_microsoft_cape', {
        access_token,
        cape_id: cape_id || null,
    });
}

export async function listOptionalMods(data_directory, instance_slug, mods_url) {
    return invoke('list_optional_mods', {
        data_directory,
        instance_slug,
        mods_url: mods_url || '',
    });
}

export async function toggleOptionalMod(data_directory, instance_slug, mod_file, enabled) {
    return invoke('toggle_optional_mod', {
        data_directory,
        instance_slug,
        mod_file,
        enabled: Boolean(enabled),
    });
}

export async function syncOptionalMods(dataDirectoryOrOpts, instance_slug = 'default', mods_url = null) {
    if (
        dataDirectoryOrOpts &&
        typeof dataDirectoryOrOpts === 'object' &&
        'data_directory' in dataDirectoryOrOpts
    ) {
        return invoke('sync_optional_mods', {
            data_directory: dataDirectoryOrOpts.data_directory,
            instance_slug: dataDirectoryOrOpts.instance_slug || 'default',
            mods_url: dataDirectoryOrOpts.mods_url || null,
        });
    }
    return invoke('sync_optional_mods', {
        data_directory: dataDirectoryOrOpts,
        instance_slug,
        mods_url: mods_url || null,
    });
}

export async function launchInstance(options, close_behavior = 'close-launcher', mods_url = null) {
    return invoke('launch_instance', {
        options,
        close_behavior,
        mods_url: mods_url || null,
    });
}

export async function setCloseBehavior(behavior) {
    return invoke('set_close_behavior', {
        behavior: String(behavior || 'close-launcher'),
    });
}

export async function setDiscordRpc(config) {
    return invoke('set_discord_rpc', { config });
}

export async function openExternalUrl(url) {
    if (!url || !/^https?:\/\//i.test(String(url).trim())) {
        console.warn('Blocked invalid external URL:', url);
        return;
    }
    return invoke('open_external_url', { url: String(url).trim() });
}

export async function openMainWindow() {
    return invoke('open_main_window');
}

export async function checkAppUpdate() {
    return invoke('check_app_update');
}
