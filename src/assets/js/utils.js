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
    renderMinecraftHeadDataUrl,
    resolveAccountAvatarUrl,
} from './utils/skin-renderer.js';

const DEFAULT_AVATAR = './assets/images/default/setve.png';
const DEFAULT_BG = './assets/images/background/light.jpg';
const SUPPORTED_LANGS = ['fr', 'en', 'es', 'de', 'ru'];

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

function changePanel(id) {
    const panel = document.querySelector(`.${id}`);
    const active = document.querySelector('.active');
    if (active) active.classList.remove('active');
    if (panel) panel.classList.add('active');
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
        <img class="account-image" src="${avatarUrl}" alt="${data.name}">
        <div class="account-info-col">
            <div class="account-name">${data.name}</div>
            <div class="account-uuid"><span class="account-provider-badge ${isMicrosoft ? 'ms' : 'az'}">${providerLabel}</span> ${data.uuid}</div>
        </div>
        <div class="account-delete"><div class="icon-account-delete icon-account-delete-btn"></div></div>
    `;

    const imgEl = div.querySelector('.account-image');
    if (imgEl) {
        imgEl.onerror = () => {
            if (!imgEl.src.endsWith('setve.png')) {
                imgEl.src = DEFAULT_AVATAR;
            }
        };
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
            const pseudo = accountEl.querySelector('.account-name')?.innerText || '';
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
        const timestamp = Date.now();
        const skinUrl = `${azauth}api/skin-api/avatars/face/${encodeURIComponent(pseudo)}/?t=${timestamp}`;
        playerHead.style.backgroundImage = `url("${skinUrl}")`;
    } else {
        playerHead.style.backgroundImage = `url("${DEFAULT_AVATAR}")`;
    }
}

// ---------------------------------------------------------------------------
// Shared Multi-Instance & Access Control Helpers
// ---------------------------------------------------------------------------

export function getInstancesList(cfg) {
    const list = Array.isArray(cfg?.instances) ? cfg.instances : [];
    return list;
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
    return chosen;
}

export async function setActiveInstance(slug, cfg, db) {
    const instances = getInstancesList(cfg);
    if (!instances.length) return null;

    const chosen = instances.find((i) => i.slug === slug) || instances.find((i) => i.is_default) || instances[0];
    if (db && chosen?.slug) {
        await db.update({ uuid: '1234', selectedInstance: chosen.slug }, 'profile');
    }
    if (cfg) {
        cfg._activeInstance = chosen;
    }
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
    if (instance?.maintenance && !canBypassMaintenance(account, instance) && !canBypassMaintenance(account, cfg)) {
        return {
            locked: true,
            reason: 'maintenance',
            message: instance.maintenance_message || t('instance_maintenance'),
        };
    }

    // 2. Global maintenance check (in case user bypassed or switched account)
    if (cfg?.maintenance && !canBypassMaintenance(account, cfg)) {
        return {
            locked: true,
            reason: 'maintenance',
            message: cfg.maintenance_message || t('maintenance_active'),
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
                message: t('unavailable'),
            };
        }
    }

    return { locked: false, reason: null, message: t('play') };
}

export function updatePlayerWidgets(account, cfg) {
    const tooltipRole = document.querySelector('.player-tooltip-role');
    const sidebarRole = document.querySelector('.player-role');
    const monnaieEl = document.querySelector('.player-monnaie');

    const roleName = account?.user_info?.role?.name || null;
    if (tooltipRole && sidebarRole) {
        if (cfg?.role && roleName) {
            tooltipRole.style.display = '';
            tooltipRole.textContent = roleName;
            sidebarRole.textContent = roleName;
        } else if (account?.name) {
            // Show username gracefully in tooltip when no role is configured
            tooltipRole.style.display = '';
            tooltipRole.textContent = account.name;
            sidebarRole.style.display = 'none';
        } else {
            tooltipRole.style.display = 'none';
            sidebarRole.style.display = 'none';
        }
    }

    if (monnaieEl) {
        const pts = account?.user_info?.monnaie ?? account?.user_info?.money ?? 0;
        if (cfg?.money) {
            monnaieEl.style.display = '';
            monnaieEl.textContent = `${pts} pts`;
        } else {
            monnaieEl.style.display = 'none';
        }
    }
}

export function updatePlayButtonState(account, instance, cfg) {
    const playBtn = document.querySelector('.play-btn');
    if (!playBtn) return;

    const access = evaluateInstanceAccess(account, instance, cfg);
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

    // 1. Direct role background (e.g. from Panel /utils/auth/microsoft/sync)
    const directRoleBg = account?.user_info?.role?.background;
    if (directRoleBg && httpPattern.test(directRoleBg)) {
        return directRoleBg;
    }

    // 2. Role mapping in config.role_data
    const roleName = account?.user_info?.role?.name;
    if (cfg?.role_data && roleName) {
        for (const roleKey of Object.keys(cfg.role_data)) {
            const roleEntry = cfg.role_data[roleKey];
            if (roleEntry && roleEntry.name === roleName && roleEntry.background && httpPattern.test(roleEntry.background)) {
                return roleEntry.background;
            }
        }
    }

    // 3. Instance-specific background
    if (instance?.background && httpPattern.test(instance.background)) {
        return instance.background;
    }

    return DEFAULT_BG;
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
