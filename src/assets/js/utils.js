/**
 * @author Luuxis
 * Licensed under CC BY-NC 4.0
 * https://creativecommons.org/licenses/by-nc/4.0/
 *
 * Edited by CentralCorp Team
 */
import config from './utils/config.js';
import database from './utils/database.js';
import logger from './utils/logger.js';
import slider from './utils/slider.js';
import {
    authMicrosoftRefresh,
    resolveGameRoot,
    listOptionalMods,
    toggleOptionalMod,
    syncOptionalMods,
} from './utils/tauri-bridge.js';
import {
    renderMinecraftHeadDataUrl,
    resolveAccountAvatarUrl,
} from './utils/skin-renderer.js';

const DEFAULT_AVATAR = './assets/images/default/setve.png';
const DEFAULT_BG = './assets/images/background/light.jpg';
const SUPPORTED_LANGS = ['fr', 'en', 'es', 'de', 'ru'];

const ALLOWED_HTML_TAGS = new Set([
    'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins',
    'mark', 'small', 'sub', 'sup', 'ul', 'ol', 'li', 'h1', 'h2', 'h3',
    'h4', 'h5', 'h6', 'blockquote', 'code', 'pre', 'span', 'div', 'a',
    'img', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);

const DROP_SUBTREE_TAGS = new Set([
    'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed',
    'applet', 'form', 'input', 'button', 'textarea', 'select', 'meta',
    'link', 'base', 'svg', 'math', 'template', 'noscript',
]);

let translations = {};
let translationsPromise = null;

export function initTranslations() {
    if (!translationsPromise) {
        translationsPromise = (async () => {
            const rawLang = (navigator.language || 'en').split('-')[0].toLowerCase();
            const lang = SUPPORTED_LANGS.includes(rawLang) ? rawLang : 'en';
            try {
                const res = await fetch(`./assets/translations/${lang}.json`);
                if (res.ok) {
                    translations = await res.json();
                    return translations;
                }
            } catch (_) {
                // Fall back to English below
            }
            try {
                const fallback = await fetch('./assets/translations/en.json');
                if (fallback.ok) {
                    translations = await fallback.json();
                }
            } catch (err) {
                console.error('Failed to load fallback translations:', err);
            }
            return translations;
        })();
    }
    return translationsPromise;
}

// Kick off asynchronous translation loading immediately
initTranslations();

function t(key) {
    return translations[key] || key;
}

export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
}

/**
 * Strips all HTML tags cleanly via DOMParser and collapses whitespace for plain-text UI surfaces
 * (tooltips, maintenance notices, splash status).
 */
export function stripHtmlToText(dirty) {
    if (!dirty) return '';
    const str = String(dirty);
    if (!str.includes('<') && !str.includes('&')) {
        return str.trim();
    }
    try {
        const doc = new DOMParser().parseFromString(str, 'text/html');
        return (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (_) {
        return str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }
}

/**
 * Sanitizes untrusted rich HTML (news articles, alert banners) via DOMParser + strict tag/URL allowlist.
 */
export function sanitizeHtml(dirty) {
    if (!dirty) return '';
    const raw = String(dirty);
    try {
        const doc = new DOMParser().parseFromString(raw, 'text/html');
        const sanitizeNode = (node) => {
            const children = Array.from(node.childNodes);
            for (const child of children) {
                if (child.nodeType === Node.COMMENT_NODE) {
                    child.remove();
                    continue;
                }
                if (child.nodeType !== Node.ELEMENT_NODE) {
                    continue;
                }

                const tag = child.tagName.toLowerCase();
                if (DROP_SUBTREE_TAGS.has(tag)) {
                    child.remove();
                    continue;
                }

                sanitizeNode(child);

                if (!ALLOWED_HTML_TAGS.has(tag)) {
                    // Unwrap unknown formatting tags while preserving their sanitized text/children
                    const frag = doc.createDocumentFragment();
                    while (child.firstChild) {
                        frag.appendChild(child.firstChild);
                    }
                    child.replaceWith(frag);
                    continue;
                }

                const attrs = Array.from(child.attributes);
                for (const attr of attrs) {
                    const name = attr.name.toLowerCase();
                    const val = attr.value.trim();

                    if (tag === 'a' && name === 'href' && /^https?:\/\//i.test(val)) {
                        child.setAttribute('href', val);
                        child.setAttribute('rel', 'noopener noreferrer');
                        continue;
                    }
                    if (
                        tag === 'img' &&
                        name === 'src' &&
                        (/^https?:\/\//i.test(val) ||
                            /^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(val))
                    ) {
                        child.setAttribute('src', val);
                        continue;
                    }
                    if ((tag === 'a' || tag === 'img') && (name === 'title' || name === 'alt')) {
                        continue;
                    }
                    child.removeAttribute(attr.name);
                }

                if (tag === 'img') {
                    if (!child.getAttribute('src')) {
                        child.remove();
                    } else {
                        child.setAttribute('loading', 'lazy');
                        child.setAttribute('decoding', 'async');
                    }
                }
            }
        };

        sanitizeNode(doc.body);
        return doc.body.innerHTML;
    } catch (_) {
        return escapeHtml(raw);
    }
}

function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function darkenColor(hex, amount) {
    const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - amount);
    const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - amount);
    const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - amount);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

export function applyAccentColor(cfg) {
    if (cfg?.accent_color && /^#[0-9a-fA-F]{6}$/.test(cfg.accent_color)) {
        const root = document.documentElement;
        const color = cfg.accent_color;
        root.style.setProperty('--accent-color', color);
        root.style.setProperty('--accent-color-dark', darkenColor(color, 15));
        root.style.setProperty('--accent-color-glow', hexToRgba(color, 0.4));
        root.style.setProperty('--accent-color-subtle', hexToRgba(color, 0.15));
        root.style.setProperty('--border-accent', hexToRgba(color, 0.3));
    }
}

function changePanel(id) {
    const panel = document.querySelector(`.${id}`);
    const active = document.querySelector('.panel.active') || document.querySelector('.active');
    if (active) active.classList.remove('active');
    if (panel) panel.classList.add('active');
    window.dispatchEvent(new CustomEvent('panel-changed', { detail: { panel: id } }));
}

export function normalizeAccount(raw) {
    if (!raw) return null;
    const rawInfo = { ...(raw.user_info || {}) };
    const moneyVal = Number(rawInfo.money ?? rawInfo.monnaie ?? rawInfo.points ?? 0) || 0;
    const verifiedVal = rawInfo.verified ?? rawInfo.email_verified ?? true;
    delete rawInfo.monnaie;
    delete rawInfo.points;
    delete rawInfo.email_verified;

    const rawMeta = { ...(raw.meta || {}) };
    const typeRaw = String(rawMeta.type || rawMeta.account_type || 'AZauth');
    const normalizedType = typeRaw.toLowerCase() === 'microsoft' ? 'Microsoft' : 'AZauth';
    delete rawMeta.account_type;

    const rest = { ...raw };
    const xboxVal = rest.xbox || rest.xboxAccount || undefined;
    delete rest.xboxAccount;

    return {
        ...rest,
        ...(xboxVal ? { xbox: xboxVal } : {}),
        client_token: raw.client_token || raw.uuid,
        user_properties: raw.user_properties || '{}',
        meta: {
            ...rawMeta,
            online: Boolean(rawMeta.online ?? (normalizedType === 'Microsoft')),
            type: normalizedType,
            offline: rawMeta.offline ?? (normalizedType !== 'Microsoft'),
        },
        user_info: {
            ...rawInfo,
            role: rawInfo.role || null,
            money: moneyVal,
            verified: Boolean(verifiedVal),
            banned: Boolean(rawInfo.banned),
            maintenance_bypass: Boolean(rawInfo.maintenance_bypass),
        },
    };
}

/**
 * Distinguishes permanent Azuriom authentication/ban errors from transient network/timeout/5xx errors
 * so saved sessions are never wiped when a player boots offline or during brief server blips.
 */
export function isPermanentAzuriomAuthError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return (
        msg.includes('invalid_token') ||
        msg.includes('invalid token') ||
        msg.includes('invalid_credentials') ||
        msg.includes('invalid credentials') ||
        msg.includes('token expired') ||
        msg.includes('expired token') ||
        msg.includes('unauthorized') ||
        msg.includes('unauthenticated') ||
        msg.includes('user_banned') ||
        msg.includes('banned') ||
        /\b(401|403)\b/.test(msg)
    );
}

/**
 * Ensures a Microsoft account has a non-expiring access token (> 2 min remaining) right before
 * launching Minecraft, uploading a skin, or changing capes.
 */
export async function ensureFreshMicrosoftAccount(account, cfg, meta, db) {
    if (!account || account.meta?.type !== 'Microsoft') {
        return account;
    }
    const expiresAt = Number(account.expires_at || 0);
    const nowSec = Math.floor(Date.now() / 1000);
    if (expiresAt > nowSec + 120) {
        return account;
    }

    const panelBaseUrl =
        meta && meta.env !== 'azuriom' ? await config.getPanelBaseUrl() : null;
    const refreshedRaw = await authMicrosoftRefresh(
        account,
        cfg?.client_id || null,
        panelBaseUrl
    );
    const refreshed = normalizeAccount(refreshedRaw);
    if (db && refreshed?.uuid) {
        await db.update(refreshed, 'accounts');
    }
    return refreshed;
}

async function resolveAzAuthBase() {
    try {
        return await config.getAzAuthUrl();
    } catch (_) {
        return '';
    }
}

async function addAccount(rawAccount) {
    const data = normalizeAccount(rawAccount);
    if (!data) return;

    const accountsContainer = document.querySelector('.accounts');
    if (!accountsContainer) return;

    const azauth = await resolveAzAuthBase();
    const avatarUrl = await resolveAccountAvatarUrl(data, azauth);
    const isMicrosoft = data.meta?.type === 'Microsoft';
    const providerLabel = isMicrosoft ? t('account_type_microsoft') : t('account_type_azuriom');

    let div = document.getElementById(data.uuid);
    if (!div) {
        div = document.createElement('div');
        div.classList.add('account');
        div.id = data.uuid;
        accountsContainer.appendChild(div);
    }
    div.dataset.accountType = data.meta?.type || 'AZauth';

    div.innerHTML = `
        <img class="account-image" decoding="async" alt="">
        <div class="account-info-col">
            <div class="account-name"></div>
            <div class="account-uuid"><span class="account-provider-badge ${isMicrosoft ? 'ms' : 'az'}"></span> <span class="account-uuid-text"></span></div>
        </div>
        <div class="account-delete"><div class="icon-account-delete icon-account-delete-btn"></div></div>
    `;

    const imgEl = div.querySelector('.account-image');
    const nameEl = div.querySelector('.account-name');
    const badgeEl = div.querySelector('.account-provider-badge');
    const uuidTextEl = div.querySelector('.account-uuid-text');

    if (nameEl) nameEl.textContent = data.name || '';
    if (badgeEl) badgeEl.textContent = providerLabel;
    if (uuidTextEl) uuidTextEl.textContent = data.uuid || '';

    if (imgEl) {
        imgEl.alt = data.name || '';
        imgEl.onerror = () => {
            if (!imgEl.src.endsWith('setve.png')) {
                imgEl.src = DEFAULT_AVATAR;
            }
        };
        imgEl.src = avatarUrl;
    }
}

async function accountSelect(uuid, accountObj = null) {
    const accountEl = document.getElementById(uuid);
    const activeAccount = document.querySelector('.active-account');
    if (activeAccount) activeAccount.classList.remove('active-account');
    if (accountEl) accountEl.classList.add('active-account');

    if (accountObj) {
        await headplayer(accountObj);
    } else if (accountEl) {
        const imgEl = accountEl.querySelector('.account-image');
        const playerHead = document.querySelector('.player-head');
        if (imgEl && imgEl.src && playerHead) {
            playerHead.style.backgroundImage = `url("${imgEl.src}")`;
        } else {
            const pseudo = accountEl.querySelector('.account-name')?.textContent || '';
            await headplayer(pseudo);
        }
    }
}

async function headplayer(accountOrPseudo) {
    const playerHead = document.querySelector('.player-head');
    if (!playerHead) return;

    const azauth = await resolveAzAuthBase();
    if (accountOrPseudo && typeof accountOrPseudo === 'object') {
        const avatarUrl = await resolveAccountAvatarUrl(accountOrPseudo, azauth);
        playerHead.style.backgroundImage = `url("${avatarUrl}")`;
        return;
    }

    const pseudo = String(accountOrPseudo || '');
    if (pseudo && azauth) {
        const avatarUrl = await resolveAccountAvatarUrl({ name: pseudo, meta: { type: 'AZauth' } }, azauth);
        playerHead.style.backgroundImage = `url("${avatarUrl}")`;
    } else {
        playerHead.style.backgroundImage = `url("${DEFAULT_AVATAR}")`;
    }
}

// ---------------------------------------------------------------------------
// Shared Multi-Instance, Per-Instance RAM & Access Control Helpers
// ---------------------------------------------------------------------------

export function getInstancesList(cfg) {
    return Array.isArray(cfg?.instances) ? cfg.instances : [];
}

export function isInstanceModded(inst, cfg) {
    if (inst && inst.modde !== undefined && inst.modde !== null) {
        return Boolean(inst.modde);
    }
    if (cfg && cfg.modde !== undefined && cfg.modde !== null) {
        return Boolean(cfg.modde);
    }
    return true;
}

export function computeInstanceRamBounds(inst, cfg, totalGb = 8) {
    const validTotal = Number.isFinite(totalGb) && totalGb > 0 ? totalGb : 8;
    const maxSystemRam = Math.max(1, Math.round(((80 * validTotal) / 100) * 2) / 2);

    const rawInstMin = Number(inst?.ram_min ?? cfg?.ram_min ?? 2);
    const rawInstMax = Number(inst?.ram_max ?? cfg?.ram_max ?? 4);

    const desiredMin =
        Number.isFinite(rawInstMin) && rawInstMin > 0
            ? Math.max(0.5, Math.round(rawInstMin * 2) / 2)
            : 2;
    const minBound = Math.min(desiredMin, maxSystemRam);
    const maxBound = Math.max(minBound, maxSystemRam);

    const defaultMin = minBound;
    const desiredMax =
        Number.isFinite(rawInstMax) && rawInstMax > 0
            ? Math.round(rawInstMax * 2) / 2
            : Math.max(defaultMin, 4);
    const defaultMax = Math.max(defaultMin, Math.min(maxBound, desiredMax));

    return {
        minBound,
        maxBound,
        defaultMin,
        defaultMax,
    };
}

export async function resolveInstanceRam(inst, cfg, db, totalGb = 8) {
    const slug = String(inst?.slug || 'default');
    const ramKey = `ram_${slug}`;
    const bounds = computeInstanceRamBounds(inst, cfg, totalGb);

    let saved = null;
    if (db) {
        const rec = await db.get(ramKey, 'ram');
        saved = rec?.value || null;
    }

    const parsedMin = saved ? parseFloat(saved.ramMin) : NaN;
    const parsedMax = saved ? parseFloat(saved.ramMax) : NaN;

    let ramMin = Number.isFinite(parsedMin) ? Math.round(parsedMin * 2) / 2 : bounds.defaultMin;
    let ramMax = Number.isFinite(parsedMax) ? Math.round(parsedMax * 2) / 2 : bounds.defaultMax;

    ramMin = Math.max(bounds.minBound, Math.min(bounds.maxBound, ramMin));
    ramMax = Math.max(ramMin, Math.min(bounds.maxBound, ramMax));

    return {
        ramKey,
        ramMin,
        ramMax,
        ...bounds,
    };
}

export async function getActiveInstance(cfg, db) {
    const instances = getInstancesList(cfg);
    if (!instances.length) return null;

    let savedSlug = null;
    if (db) {
        const profileRec = await db.get('1234', 'profile');
        savedSlug = profileRec?.value?.selectedInstance || null;
    }

    let chosen = savedSlug ? instances.find((i) => i.slug === savedSlug) : null;
    if (!chosen) {
        chosen = instances.find((i) => i.is_default) || instances[0];
        if (db && chosen?.slug) {
            await db.update({ uuid: '1234', selectedInstance: chosen.slug }, 'profile');
        }
    }

    if (cfg) {
        cfg._activeInstance = chosen;
    }
    config._activeInstance = chosen;
    return chosen;
}

export async function setActiveInstance(slug, cfg, db) {
    const instances = getInstancesList(cfg);
    if (!instances.length) return null;

    const chosen =
        instances.find((i) => i.slug === slug) ||
        instances.find((i) => i.is_default) ||
        instances[0];
    if (db && chosen?.slug) {
        await db.update({ uuid: '1234', selectedInstance: chosen.slug }, 'profile');
    }
    if (cfg) {
        cfg._activeInstance = chosen;
    }
    config._activeInstance = chosen;
    window.dispatchEvent(new CustomEvent('instance-changed', { detail: { instance: chosen } }));
    return chosen;
}

function toArray(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    if (typeof val === 'object') return Object.values(val);
    return [];
}

function matchesUserList(list, account) {
    const arr = toArray(list).map((x) => String(x).toLowerCase());
    if (!arr.length || !account) return false;
    const name = String(account.name || '').toLowerCase();
    const uuid = String(account.uuid || '').toLowerCase();
    const cleanUuid = uuid.replace(/-/g, '');
    return arr.includes(name) || arr.includes(uuid) || (cleanUuid && arr.includes(cleanUuid));
}

function matchesRoleList(list, account) {
    const roleName = account?.user_info?.role?.name;
    if (!roleName) return false;
    const arr = toArray(list).map((x) => String(x).toLowerCase());
    return arr.includes(String(roleName).toLowerCase());
}

export function canBypassMaintenance(account, scopeObj) {
    if (!account) return false;
    if (account.user_info?.maintenance_bypass) return true;
    if (matchesUserList(scopeObj?.maintenance_bypass_users, account)) return true;
    if (matchesRoleList(scopeObj?.maintenance_bypass_roles, account)) return true;
    return false;
}

export function evaluateInstanceAccess(account, instance, cfg) {
    // 1. Instance-level maintenance check
    if (
        instance?.maintenance &&
        !canBypassMaintenance(account, instance) &&
        !canBypassMaintenance(account, cfg)
    ) {
        const cleanMsg = stripHtmlToText(instance.maintenance_message) || t('instance_maintenance');
        return {
            locked: true,
            reason: 'maintenance',
            message: cleanMsg,
        };
    }

    // 2. Global maintenance check (in case user bypassed or switched account)
    if (cfg?.maintenance && !canBypassMaintenance(account, cfg)) {
        const cleanMsg = stripHtmlToText(cfg.maintenance_message) || t('maintenance_active');
        return {
            locked: true,
            reason: 'maintenance',
            message: cleanMsg,
        };
    }

    // 3. Whitelist check (instance-scoped with config fallback)
    const wlActive = instance ? Boolean(instance.whitelist_activate) : Boolean(cfg?.whitelist_activate);
    if (wlActive) {
        const wlUsers = instance ? instance.whitelist : cfg?.whitelist;
        const wlRoles = instance ? instance.whitelist_roles : cfg?.whitelist_roles;
        const allowed = matchesUserList(wlUsers, account) || matchesRoleList(wlRoles, account);
        if (!allowed) {
            return {
                locked: true,
                reason: 'whitelist',
                message: t('instance_whitelisted') || t('unavailable'),
            };
        }
    }

    return { locked: false, reason: null, message: t('play') };
}

export function updatePlayerWidgets(account, cfg) {
    const sidebarRole = document.querySelector('.player-role');
    const monnaieEl = document.querySelector('.player-monnaie');

    const showRole = Boolean(cfg?.role ?? cfg?.role_display ?? cfg?.show_role);
    const showMoney = Boolean(cfg?.money ?? cfg?.money_display ?? cfg?.show_points);

    const roleName = account?.user_info?.role?.name || null;
    if (sidebarRole) {
        if (showRole && roleName) {
            sidebarRole.style.display = '';
            sidebarRole.textContent = roleName;
        } else {
            sidebarRole.style.display = 'none';
            sidebarRole.textContent = '';
        }
    }

    if (monnaieEl) {
        const pts = account?.user_info?.monnaie ?? account?.user_info?.money ?? 0;
        if (showMoney) {
            monnaieEl.style.display = '';
            monnaieEl.textContent = `${pts} pts`;
        } else {
            monnaieEl.style.display = 'none';
            monnaieEl.textContent = '';
        }
    }
}

export function updatePlayButtonState(account, instance, cfg) {
    const playBtn = document.querySelector('.play-btn');
    const noticeBox = document.getElementById('maintenance-notice');
    const noticeText = document.getElementById('maintenance-notice-text');
    const noticeIcon = noticeBox?.querySelector('.maintenance-notice-icon');

    const access = evaluateInstanceAccess(account, instance, cfg);

    if (noticeBox && noticeText) {
        if (access.locked && access.message) {
            noticeText.textContent = access.message;
            if (noticeIcon) {
                noticeIcon.classList.toggle('fa-wrench', access.reason === 'maintenance');
                noticeIcon.classList.toggle('fa-lock', access.reason !== 'maintenance');
            }
            noticeBox.style.display = '';
        } else {
            noticeBox.style.display = 'none';
            noticeText.textContent = '';
        }
    }

    if (!playBtn) return;

    if (access.locked) {
        playBtn.style.background = '#696969';
        playBtn.style.pointerEvents = 'none';
        playBtn.style.boxShadow = 'none';
        playBtn.style.opacity = '0.6';
        playBtn.title = access.message;
        playBtn.dataset.locked = access.reason || 'locked';
    } else {
        playBtn.style.background = '';
        playBtn.style.pointerEvents = 'auto';
        playBtn.style.boxShadow = '';
        playBtn.style.opacity = '1';
        playBtn.title = instance?.name ? `${t('play')} — ${instance.name}` : t('play');
        delete playBtn.dataset.locked;
    }
}

export function resolveBackgroundUrl(account, instance, cfg) {
    const httpPattern = /^https?:\/\//i;
    const roleAllowed = cfg?.role_bg !== false && cfg?.role_background !== false;

    if (roleAllowed) {
        // 1. Direct role background (e.g. from Panel /utils/auth/microsoft/sync)
        const directRoleBg = account?.user_info?.role?.background;
        if (directRoleBg && httpPattern.test(directRoleBg)) {
            return directRoleBg;
        }

        // 2. Role mapping in config.role_data (case-insensitive role name match)
        const roleName = account?.user_info?.role?.name;
        if (cfg?.role_data && roleName) {
            const targetRole = String(roleName).trim().toLowerCase();
            for (const roleKey of Object.keys(cfg.role_data)) {
                const roleEntry = cfg.role_data[roleKey];
                if (
                    roleEntry &&
                    String(roleEntry.name || roleKey).trim().toLowerCase() === targetRole &&
                    roleEntry.background &&
                    httpPattern.test(roleEntry.background)
                ) {
                    return roleEntry.background;
                }
            }
        }
    }

    // 3. Instance-specific background
    if (instance?.background && httpPattern.test(instance.background)) {
        return instance.background;
    }

    // 4. Global config background fallback if configured
    if (cfg?.background && httpPattern.test(cfg.background)) {
        return cfg.background;
    }

    return DEFAULT_BG;
}

// ---------------------------------------------------------------------------
// Per-Account & Per-Instance Optional Mods Preferences + Disk Synchronization
// ---------------------------------------------------------------------------

const OPTIONAL_MODS_PREFS_KEY = 'optional-mods-by-account';
let _optionalModsSyncQueue = Promise.resolve();

function enqueueOptionalModsOp(fn) {
    const run = _optionalModsSyncQueue.then(fn, fn);
    _optionalModsSyncQueue = run.catch(() => {});
    return run;
}

export function getAccountStableId(account) {
    if (!account) return null;
    if (typeof account === 'string') {
        const trimmed = account.trim();
        return trimmed || null;
    }
    const raw = account.uuid || account.id || account.name;
    return raw ? String(raw).trim() : null;
}

export function resolveModsUrlForInstance(instance, meta) {
    if (instance?.mods_url) return instance.mods_url;
    const rawSettings = meta?.settings_url || '';
    if (!rawSettings) return '';
    const base = rawSettings.endsWith('/') ? rawSettings : `${rawSettings}/`;
    if (instance?.slug && instance.slug !== 'default') {
        return meta?.env === 'azuriom'
            ? `${base}api/centralcorp/instances/${instance.slug}/mods`
            : `${base}utils/instances/${instance.slug}/mods`;
    }
    return meta?.env === 'azuriom' ? `${base}api/centralcorp/mods` : `${base}utils/mods`;
}

async function readOptionalModsByAccount(db, cfg = null) {
    let byAccount = null;
    if (db) {
        const rec = await db.get(OPTIONAL_MODS_PREFS_KEY, 'profile');
        const raw = rec?.value?.optionalModsByAccount;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            byAccount = raw;
        }
    }
    if (!byAccount) {
        byAccount =
            cfg?.optionalModsByAccount && typeof cfg.optionalModsByAccount === 'object'
                ? cfg.optionalModsByAccount
                : {};
    }
    if (cfg) {
        cfg.optionalModsByAccount = byAccount;
    }
    return byAccount;
}

async function writeOptionalModsByAccount(db, byAccount, cfg = null) {
    const cleanMap = byAccount && typeof byAccount === 'object' ? byAccount : {};
    if (cfg) {
        cfg.optionalModsByAccount = cleanMap;
    }
    if (db) {
        await db.update(
            {
                uuid: OPTIONAL_MODS_PREFS_KEY,
                optionalModsByAccount: cleanMap,
            },
            'profile'
        );
    }
}

export async function setOptionalModPreference({
    db,
    cfg = null,
    account,
    instanceSlug,
    modFile,
    enabled,
}) {
    const accountId = getAccountStableId(account);
    if (!accountId || !modFile) return;
    const slug = String(instanceSlug || 'default');

    return enqueueOptionalModsOp(async () => {
        const byAccount = await readOptionalModsByAccount(db, cfg);
        if (!byAccount[accountId] || typeof byAccount[accountId] !== 'object') {
            byAccount[accountId] = {};
        }
        if (!byAccount[accountId][slug] || typeof byAccount[accountId][slug] !== 'object') {
            byAccount[accountId][slug] = {};
        }
        byAccount[accountId][slug][modFile] = Boolean(enabled);
        await writeOptionalModsByAccount(db, byAccount, cfg);
    });
}

export async function deleteAccountOptionalModPreferences(db, accountOrId, cfg = null) {
    const accountId = getAccountStableId(accountOrId);
    if (!accountId) return;

    return enqueueOptionalModsOp(async () => {
        const byAccount = await readOptionalModsByAccount(db, cfg);
        if (Object.prototype.hasOwnProperty.call(byAccount, accountId)) {
            delete byAccount[accountId];
            await writeOptionalModsByAccount(db, byAccount, cfg);
        }
    });
}

export async function syncOptionalModsForAccount({
    db,
    cfg,
    meta,
    account,
    instance,
    modsUrl = null,
    throwOnFetchError = false,
}) {
    if (!isInstanceModded(instance, cfg)) {
        return [];
    }

    const slug = String(instance?.slug || 'default');
    const gameRoot = resolveGameRoot(meta, cfg?.dataDirectory);
    const effectiveModsUrl = modsUrl || resolveModsUrlForInstance(instance, meta);
    const accountId = getAccountStableId(account);

    return enqueueOptionalModsOp(async () => {
        const byAccount = accountId ? await readOptionalModsByAccount(db, cfg) : null;
        const rawSaved =
            accountId && byAccount?.[accountId]?.[slug] && typeof byAccount[accountId][slug] === 'object'
                ? byAccount[accountId][slug]
                : null;
        const hasSavedPrefs = Boolean(rawSaved && Object.keys(rawSaved).length > 0);

        // Apply saved per-account preferences onto disk + launcher_config/mods_config.json
        if (hasSavedPrefs) {
            for (const [modFile, desiredEnabled] of Object.entries(rawSaved)) {
                try {
                    await toggleOptionalMod(gameRoot, slug, modFile, Boolean(desiredEnabled));
                } catch (err) {
                    console.warn(`Failed to apply saved optional mod state (${modFile}):`, err);
                }
            }
        }

        if (effectiveModsUrl) {
            try {
                const mods = await listOptionalMods(gameRoot, slug, effectiveModsUrl);
                if (Array.isArray(mods) && accountId && byAccount) {
                    let prefsChanged = false;
                    if (!byAccount[accountId] || typeof byAccount[accountId] !== 'object') {
                        byAccount[accountId] = {};
                    }
                    if (!hasSavedPrefs) {
                        // Gentle migration: seed this account's preferences from current disk/manifest state
                        const initialPrefs = {};
                        for (const mod of mods) {
                            if (mod?.file) {
                                initialPrefs[mod.file] = Boolean(mod.enabled);
                            }
                        }
                        if (Object.keys(initialPrefs).length > 0) {
                            byAccount[accountId][slug] = initialPrefs;
                            prefsChanged = true;
                        }
                    } else {
                        // Merge any newly added optional mods from the server manifest without overwriting saved choices
                        for (const mod of mods) {
                            if (
                                mod?.file &&
                                !Object.prototype.hasOwnProperty.call(rawSaved, mod.file)
                            ) {
                                rawSaved[mod.file] = Boolean(mod.enabled);
                                prefsChanged = true;
                            }
                        }
                    }
                    if (prefsChanged) {
                        await writeOptionalModsByAccount(db, byAccount, cfg);
                    }
                }
                return Array.isArray(mods) ? mods : [];
            } catch (err) {
                if (throwOnFetchError) {
                    throw err;
                }
                await syncOptionalMods(gameRoot, slug, effectiveModsUrl).catch(() => {});
                return [];
            }
        }

        await syncOptionalMods(gameRoot, slug, null).catch(() => {});
        return [];
    });
}

// ---------------------------------------------------------------------------
// Dynamic Discord Rich Presence Payload Builder
// ---------------------------------------------------------------------------

export function buildDiscordRpcPayload(cfg, instance = null, { playing = false } = {}) {
    if (!cfg || !cfg.rpc_activation || !cfg.rpc_id) {
        return null;
    }

    const instanceName = String(instance?.name || instance?.slug || '').trim();
    const hasPlaceholder = (str) => /\{instance\}/i.test(String(str || ''));
    const replacePlaceholders = (str) => {
        const raw = String(str || '');
        if (!raw) return '';
        if (!instanceName) {
            return raw.replace(/\s*[-—•:]?\s*\{instance\}/gi, '').trim();
        }
        return raw.replace(/\{instance\}/gi, instanceName).trim();
    };

    const rawInstDetails = String(instance?.rpc_details || '').trim();
    const rawInstState = String(instance?.rpc_state || '').trim();
    const rawCfgDetails = String(cfg.rpc_details || '').trim();
    const rawCfgState = String(cfg.rpc_state || '').trim();

    const detailsTemplate = rawInstDetails || rawCfgDetails;
    const stateTemplate = rawInstState || rawCfgState;

    const details = replacePlaceholders(detailsTemplate);
    let state = replacePlaceholders(stateTemplate);

    const customOrTemplated =
        Boolean(rawInstDetails || rawInstState) ||
        hasPlaceholder(detailsTemplate) ||
        hasPlaceholder(stateTemplate);

    if (instanceName && !customOrTemplated) {
        const multiInstance = getInstancesList(cfg).length > 1;
        const alreadyMentioned =
            details.toLowerCase().includes(instanceName.toLowerCase()) ||
            state.toLowerCase().includes(instanceName.toLowerCase());
        if ((playing || multiInstance) && !alreadyMentioned) {
            state = state ? `${state} — ${instanceName}` : instanceName;
        }
    }

    return {
        enabled: true,
        client_id: String(cfg.rpc_id),
        details,
        state,
        large_image: cfg.rpc_large_image || '',
        large_text: replacePlaceholders(cfg.rpc_large_text || ''),
        small_image: cfg.rpc_small_image || '',
        small_text: replacePlaceholders(cfg.rpc_small_text || ''),
        button1_label: cfg.rpc_button1 || '',
        button1_url: cfg.rpc_button1_url || '',
        button2_label: cfg.rpc_button2 || '',
        button2_url: cfg.rpc_button2_url || '',
    };
}

function showLoadingOverlay() {
    const existing = document.getElementById('account-loading-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'account-loading-overlay';
    overlay.innerHTML = `
        <div class="loading-spinner">
            <span class="loading-dot"></span>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.offsetHeight;
    overlay.classList.add('visible');
}

function hideLoadingOverlay() {
    const overlay = document.getElementById('account-loading-overlay');
    if (overlay) {
        overlay.classList.remove('visible');
        setTimeout(() => {
            if (overlay.parentNode) {
                overlay.remove();
            }
        }, 450);
    }
}

export {
    config,
    database,
    logger,
    changePanel,
    addAccount,
    slider as Slider,
    accountSelect,
    headplayer,
    renderMinecraftHeadDataUrl,
    showLoadingOverlay,
    hideLoadingOverlay,
    t,
};
