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
    normalizeAccount,
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
    setDiscordRpc,
} from './utils/tauri-bridge.js';
import Login from './panels/login.js';
import Home from './panels/home.js';
import Settings from './panels/settings.js';

class Launcher {
    async init() {
        this.initLog();
        await initTranslations();
        const preloadTitle = document.getElementById('preload-title');
        if (preloadTitle) preloadTitle.textContent = t('loading');

        console.log('Initializing Launcher...');
        this.meta = await getLauncherMeta();
        this.initFrame();

        this.config = await config.GetConfig();
        this.applyAccentColor();
        this.news = await config.GetNews();
        this.database = await new database().init();
        this.activeInstance = await getActiveInstance(this.config, this.database);

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
        console.log('Initializing Frame...');
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

        for (const PanelClass of panels) {
            console.log(`Initializing ${PanelClass.name} Panel...`);
            const div = document.createElement('div');
            div.classList.add('panel', PanelClass.id);

            const res = await fetch(`./panels/${PanelClass.id}.html`);
            div.innerHTML = await res.text();
            panelsElem.appendChild(div);

            const instance = new PanelClass();
            this.panelInstances[PanelClass.id] = instance;
            await instance.init(this.config, this.news);
        }
    }

    bindStateEvents() {
        window.addEventListener('instance-changed', async (e) => {
            this.activeInstance = e.detail?.instance || await getActiveInstance(this.config, this.database);
            const account = await this.getSelectedAccount();
            if (account) {
                updatePlayButtonState(account, this.activeInstance, this.config);
                this.updateBackground(account);
            }
        });

        window.addEventListener('account-changed', async (e) => {
            const account = e.detail?.account || await this.getSelectedAccount();
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

    async getAccounts() {
        const azauthUrl = await config.getAzAuthUrl(this.config);
        const panelBaseUrl = this.meta.env !== 'azuriom' ? await config.getPanelBaseUrl() : null;
        const accounts = await this.database.getAll('accounts');
        const selectedAccount = (await this.database.get('1234', 'accounts-selected'))?.value?.selected;

        if (!accounts.length) {
            changePanel('login');
            this.hidePreloader();
            return;
        }

        for (const entry of accounts) {
            const stored = normalizeAccount(entry?.value);
            if (!stored) continue;

            if (stored.meta?.type === 'Microsoft') {
                console.log(`Refreshing Microsoft account ${stored.name}...`);
                try {
                    const refreshedRaw = await authMicrosoftRefresh(
                        stored,
                        this.config.client_id || null,
                        panelBaseUrl
                    );
                    const refreshed = normalizeAccount(refreshedRaw);
                    if (refreshed.user_info?.banned) {
                        await this.database.delete(stored.uuid, 'accounts');
                        if (stored.uuid === selectedAccount) {
                            await this.database.update({ uuid: '1234' }, 'accounts-selected');
                        }
                        continue;
                    }
                    await this.database.update(refreshed, 'accounts');
                    await addAccount(refreshed);
                    if (stored.uuid === selectedAccount) {
                        await accountSelect(refreshed.uuid, refreshed);
                    }
                } catch (err) {
                    const msg = String(err?.message || err || '');
                    console.error(`[Microsoft Account] ${stored.uuid}: ${msg}`);
                    if (msg.includes('user_banned') || msg.includes('invalid_grant') || msg.includes('unauthorized')) {
                        await this.database.delete(stored.uuid, 'accounts');
                        if (stored.uuid === selectedAccount) {
                            await this.database.update({ uuid: '1234' }, 'accounts-selected');
                        }
                    } else {
                        // Keep cached Microsoft session if temporarily offline
                        await addAccount(stored);
                        if (stored.uuid === selectedAccount) {
                            await accountSelect(stored.uuid, stored);
                        }
                    }
                }
            } else if (stored.meta?.type === 'AZauth') {
                console.log(`Verifying Azuriom account ${stored.name}...`);
                if (!azauthUrl) {
                    await addAccount(stored);
                    if (stored.uuid === selectedAccount) {
                        await accountSelect(stored.uuid, stored);
                    }
                    continue;
                }
                try {
                    const verifiedRaw = await authAzuriomVerify(azauthUrl, stored.access_token);
                    const verified = normalizeAccount(verifiedRaw);

                    if (this.config.email_verified && !verified.user_info?.verified) {
                        await this.database.delete(stored.uuid, 'accounts');
                        if (stored.uuid === selectedAccount) {
                            await this.database.update({ uuid: '1234' }, 'accounts-selected');
                        }
                        continue;
                    }

                    await this.database.update(verified, 'accounts');
                    await addAccount(verified);
                    if (stored.uuid === selectedAccount) {
                        await accountSelect(verified.uuid, verified);
                    }
                } catch (err) {
                    console.error(`[AZauth Account] ${stored.uuid}:`, err);
                    await this.database.delete(stored.uuid, 'accounts');
                    if (stored.uuid === selectedAccount) {
                        await this.database.update({ uuid: '1234' }, 'accounts-selected');
                    }
                }
            }
        }

        const remainingAccounts = await this.database.getAll('accounts');
        if (!remainingAccounts.length) {
            changePanel('login');
            this.hidePreloader();
            return;
        }

        let currentSelected = (await this.database.get('1234', 'accounts-selected'))?.value?.selected;
        if (!currentSelected || !remainingAccounts.some((a) => a.value?.uuid === currentSelected)) {
            const firstAcc = normalizeAccount(remainingAccounts[0]?.value);
            if (firstAcc?.uuid) {
                await this.database.update({ uuid: '1234', selected: firstAcc.uuid }, 'accounts-selected');
                await accountSelect(firstAcc.uuid, firstAcc);
            }
        }

        await this.refreshDataAndPreload();
    }

    hidePreloader() {
        const preloader = document.querySelector('.preload-content');
        if (preloader) {
            preloader.classList.add('fade-out');
            setTimeout(() => {
                preloader.style.display = 'none';
            }, 500);
        }
    }

    async refreshDataAndPreload() {
        const account = await this.getSelectedAccount();
        if (!account) {
            changePanel('login');
            this.hidePreloader();
            return;
        }

        this.activeInstance = await getActiveInstance(this.config, this.database);
        updatePlayerWidgets(account, this.config);
        updatePlayButtonState(account, this.activeInstance, this.config);

        const loadPromises = [];
        if (this.panelInstances?.settings) {
            loadPromises.push(this.panelInstances.settings.initPreviewSkin());
        }
        if (this.panelInstances?.home) {
            loadPromises.push(this.panelInstances.home.refreshInstanceView());
        }
        loadPromises.push(this.preloadBackground(account));
        loadPromises.push(this.preloadNewsImages());

        const timeout = new Promise((resolve) => setTimeout(resolve, 5000));
        await Promise.race([Promise.all(loadPromises), timeout]);

        this.updateBackground(account);
        changePanel('home');
        this.hidePreloader();
    }

    applyAccentColor() {
        if (this.config.accent_color && /^#[0-9a-fA-F]{6}$/.test(this.config.accent_color)) {
            const root = document.documentElement;
            const color = this.config.accent_color;
            root.style.setProperty('--accent-color', color);
            root.style.setProperty('--accent-color-dark', this.darkenColor(color, 15));
            root.style.setProperty('--accent-color-glow', this.hexToRgba(color, 0.4));
            root.style.setProperty('--accent-color-subtle', this.hexToRgba(color, 0.15));
            root.style.setProperty('--border-accent', this.hexToRgba(color, 0.3));
        }
    }

    hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    darkenColor(hex, percent) {
        const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - percent);
        const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - percent);
        const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - percent);
        return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    }

    preloadBackground(account) {
        return new Promise((resolve) => {
            const finalBgUrl = resolveBackgroundUrl(account, this.activeInstance, this.config);
            const img = new Image();
            img.onload = () => resolve();
            img.onerror = () => resolve();
            img.src = finalBgUrl;
        });
    }

    preloadNewsImages() {
        return new Promise((resolve) => {
            const newsImages = document.querySelectorAll('.news-image');
            if (newsImages.length === 0) {
                resolve();
                return;
            }

            let loadedCount = 0;
            const totalImages = newsImages.length;

            newsImages.forEach((newsImg) => {
                const bgImage = newsImg.style.backgroundImage;
                if (bgImage && bgImage !== 'none') {
                    const url = bgImage.replace(/url\(['"]?([^'")]+)['"]?\)/g, '$1');
                    const img = new Image();
                    img.onload = img.onerror = () => {
                        loadedCount++;
                        if (loadedCount >= totalImages) resolve();
                    };
                    img.src = url;
                } else {
                    loadedCount++;
                    if (loadedCount >= totalImages) resolve();
                }
            });
        });
    }

    updateBackground(account) {
        const finalBgUrl = resolveBackgroundUrl(account, this.activeInstance, this.config);

        if (!document.getElementById('bg-transition-overlay')) {
            const overlay = document.createElement('div');
            overlay.id = 'bg-transition-overlay';
            overlay.style.cssText = `
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                z-index: -1; opacity: 0; transition: opacity 0.5s ease;
                background-size: cover; background-position: center;
            `;
            document.body.appendChild(overlay);
        }

        const overlay = document.getElementById('bg-transition-overlay');
        overlay.style.backgroundImage = `linear-gradient(rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0.4)), url("${finalBgUrl}")`;

        requestAnimationFrame(() => {
            overlay.style.opacity = '1';
        });

        setTimeout(() => {
            document.body.style.background = `linear-gradient(rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0.4)), url("${finalBgUrl}") black no-repeat center center scroll`;
            document.body.style.backgroundSize = 'cover';
            overlay.style.opacity = '0';
        }, 550);
    }
}

new Launcher().init();
