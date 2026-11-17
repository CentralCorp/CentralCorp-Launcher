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
    database,
    initTranslations,
    canBypassMaintenance,
    normalizeAccount,
    t,
} from './utils.js';
import {
    checkAppUpdate,
    openMainWindow,
    openExternalUrl,
    closeWindow,
} from './utils/tauri-bridge.js';

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

class Splash {
    constructor() {
        this.splash = document.querySelector('.splash');
        this.splashMessage = document.querySelector('.splash-message');
        this.splashAuthor = document.querySelector('.splash-author');
        this.message = document.querySelector('.message');
        this.progress = document.querySelector('progress');

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.startAnimation());
        } else {
            this.startAnimation();
        }
    }

    async startAnimation() {
        await initTranslations();

        document.getElementById('splash-message').textContent = t('welcome_message');
        document.getElementById('splash-author').textContent = t('developed_by');
        document.getElementById('update-message').textContent = t('checking_updates');

        config.GetConfig().then((res) => {
            if (res && (res.splash || res.splash_author)) {
                if (res.splash) {
                    this.splashMessage.textContent = res.splash;
                }
                if (res.splash_author) {
                    this.splashAuthor.children[0].textContent = `@${res.splash_author}`;
                }
            }
        }).catch(() => {
            // Handled in maintenanceCheck
        });

        await sleep(100);
        document.querySelector('#splash').style.display = 'block';
        await sleep(500);
        this.splash.classList.add('opacity');
        await sleep(500);
        this.splash.classList.add('translate');
        this.splashMessage.classList.add('opacity');
        this.splashAuthor.classList.add('opacity');
        this.message.classList.add('opacity');
        await sleep(800);
        await this.checkUpdate();
    }

    async checkUpdate() {
        this.setStatus(`${t('checking_updates')}...`);
        try {
            const update = await checkAppUpdate();
            if (update && update.update_available && update.download_url) {
                const versionLabel = update.version ? ` (v${update.version})` : '';
                this.setStatus(
                    `${t('update_available')}${versionLabel}<br><div class="download-update">${t('download_update')}</div>`
                );
                const btn = document.querySelector('.download-update');
                if (btn) {
                    btn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        await openExternalUrl(update.download_url);
                        this.shutdown(t('downloading_update'));
                    });
                }
                return;
            }
        } catch (err) {
            console.warn('Update check skipped:', err);
        }

        await this.maintenanceCheck();
    }

    async hasMaintenanceBypassAccount(cfg) {
        try {
            const db = await new database().init();
            const accounts = await db.getAll('accounts');
            for (const entry of accounts) {
                const acc = normalizeAccount(entry?.value);
                if (acc && canBypassMaintenance(acc, cfg)) {
                    return true;
                }
            }
        } catch (_) {
            // Ignore IndexedDB errors on splash
        }
        return false;
    }

    async maintenanceCheck() {
        try {
            const res = await config.GetConfig();
            if (res.maintenance) {
                const bypassed = await this.hasMaintenanceBypassAccount(res);
                if (!bypassed) {
                    return this.shutdown(res.maintenance_message || t('maintenance_active'));
                }
            }
            await this.startLauncher();
        } catch (err) {
            console.error(err);
            return this.shutdown(t('no_internet_connection'));
        }
    }

    async startLauncher() {
        this.setStatus(t('starting_launcher'));
        await openMainWindow();
    }

    shutdown(text) {
        this.setStatus(`${text}<br>${t('shutdown_in')} 5s`);
        let i = 4;
        const timer = setInterval(() => {
            this.setStatus(`${text}<br>${t('shutdown_in')} ${i--}s`);
            if (i < 0) {
                clearInterval(timer);
                closeWindow();
            }
        }, 1000);
    }

    setStatus(text) {
        this.message.innerHTML = text;
    }

    toggleProgress() {
        if (this.progress.classList.toggle('show')) {
            this.setProgress(0, 1);
        }
    }

    setProgress(value, max) {
        this.progress.value = value;
        this.progress.max = max;
    }
}

new Splash();