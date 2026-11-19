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
    initTranslations,
    applyAccentColor,
    stripHtmlToText,
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
        // Run translations, remote config bootstrap (?include=news,mods), and update check in parallel
        // alongside a crisp ~380ms splash animation instead of 1,900ms sequential sleeps.
        const translationsReady = initTranslations().then(() => {
            const msgEl = document.getElementById('splash-message');
            const authorEl = document.getElementById('splash-author');
            const updEl = document.getElementById('update-message');
            if (msgEl && !this._customSplashApplied) msgEl.textContent = t('welcome_message');
            if (authorEl) authorEl.textContent = t('developed_by');
            if (updEl) updEl.textContent = t('checking_updates');
        });

        const configPromise = config.GetConfig().then((cfg) => {
            if (cfg) {
                applyAccentColor(cfg);
                if (cfg.splash) {
                    this._customSplashApplied = true;
                    this.splashMessage.textContent = cfg.splash;
                }
                if (cfg.splash_author && this.splashAuthor?.children?.[0]) {
                    this.splashAuthor.children[0].textContent = `@${cfg.splash_author}`;
                }
            }
            return cfg;
        });

        const updatePromise = checkAppUpdate().catch((err) => {
            console.warn('Update check skipped:', err);
            return null;
        });

        const visualTransition = (async () => {
            const splashSvg = document.querySelector('#splash');
            if (splashSvg) splashSvg.style.display = 'block';
            await sleep(60);
            this.splash.classList.add('opacity');
            await sleep(140);
            this.splash.classList.add('translate');
            this.splashMessage.classList.add('opacity');
            this.splashAuthor.classList.add('opacity');
            this.message.classList.add('opacity');
            await sleep(180);
        })();

        const [, configSettled, updateResult] = await Promise.all([
            translationsReady,
            configPromise.then(
                (value) => ({ ok: true, value }),
                (error) => ({ ok: false, error })
            ),
            updatePromise,
            visualTransition,
        ]);

        if (updateResult && updateResult.update_available && updateResult.download_url) {
            this.renderUpdatePrompt(updateResult);
            return;
        }

        if (!configSettled.ok || !configSettled.value) {
            console.error(configSettled.error);
            this.shutdown(t('no_internet_connection'));
            return;
        }

        const cfg = configSettled.value;
        if (cfg.maintenance) {
            // Proceed into main window so staff / maintenance_bypass accounts can log in or verify
            // live roles, while non-bypass players see the clear maintenance notice on Login/Home.
            const notice = stripHtmlToText(cfg.maintenance_message) || t('maintenance_active');
            this.setStatusText(notice);
        } else {
            this.setStatusText(t('starting_launcher'));
        }

        await openMainWindow();
    }

    renderUpdatePrompt(update) {
        const versionLabel = update.version ? ` (v${update.version})` : '';
        this.message.textContent = '';

        const labelNode = document.createTextNode(`${t('update_available')}${versionLabel}`);
        const br = document.createElement('br');
        const btn = document.createElement('div');
        btn.className = 'download-update';
        btn.textContent = t('download_update');
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await openExternalUrl(update.download_url);
            this.shutdown(t('downloading_update'));
        });

        this.message.append(labelNode, br, btn);
    }

    shutdown(text) {
        const cleanText = stripHtmlToText(text);
        const renderCountdown = (secLeft) => {
            this.message.textContent = '';
            this.message.append(
                document.createTextNode(cleanText),
                document.createElement('br'),
                document.createTextNode(`${t('shutdown_in')} ${secLeft}s`)
            );
        };

        renderCountdown(5);
        let i = 4;
        const timer = setInterval(() => {
            if (i < 0) {
                clearInterval(timer);
                closeWindow();
                return;
            }
            renderCountdown(i--);
        }, 1000);
    }

    setStatusText(text) {
        this.message.textContent = String(text ?? '');
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