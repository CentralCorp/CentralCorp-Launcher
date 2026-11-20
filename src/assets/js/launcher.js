/**
 * @author Luuxis
 * Licensed under CC BY-NC 4.0
 * https://creativecommons.org/licenses/by-nc/4.0/
 *
 * Edited by CentralCorp Team
 */
'use strict';

import {
    config,
    logger,
    changePanel,
    database,
    addAccount,
    accountSelect,
    initTranslations,
    applyAccentColor,
    normalizeAccount,
    isPermanentAzuriomAuthError,
    getActiveInstance,
    updatePlayerWidgets,
    updatePlayButtonState,
    resolveBackgroundUrl,
    t,
} from './utils.js';
import {
    getLauncherMeta,
    minimizeWindow,
    toggleMaximizeWindow,
    closeWindow,
    authAzuriomVerify,
    authMicrosoftRefresh,
    syncMicrosoftPanel,
    setCloseBehavior,
    setDiscordRpc,
} from './utils/tauri-bridge.js';
import Login from './panels/login.js';
import Home from './panels/home.js';
import Settings from './panels/settings.js';

class Launcher {
    async init() {
        this.initLog();
        console.log('Initializing Launcher...');
        this.initFrame();

        // Run translations, metadata, shared IndexedDB, and memoized bootstrap config concurrently
        const [, meta, db, cfg] = await Promise.all([
            initTranslations().then(() => {
                const preloadTitle = document.getElementById('preload-title');
                if (preloadTitle) preloadTitle.textContent = t('loading');
            }),
            getLauncherMeta(),
            new database().init(),
            config.GetConfig(),
        ]);

        this.meta = meta;
        this.database = db;
        this.config = cfg;
        applyAccentColor(this.config);

        // Kick off news retrieval asynchronously (0 HTTP calls when included_news was cached on Splash)
        this.newsPromise = config.GetNews();

        const [activeInstance, launcherRec] = await Promise.all([
            getActiveInstance(this.config, this.database),
            this.database.get('1234', 'launcher'),
        ]);
        this.activeInstance = activeInstance;

        const savedCloseBehavior = launcherRec?.value?.launcher?.close || 'close-launcher';
        setCloseBehavior(savedCloseBehavior).catch(() => {});

        await this.createPanels(Login, Home, Settings);
        this.bindStateEvents();
        await this.getAccounts();
        this.initDiscordRPC();
    }

    initLog() {
        new logger('Launcher', '#7289da');
    }

    initDiscordRPC() {
        if (this.config && this.config.rpc_activation && this.config.rpc_id) {
            const rpcPayload = {
                enabled: true,
                client_id: String(this.config.rpc_id),
                details: this.config.rpc_details || '',
                state: this.config.rpc_state || '',
                large_image: this.config.rpc_large_image || '',
                large_text: this.config.rpc_large_text || '',
                small_image: this.config.rpc_small_image || '',
                small_text: this.config.rpc_small_text || '',
                button1_label: this.config.rpc_button1 || '',
                button1_url: this.config.rpc_button1_url || '',
                button2_label: this.config.rpc_button2 || '',
                button2_url: this.config.rpc_button2_url || '',
            };
            setDiscordRpc(rpcPayload).catch((err) => {
                console.warn('Discord RPC unavailable:', err);
            });
        }
    }

    initFrame() {
        const frame = document.querySelector('.frame');
        const dragbar = document.querySelector('.dragbar');
        if (frame) frame.classList.add('hide');
        if (dragbar) dragbar.classList.add('hide');

        const minimize = document.querySelector('#minimize');
        if (minimize) {
            minimize.addEventListener('click', () => {
                minimizeWindow();
            });
        }

        const maximize = document.querySelector('#maximize');
        if (maximize) {
            maximize.addEventListener('click', async () => {
                const isMax = await toggleMaximizeWindow();
                maximize.classList.toggle('icon-maximize', !isMax);
                maximize.classList.toggle('icon-restore-down', Boolean(isMax));
            });
        }

        const close = document.querySelector('#close');
        if (close) {
            close.addEventListener('click', () => {
                closeWindow();
            });
        }
    }

    async createPanels(...panels) {
        const panelsElem = document.querySelector('.panels');
        this.panelInstances = {};

        // Fetch all panel HTML templates concurrently
        const templates = await Promise.all(
            panels.map(async (PanelClass) => {
                const res = await fetch(`./panels/${PanelClass.id}.html`);
                const html = await res.text();
                return { PanelClass, html };
            })
        );

        for (const { PanelClass, html } of templates) {
            const div = document.createElement('div');
            div.classList.add('panel', PanelClass.id);
            div.innerHTML = html;
            panelsElem.appendChild(div);
            this.panelInstances[PanelClass.id] = new PanelClass();
        }

        // Initialize all panels concurrently (heavy work inside Home/Settings is non-blocking/lazy)
        await Promise.all(
            panels.map((PanelClass) =>
                this.panelInstances[PanelClass.id].init(this.config, this.newsPromise)
            )
        );
    }

    bindStateEvents() {
        window.addEventListener('instance-changed', async (e) => {
            this.activeInstance =
                e.detail?.instance || (await getActiveInstance(this.config, this.database));
            const account = await this.getSelectedAccount();
            if (account) {
                updatePlayButtonState(account, this.activeInstance, this.config);
                this.updateBackground(account);
            }
        });

        window.addEventListener('account-changed', async (e) => {
            const account = e.detail?.account || (await this.getSelectedAccount());
            if (account) {
                this.activeInstance = await getActiveInstance(this.config, this.database);
                updatePlayerWidgets(account, this.config);
                updatePlayButtonState(account, this.activeInstance, this.config);
                this.updateBackground(account);
            }
        });
    }

    async getSelectedAccount() {
        const selectedUuid = (await this.database.get('1234', 'accounts-selected'))?.value?.selected;
        if (!selectedUuid) return null;
        const rec = await this.database.get(selectedUuid, 'accounts');
        return rec?.value ? normalizeAccount(rec.value) : null;
    }

    async verifySingleStoredAccount(stored, azauthUrl, panelBaseUrl) {
        if (stored.meta?.type === 'Microsoft') {
            const nowSec = Math.floor(Date.now() / 1000);
            const hasFreshToken = Number(stored.expires_at || 0) > nowSec + 300;

            if (hasFreshToken) {
                // Skip full 5-step Microsoft OAuth refresh when token is still valid (> 5 min left);
                // only sync Panel player info (role, points, ban, maintenance_bypass) if in Panel mode.
                if (!panelBaseUrl) {
                    return { status: 'valid', account: stored, changed: false };
                }
                try {
                    const syncedRaw = await syncMicrosoftPanel(stored, panelBaseUrl);
                    const synced = normalizeAccount(syncedRaw);
                    if (synced.user_info?.banned) {
                        return { status: 'remove', uuid: stored.uuid };
                    }
                    return { status: 'valid', account: synced, changed: true };
                } catch (err) {
                    const msg = String(err?.message || err || '').toLowerCase();
                    if (msg.includes('user_banned')) {
                        return { status: 'remove', uuid: stored.uuid };
                    }
                    return { status: 'valid', account: stored, changed: false };
                }
            }

            console.log(`Refreshing expiring Microsoft account ${stored.name}...`);
            try {
                const refreshedRaw = await authMicrosoftRefresh(
                    stored,
                    this.config.client_id || null,
                    panelBaseUrl
                );
                const refreshed = normalizeAccount(refreshedRaw);
                if (refreshed.user_info?.banned) {
                    return { status: 'remove', uuid: stored.uuid };
                }
                return { status: 'valid', account: refreshed, changed: true };
            } catch (err) {
                const msg = String(err?.message || err || '').toLowerCase();
                console.error(`[Microsoft Account] ${stored.uuid}: ${msg}`);
                if (
                    msg.includes('user_banned') ||
                    msg.includes('invalid_grant') ||
                    msg.includes('unauthorized')
                ) {
                    return { status: 'remove', uuid: stored.uuid };
                }
                return { status: 'valid', account: stored, changed: false };
            }
        }

        // Azuriom (`AZauth`) account
        if (!azauthUrl) {
            return { status: 'valid', account: stored, changed: false };
        }

        try {
            const verifiedRaw = await authAzuriomVerify(azauthUrl, stored.access_token);
            const verified = normalizeAccount(verifiedRaw);

            if (verified.user_info?.banned) {
                return { status: 'remove', uuid: stored.uuid };
            }

            if (this.config.email_verified && !verified.user_info?.verified) {
                return { status: 'unverified_email', uuid: stored.uuid };
            }

            // Preserve locally cached custom skin variant/base64 if verify response has empty skins
            if (
                (!verified.profile?.skins || verified.profile.skins.length === 0) &&
                stored.profile?.skins?.length
            ) {
                verified.profile = {
                    ...(verified.profile || { id: verified.uuid, name: verified.name, capes: [] }),
                    skins: stored.profile.skins,
                };
            }

            return { status: 'valid', account: verified, changed: true };
        } catch (err) {
            console.warn(`[AZauth Account] ${stored.uuid}:`, err);
            if (isPermanentAzuriomAuthError(err)) {
                return { status: 'remove', uuid: stored.uuid };
            }
            // Transient network/timeout/5xx error: never delete the player's saved account!
            return { status: 'valid', account: stored, changed: false };
        }
    }

    async getAccounts() {
        const [azauthUrl, panelBaseUrl, accounts, selectedRec] = await Promise.all([
            config.getAzAuthUrl(this.config),
            this.meta.env !== 'azuriom' ? config.getPanelBaseUrl() : Promise.resolve(null),
            this.database.getAll('accounts'),
            this.database.get('1234', 'accounts-selected'),
        ]);
        const selectedAccount = selectedRec?.value?.selected || null;

        if (!accounts.length) {
            changePanel('login');
            this.hidePreloader();
            return;
        }

        const storedAccounts = accounts
            .map((entry) => normalizeAccount(entry?.value))
            .filter(Boolean);

        // Verify all stored accounts concurrently instead of sequentially
        const settled = await Promise.allSettled(
            storedAccounts.map((stored) =>
                this.verifySingleStoredAccount(stored, azauthUrl, panelBaseUrl)
            )
        );

        const validAccounts = [];
        let sawUnverifiedEmail = false;

        for (let i = 0; i < settled.length; i++) {
            const item = settled[i];
            const fallbackStored = storedAccounts[i];
            if (item.status !== 'fulfilled' || !item.value) {
                validAccounts.push(fallbackStored);
                continue;
            }

            const res = item.value;
            if (res.status === 'remove' || res.status === 'unverified_email') {
                if (res.status === 'unverified_email') {
                    sawUnverifiedEmail = true;
                }
                await this.database.delete(res.uuid, 'accounts');
                if (res.uuid === selectedAccount) {
                    await this.database.update({ uuid: '1234' }, 'accounts-selected');
                }
                continue;
            }

            if (res.changed) {
                await this.database.update(res.account, 'accounts');
            }
            validAccounts.push(res.account);
        }

        if (!validAccounts.length) {
            changePanel('login');
            if (sawUnverifiedEmail && this.panelInstances?.login?.showEmailVerificationCard) {
                this.panelInstances.login.showEmailVerificationCard();
            }
            this.hidePreloader();
            return;
        }

        await Promise.all(validAccounts.map((acc) => addAccount(acc)));

        let activeAcc =
            validAccounts.find((a) => a.uuid === selectedAccount) || validAccounts[0];
        if (activeAcc.uuid !== selectedAccount) {
            await this.database.update({ uuid: '1234', selected: activeAcc.uuid }, 'accounts-selected');
        }
        await accountSelect(activeAcc.uuid, activeAcc);

        await this.refreshDataAndShowHome(activeAcc);
    }

    hidePreloader() {
        const preloader = document.querySelector('.preload-content');
        if (preloader) {
            preloader.classList.add('fade-out');
            setTimeout(() => {
                preloader.style.display = 'none';
            }, 350);
        }
    }

    async refreshDataAndShowHome(accountOverride = null) {
        const account = accountOverride || (await this.getSelectedAccount());
        if (!account) {
            changePanel('login');
            this.hidePreloader();
            return;
        }

        this.activeInstance = await getActiveInstance(this.config, this.database);
        updatePlayerWidgets(account, this.config);
        updatePlayButtonState(account, this.activeInstance, this.config);

        if (this.panelInstances?.home) {
            // Non-blocking refresh: renders instance selector & server icon immediately, pings server async
            this.panelInstances.home.refreshInstanceView();
        }

        // Briefly warm remote custom role/instance background (capped at 450ms so Home never stalls)
        const bgUrl = resolveBackgroundUrl(account, this.activeInstance, this.config);
        if (/^https?:\/\//i.test(bgUrl)) {
            await Promise.race([
                this.preloadBackgroundUrl(bgUrl),
                new Promise((resolve) => setTimeout(resolve, 450)),
            ]);
        }

        this.updateBackground(account);
        changePanel('home');
        this.hidePreloader();
    }

    preloadBackgroundUrl(url) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve();
            img.onerror = () => resolve();
            img.src = url;
        });
    }

    updateBackground(account) {
        const finalBgUrl = resolveBackgroundUrl(account, this.activeInstance, this.config);
        if (this._currentBgUrl === finalBgUrl) {
            return;
        }
        this._currentBgUrl = finalBgUrl;

        if (!document.getElementById('bg-transition-overlay')) {
            const overlay = document.createElement('div');
            overlay.id = 'bg-transition-overlay';
            overlay.style.cssText = `
                position: fixed; inset: 0; width: 100%; height: 100%;
                z-index: -1; opacity: 0; transition: opacity 0.45s ease;
                background-repeat: no-repeat; background-size: cover;
                background-position: center center; pointer-events: none;
            `;
            document.body.appendChild(overlay);
        }

        const overlay = document.getElementById('bg-transition-overlay');
        overlay.style.backgroundImage = `linear-gradient(rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0.4)), url("${finalBgUrl}")`;

        requestAnimationFrame(() => {
            overlay.style.opacity = '1';
        });

        clearTimeout(this._bgSwapTimer);
        this._bgSwapTimer = setTimeout(() => {
            document.body.style.backgroundColor = '#000000';
            document.body.style.backgroundImage = `linear-gradient(rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0.4)), url("${finalBgUrl}")`;
            document.body.style.backgroundRepeat = 'no-repeat';
            document.body.style.backgroundPosition = 'center center';
            document.body.style.backgroundSize = 'cover';
            document.body.style.backgroundAttachment = 'fixed';
            overlay.style.opacity = '0';
        }, 480);
    }
}

new Launcher().init();
