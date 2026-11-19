/**
 * @author Luuxis
 * Licensed under CC BY-NC 4.0
 * https://creativecommons.org/licenses/by-nc/4.0/
 *
 * Edited by CentralCorp Team
 */
'use strict';

import {
    logger,
    database,
    changePanel,
    escapeHtml,
    sanitizeHtml,
    stripHtmlToText,
    normalizeAccount,
    ensureFreshMicrosoftAccount,
    getInstancesList,
    isInstanceModded,
    resolveInstanceRam,
    getActiveInstance,
    setActiveInstance,
    evaluateInstanceAccess,
    updatePlayButtonState,
    t,
} from '../utils.js';
import {
    getLauncherMeta,
    resolveGameRoot,
    getSystemMemory,
    pingMinecraftServer,
    syncOptionalMods,
    launchInstance,
    listen,
    hideWindow,
    showWindow,
    setWindowProgress,
    resetWindowProgress,
    openExternalUrl,
} from '../utils/tauri-bridge.js';

function extractYoutubeId(raw) {
    if (!raw) return '';
    const str = String(raw).trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(str)) return str;
    try {
        const u = new URL(str);
        if (u.hostname.includes('youtu.be')) {
            return u.pathname.replace(/^\//, '').split('/')[0];
        }
        if (u.searchParams.has('v')) {
            return u.searchParams.get('v');
        }
        const parts = u.pathname.split('/').filter(Boolean);
        const embedIdx = parts.findIndex((p) => p === 'embed' || p === 'shorts' || p === 'v');
        if (embedIdx !== -1 && parts[embedIdx + 1]) {
            return parts[embedIdx + 1];
        }
    } catch (_) {
        // Fallback regex
    }
    const match = str.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : '';
}

class Home {
    static id = 'home';

    async init(config, newsOrPromise) {
        const [db, meta] = await Promise.all([new database().init(), getLauncherMeta()]);
        this.database = db;
        this.meta = meta;
        this.config = config;
        this.news = null;
        this.isLaunching = false;
        this._hasHandledFirstData = false;
        this._statusSeq = 0;
        this._newsClickBound = false;
        this._youtubeEmbedUrl = null;
        this._youtubeThumbnailUrl = null;
        this.unlistenLaunch = null;
        this.activeInstance = await getActiveInstance(this.config, this.database);

        this.setStaticTexts();
        this.initInstanceSelector();
        this.setServerIcon();
        this.initLaunch();
        this.initBtn();
        this.initVideo();
        this.initAdvert();

        // Non-blocking async hydration: Home appears immediately without waiting on news or TCP pings
        this.loadNewsAsync(newsOrPromise);
        this.initStatusServer();
        this.verifyModsBeforeLaunch();

        window.addEventListener('account-changed', () => {
            this.renderInstanceSelector();
        });

        window.addEventListener('panel-changed', (e) => {
            if (e.detail?.panel !== 'home') {
                this.unloadYoutubeIframe();
            }
        });

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.unloadYoutubeIframe();
            }
        });
    }

    setStaticTexts() {
        document.getElementById('play-btn').title = t('play');
        document.getElementById('text-download').textContent = t('verification');
        document.getElementById('server-name').textContent = t('offline');
        document.getElementById('server-desc').innerHTML = `<span class="red">${escapeHtml(t('closed'))}</span>`;
        document.getElementById('video-title').textContent = t('community_video');
        document.getElementById('play-video-btn').textContent = '\u25B6';
        document.getElementById('view-video-btn').textContent = t('view_video');
        const popoverHeader = document.getElementById('instance-popover-header');
        if (popoverHeader) popoverHeader.textContent = t('select_instance');
    }

    async getSelectedAccount() {
        const selectedUuid = (await this.database.get('1234', 'accounts-selected'))?.value?.selected;
        if (!selectedUuid) return null;
        const rec = await this.database.get(selectedUuid, 'accounts');
        return rec?.value ? normalizeAccount(rec.value) : null;
    }

    // -----------------------------------------------------------------------
    // Ergonomic Multi-Instance Selector & Floating Popover
    // -----------------------------------------------------------------------

    initInstanceSelector() {
        const btn = document.getElementById('instance-selector-btn');
        const popover = document.getElementById('instance-popover');
        const wrapper = document.getElementById('instance-selector-wrapper');
        if (!btn || !popover || !wrapper) return;

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.isLaunching) return;
            const isOpen = popover.classList.toggle('open');
            btn.classList.toggle('open', isOpen);
            btn.setAttribute('aria-expanded', String(isOpen));
            if (isOpen) {
                this.renderInstanceSelector();
            }
        });

        document.addEventListener('click', (e) => {
            if (!wrapper.contains(e.target)) {
                this.closeInstancePopover();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeInstancePopover();
            }
        });

        this.renderInstanceSelector();
    }

    closeInstancePopover() {
        const btn = document.getElementById('instance-selector-btn');
        const popover = document.getElementById('instance-popover');
        if (popover) popover.classList.remove('open');
        if (btn) {
            btn.classList.remove('open');
            btn.setAttribute('aria-expanded', 'false');
        }
    }

    async renderInstanceSelector() {
        const instances = getInstancesList(this.config);
        const btn = document.getElementById('instance-selector-btn');
        const iconImg = document.getElementById('instance-selector-icon');
        const fallbackSvg = document.getElementById('instance-selector-svg');
        const listEl = document.getElementById('instance-popover-list');
        if (!btn || !listEl) return;

        const [active, account] = await Promise.all([
            getActiveInstance(this.config, this.database),
            this.getSelectedAccount(),
        ]);
        this.activeInstance = active;

        // Update sidebar trigger button icon & tooltip
        const activeIcon = active?.icon || active?.server_icon || null;
        if (activeIcon && iconImg && fallbackSvg) {
            iconImg.src = activeIcon;
            iconImg.style.display = 'block';
            fallbackSvg.style.display = 'none';
            iconImg.onerror = () => {
                iconImg.style.display = 'none';
                fallbackSvg.style.display = 'block';
            };
        } else if (iconImg && fallbackSvg) {
            iconImg.style.display = 'none';
            fallbackSvg.style.display = 'block';
        }

        const activeAccess = evaluateInstanceAccess(account, active, this.config);
        btn.classList.toggle('locked-instance', activeAccess.locked);
        btn.title = active?.name
            ? `${t('select_instance')} • ${active.name}`
            : t('select_instance');

        // Render instance cards in popover
        const fragment = document.createDocumentFragment();
        for (const inst of instances) {
            const isCurrent = active && inst.slug === active.slug;
            const access = evaluateInstanceAccess(account, inst, this.config);
            const loaderLabel = inst.loader?.enable && inst.loader?.type
                ? inst.loader.type
                : 'Vanilla';
            const cardIcon = inst.icon || inst.server_icon || null;
            const cleanDesc = inst.description ? stripHtmlToText(inst.description) : '';

            const card = document.createElement('div');
            card.className = `instance-card${isCurrent ? ' active' : ''}`;
            card.setAttribute('role', 'option');
            card.setAttribute('aria-selected', String(Boolean(isCurrent)));

            const lockBadgeHtml = access.locked
                ? `<span class="instance-meta-pill locked">${escapeHtml(
                    access.reason === 'maintenance'
                        ? t('instance_maintenance')
                        : t('instance_whitelisted')
                )}</span>`
                : '';

            card.innerHTML = `
                <div class="instance-card-icon-wrap">
                    ${
                        cardIcon
                            ? `<img src="${escapeHtml(cardIcon)}" alt="${escapeHtml(inst.name || '')}" loading="lazy" decoding="async" />`
                            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>`
                    }
                </div>
                <div class="instance-card-body">
                    <div class="instance-card-title">${escapeHtml(inst.name || inst.slug)}</div>
                    ${cleanDesc ? `<div class="instance-card-desc">${escapeHtml(cleanDesc)}</div>` : ''}
                    <div class="instance-card-badges">
                        <span class="instance-meta-pill">${escapeHtml(inst.game_version || '')}</span>
                        <span class="instance-meta-pill loader">${escapeHtml(loaderLabel)}</span>
                        ${lockBadgeHtml}
                    </div>
                </div>
                <span class="instance-card-check"></span>
            `;

            const imgTag = card.querySelector('img');
            if (imgTag) {
                imgTag.onerror = () => {
                    imgTag.parentElement.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>`;
                };
            }

            card.addEventListener('click', async (e) => {
                e.stopPropagation();
                this.closeInstancePopover();
                if (active && inst.slug === active.slug) return;
                this.activeInstance = await setActiveInstance(inst.slug, this.config, this.database);
                await this.refreshInstanceView();
            });

            fragment.appendChild(card);
        }

        listEl.innerHTML = '';
        listEl.appendChild(fragment);
    }

    async refreshInstanceView() {
        const [active, account] = await Promise.all([
            getActiveInstance(this.config, this.database),
            this.getSelectedAccount(),
        ]);
        this.activeInstance = active;
        await this.renderInstanceSelector();
        this.setServerIcon();
        updatePlayButtonState(account, this.activeInstance, this.config);

        // Run server ping and optional mods pre-sync asynchronously without blocking UI
        this.initStatusServer();
        this.verifyModsBeforeLaunch();
    }

    // -----------------------------------------------------------------------
    // News Feed (RSS + Panel JSON + Sanitized HTML + Lazy Images)
    // -----------------------------------------------------------------------

    async loadNewsAsync(newsOrPromise) {
        const newsContainer = document.querySelector('.news-list');
        if (!newsContainer) return;

        if (!this._newsClickBound) {
            this._newsClickBound = true;
            newsContainer.addEventListener('click', (e) => {
                const link = e.target.closest('a[href]');
                if (!link) return;
                e.preventDefault();
                const href = link.getAttribute('href');
                if (href && /^https?:\/\//i.test(href)) {
                    openExternalUrl(href);
                }
            });
        }

        try {
            this.news = await newsOrPromise;
        } catch (err) {
            console.warn('News load failed:', err);
            this.news = null;
        }

        newsContainer.innerHTML = '';
        const fragment = document.createDocumentFragment();

        if (Array.isArray(this.news)) {
            if (!this.news.length) {
                this.createNewsBlock(
                    fragment,
                    t('no_news_available'),
                    `<p>${escapeHtml(t('news_follow_here'))}</p>`
                );
            } else {
                for (const newsItem of this.news) {
                    const date = this.getDate(newsItem.publish_date);
                    this.createNewsBlock(
                        fragment,
                        newsItem.title,
                        newsItem.content,
                        newsItem.author,
                        date,
                        newsItem.image,
                        newsItem.badge,
                        newsItem.external_url,
                        Boolean(newsItem.is_pinned)
                    );
                }
            }
        } else {
            this.createNewsBlock(
                fragment,
                t('error_contacting_server'),
                `<p>${escapeHtml(t('error_contacting_server'))}</p>`
            );
        }

        newsContainer.appendChild(fragment);
    }

    createNewsBlock(
        container,
        title,
        content,
        author = '',
        date = {},
        image = null,
        badge = null,
        externalUrl = null,
        isPinned = false
    ) {
        const blockNews = document.createElement('div');
        blockNews.classList.add('news-block', 'opacity-1');
        const safeTitle = escapeHtml(title);
        const pinHtml = isPinned
            ? `<span class="news-pin-badge"><i class="fas fa-thumbtack"></i>${escapeHtml(t('pinned'))}</span>`
            : '';
        const badgeHtml = badge ? `<span class="news-badge">${escapeHtml(badge)}</span>` : '';
        const titleInner = externalUrl && /^https?:\/\//i.test(externalUrl)
            ? `<a href="${escapeHtml(externalUrl)}" rel="noopener noreferrer">${safeTitle}</a>${pinHtml}${badgeHtml}`
            : `${safeTitle}${pinHtml}${badgeHtml}`;

        const safeImage = image && /^https?:\/\//i.test(String(image).trim()) ? String(image).trim() : null;
        const safeContent = sanitizeHtml(content || '');

        blockNews.innerHTML = `
            <div class="news-header">
                <div class="header-text">
                    <div class="title">${titleInner}</div>
                </div>
                ${date.day ? `<div class="date"><div class="day">${escapeHtml(date.day)}</div><div class="month">${escapeHtml(date.month)}</div></div>` : ''}
            </div>
            ${safeImage ? `<img class="news-image" src="${escapeHtml(safeImage)}" alt="" loading="lazy" decoding="async" />` : ''}
            <div class="news-content">
                <div class="bbWrapper">
                    <div>${safeContent}</div>
                    ${author ? `<p class="news-author"><span>${escapeHtml(author)}</span></p>` : ''}
                </div>
            </div>`;

        const imgEl = blockNews.querySelector('img.news-image');
        if (imgEl) {
            imgEl.onerror = () => {
                imgEl.remove();
            };
        }

        container.appendChild(blockNews);
    }

    setServerIcon() {
        const serverImg = document.querySelector('.server-img');
        if (!serverImg) return;
        const iconUrl =
            this.activeInstance?.server_icon ||
            this.activeInstance?.icon ||
            this.config.server_icon;
        if (iconUrl) {
            serverImg.setAttribute('src', iconUrl);
            serverImg.style.display = '';
            serverImg.onerror = () => {
                serverImg.style.display = 'none';
            };
        } else {
            serverImg.style.display = 'none';
        }
    }

    // -----------------------------------------------------------------------
    // Game Launch & Real-Time Rust LaunchEvent Streaming
    // -----------------------------------------------------------------------

    async initLaunch() {
        const playBtn = document.querySelector('.play-btn');
        const info = document.querySelector('.text-download');
        const progressBar = document.querySelector('.progress-bar');

        if (!this.unlistenLaunch) {
            this.unlistenLaunch = await listen('launch-event', (event) => {
                this.onLaunchEvent(event, info, progressBar, playBtn);
            });
        }

        playBtn.addEventListener('click', async () => {
            if (this.isLaunching) return;

            this.activeInstance = await getActiveInstance(this.config, this.database);
            let account = await this.getSelectedAccount();
            const access = evaluateInstanceAccess(account, this.activeInstance, this.config);
            if (access.locked) {
                updatePlayButtonState(account, this.activeInstance, this.config);
                return;
            }

            this.isLaunching = true;
            this._hasHandledFirstData = false;
            this.closeInstancePopover();

            playBtn.style.display = 'none';
            info.style.display = 'block';
            info.textContent = t('verification');

            try {
                // Refresh expiring Microsoft access token right before launch if needed
                if (account?.meta?.type === 'Microsoft') {
                    try {
                        account = await ensureFreshMicrosoftAccount(
                            account,
                            this.config,
                            this.meta,
                            this.database
                        );
                        if (account?.user_info?.banned) {
                            throw new Error(t('account_banned'));
                        }
                    } catch (refreshErr) {
                        const msg = String(refreshErr?.message || refreshErr || '').toLowerCase();
                        if (
                            msg.includes('user_banned') ||
                            msg.includes('banned') ||
                            msg.includes('invalid_grant') ||
                            msg.includes('unauthorized')
                        ) {
                            throw refreshErr;
                        }
                        console.warn('Proceeding with cached Microsoft token after transient refresh error:', refreshErr);
                    }
                }

                await this.verifyModsBeforeLaunch();

                const launcherSettings = (await this.database.get('1234', 'launcher'))?.value;
                this.currentCloseBehavior = launcherSettings?.launcher?.close || 'close-launcher';
                const opts = await this.getLaunchOptions(this.currentCloseBehavior, account);
                const moddeEnabled = isInstanceModded(this.activeInstance, this.config);
                const modsUrl = moddeEnabled
                    ? this.activeInstance?.mods_url || this.getFallbackModsUrl(this.activeInstance?.slug)
                    : null;

                await launchInstance(opts, this.currentCloseBehavior, modsUrl);
            } catch (err) {
                console.error('Launch failed:', err);
                this.handleLaunchError(err?.message || String(err), info, progressBar, playBtn);
            }
        });
    }

    onLaunchEvent(event, info, progressBar, playBtn) {
        if (!event || !event.type) return;
        const closeBehavior = this.currentCloseBehavior || 'close-launcher';

        switch (event.type) {
            case 'check':
                this.updateProgressBar(
                    progressBar,
                    info,
                    event.current,
                    event.total,
                    t('verification')
                );
                break;
            case 'progress':
                this.updateProgressBar(
                    progressBar,
                    info,
                    event.downloaded,
                    event.total,
                    t('download')
                );
                break;
            case 'extract':
                if (event.message) console.log(event.message);
                info.textContent = t('extraction') || t('verification');
                break;
            case 'estimated':
                if (typeof event.seconds_remaining === 'number' && Number.isFinite(event.seconds_remaining)) {
                    console.log(this.formatTime(event.seconds_remaining));
                }
                break;
            case 'speed':
                if (typeof event.bytes_per_sec === 'number') {
                    console.log(`${(event.bytes_per_sec / 1048576).toFixed(2)} MB/s`);
                }
                break;
            case 'patch':
                info.textContent = t('patch_in_progress');
                if (event.line) console.log(event.line);
                break;
            case 'data':
                this.handleLaunchData(event.line, info, progressBar, playBtn, closeBehavior);
                break;
            case 'close':
                this.handleLaunchClose(event.exit_code, info, progressBar, playBtn, closeBehavior);
                break;
            case 'error':
                this.handleLaunchError(event.message, info, progressBar, playBtn);
                break;
            default:
                break;
        }
    }

    async getLaunchOptions(closeBehavior, accountOverride = null) {
        const inst = this.activeInstance || (await getActiveInstance(this.config, this.database));
        const [account, mem, javaPathRec, javaArgsRec, resolutionRec] = await Promise.all([
            accountOverride ? Promise.resolve(accountOverride) : this.getSelectedAccount(),
            getSystemMemory().catch(() => ({ total_gb: 8, free_gb: 4 })),
            this.database.get('1234', 'java-path'),
            this.database.get('1234', 'java-args'),
            this.database.get('1234', 'screen'),
        ]);

        const ram = await resolveInstanceRam(
            inst,
            this.config,
            this.database,
            mem?.total_gb || 8
        );
        const javaPath = javaPathRec?.value;
        const javaArgs = javaArgsRec?.value;
        const resolution = resolutionRec?.value;

        const rawIgnored = inst?.ignored ?? this.config.ignored ?? [];
        const ignoredArr = Array.isArray(rawIgnored) ? rawIgnored : Object.values(rawIgnored);
        const ignored = Array.from(new Set([...ignoredArr.map(String), 'launcher_config']));

        const instJvmArgs = Array.isArray(inst?.jvm_args) ? inst.jvm_args : [];
        const userJvmArgs = Array.isArray(javaArgs?.args) ? javaArgs.args : [];
        const instGameArgs = Array.isArray(inst?.game_args) ? inst.game_args : [];

        const screenRaw = resolution?.screen;
        const screen =
            !screenRaw || screenRaw.width === '<auto>'
                ? { width: null, height: null, fullscreen: false }
                : {
                    width: Number(screenRaw.width) || 1280,
                    height: Number(screenRaw.height) || 720,
                    fullscreen: Boolean(screenRaw.fullscreen),
                };

        const statusObj = inst?.status || this.config.status || {};
        const cleanIp = String(statusObj.ip || '').trim();
        const autoConnect =
            Boolean(inst?.auto_connect ?? this.config.auto_connect) && cleanIp
                ? {
                    host: cleanIp,
                    port: Number(statusObj.port) || 25565,
                }
                : null;

        const gameRoot = resolveGameRoot(this.meta, this.config.dataDirectory);
        const filesUrl = inst?.files_url || this.getFallbackFilesUrl(inst?.slug);
        const moddeEnabled = isInstanceModded(inst, this.config);
        const gameVersion = String(inst?.game_version || this.config.game_version || '1.20.1');
        const isLegacyMacIntelOnly = /^1\.([0-9]|1[0-8])(\.|$)/.test(gameVersion);
        const useEmbeddedJava = Boolean(inst?.java ?? this.config.java ?? true);

        return {
            url: moddeEnabled ? filesUrl : null,
            authenticator: account,
            timeout_ms: 15000,
            path: gameRoot,
            version: gameVersion,
            instance: String(inst?.slug || 'default'),
            detached: closeBehavior !== 'close-all',
            intel_enabled_mac:
                this.meta.platform === 'darwin' && this.meta.arch === 'arm64' && isLegacyMacIntelOnly,
            concurrent_downloads: 30,
            bypass_offline: false,
            loader: {
                type: inst?.loader?.type || this.config.loader?.type || 'forge',
                build: inst?.loader?.build || this.config.loader?.build || 'latest',
                enable: Boolean(inst?.loader?.enable ?? this.config.loader?.enable),
            },
            mcp: null,
            verify: Boolean(inst?.verify ?? this.config.verify),
            ignored,
            jvm_args: [...instJvmArgs, ...userJvmArgs],
            game_args: instGameArgs,
            auto_connect: autoConnect,
            java: {
                path: javaPath?.path ? String(javaPath.path) : useEmbeddedJava ? null : 'system',
                version: inst?.java_version ? String(inst.java_version) : null,
                type: 'jre',
            },
            screen,
            memory: {
                min: `${Math.max(512, Math.round(ram.ramMin * 1024))}M`,
                max: `${Math.max(512, Math.round(ram.ramMax * 1024))}M`,
            },
        };
    }

    getFallbackFilesUrl(slug) {
        const rawSettings = this.meta?.settings_url || '';
        const base = rawSettings.endsWith('/') ? rawSettings : `${rawSettings}/`;
        if (slug && slug !== 'default') {
            return this.meta?.env === 'azuriom'
                ? `${base}api/centralcorp/instances/${slug}/files`
                : `${base}utils/instances/${slug}/files`;
        }
        return this.meta?.env === 'azuriom' ? `${base}api/centralcorp/files` : `${base}data/`;
    }

    getFallbackModsUrl(slug) {
        const rawSettings = this.meta?.settings_url || '';
        const base = rawSettings.endsWith('/') ? rawSettings : `${rawSettings}/`;
        if (slug && slug !== 'default') {
            return this.meta?.env === 'azuriom'
                ? `${base}api/centralcorp/instances/${slug}/mods`
                : `${base}utils/instances/${slug}/mods`;
        }
        return this.meta?.env === 'azuriom' ? `${base}api/centralcorp/mods` : `${base}utils/mods`;
    }

    updateProgressBar(progressBar, info, progress, size, text) {
        if (!size || size <= 0) return;
        progressBar.style.display = 'block';
        const pct = Math.min(100, Math.max(0, Math.round((progress / size) * 100)));
        info.textContent = `${text} ${pct}%`;
        setWindowProgress(progress, size);
        progressBar.value = progress;
        progressBar.max = size;
    }

    formatTime(time) {
        const hours = Math.floor(time / 3600);
        const minutes = Math.floor((time - hours * 3600) / 60);
        const seconds = Math.floor(time - hours * 3600 - minutes * 60);
        return `${hours}h ${minutes}m ${seconds}s`;
    }

    handleLaunchData(line, info, progressBar, playBtn, closeBehavior) {
        // Perform window & UI transition ONCE on first game stdout line instead of spamming IPC per line
        if (!this._hasHandledFirstData) {
            this._hasHandledFirstData = true;
            new logger('Minecraft', '#36b030');
            if (closeBehavior === 'close-launcher') {
                this.unloadYoutubeIframe();
                hideWindow();
            }
            resetWindowProgress();
            progressBar.style.display = 'none';
            info.textContent = t('starting');
        }
        if (line) console.log(line);
    }

    handleLaunchClose(code, info, progressBar, playBtn, closeBehavior) {
        this.isLaunching = false;
        this._hasHandledFirstData = false;
        if (closeBehavior === 'close-launcher') {
            showWindow().catch(() => {});
        }
        resetWindowProgress();
        progressBar.style.display = 'none';
        info.style.display = 'none';
        playBtn.style.display = '';
        info.textContent = t('verification');
        new logger('Launcher', '#7289da');
        console.log(`Minecraft exited with code ${code}`);
        window.dispatchEvent(
            new CustomEvent('instance-launched-closed', {
                detail: { slug: this.activeInstance?.slug || 'default' },
            })
        );
    }

    handleLaunchError(message, info, progressBar, playBtn) {
        this.isLaunching = false;
        this._hasHandledFirstData = false;
        // Always restore window visibility if an error occurred after hiding the launcher
        showWindow().catch(() => {});
        resetWindowProgress();
        progressBar.style.display = 'none';
        info.style.display = 'none';
        playBtn.style.display = '';
        info.textContent = t('verification');
        new logger('Launcher', '#7289da');
        console.error('Launch error:', message);
    }

    // -----------------------------------------------------------------------
    // Server Status Ping (Sequenced Rust TCP + Solo Mode Support)
    // -----------------------------------------------------------------------

    async initStatusServer() {
        const seq = ++this._statusSeq;
        const nameServer = document.querySelector('.server-text .name');
        const serverMs = document.querySelector('.server-text .desc');
        const playersConnected = document.querySelector('.etat-text .text');
        const online = document.querySelector('.etat-text .online');
        if (!nameServer || !serverMs || !playersConnected || !online) return;

        const statusCfg = this.activeInstance?.status || this.config.status || {};
        const ip = String(statusCfg.ip || '').trim();
        const port = Number(statusCfg.port) || 25565;
        const displayName =
            statusCfg.nameServer || this.activeInstance?.name || t('server_unavailable');

        // Empty IP = Solo / Singleplayer instance (do not display red "Server Closed")
        if (!ip) {
            nameServer.textContent =
                statusCfg.nameServer || this.activeInstance?.name || 'Minecraft';
            serverMs.innerHTML = `<span>${escapeHtml(t('solo_mode'))}</span>`;
            playersConnected.textContent = '';
            online.classList.remove('off');
            online.classList.add('solo');
            return;
        }

        const setOffline = () => {
            if (seq !== this._statusSeq) return;
            nameServer.textContent = statusCfg.nameServer || this.activeInstance?.name || t('server_unavailable');
            serverMs.innerHTML = `<span class="red">${escapeHtml(t('server_closed'))}</span>`;
            playersConnected.textContent = '0';
            online.classList.remove('solo');
            online.classList.add('off');
        };

        try {
            const data = await pingMinecraftServer(ip, port);
            if (seq !== this._statusSeq) return;

            if (data && data.online) {
                nameServer.textContent = displayName;
                const latencySuffix =
                    typeof data.latency_ms === 'number' && data.latency_ms > 0
                        ? ` • ${Math.round(data.latency_ms)} ${t('server_ping')}`
                        : '';
                serverMs.innerHTML = `<span class="green">${escapeHtml(`${t('server_online')}${latencySuffix}`)}</span>`;
                online.classList.remove('off', 'solo');

                const onlinePlayers = data.players_online ?? data.players?.online ?? 0;
                const maxPlayers = data.players_max ?? data.players?.max ?? null;
                playersConnected.textContent = maxPlayers
                    ? `${onlinePlayers}/${maxPlayers}`
                    : `${onlinePlayers}`;
            } else {
                setOffline();
            }
        } catch (err) {
            console.warn('Server ping failed:', err);
            setOffline();
        }
    }

    unloadYoutubeIframe() {
        const videoThumbnail = document.querySelector('.ytb .youtube-thumbnail');
        if (!videoThumbnail || !this._youtubeThumbnailUrl) return;
        if (!videoThumbnail.querySelector('iframe')) return;

        videoThumbnail.innerHTML = `
            <img class="thumbnail-img" src="${escapeHtml(this._youtubeThumbnailUrl)}" alt="YouTube Thumbnail" loading="lazy" decoding="async" />
            <button class="ytb-play-btn" id="play-video-btn">&#9658;</button>
        `;
    }

    initVideo() {
        const videoContainer = document.querySelector('.ytb');
        if (!videoContainer) return;

        if (!this.config.video_activate || !this.config.video_url) {
            videoContainer.style.display = 'none';
            return;
        }

        const youtubeVideoId = extractYoutubeId(this.config.video_url);
        if (!youtubeVideoId) {
            videoContainer.style.display = 'none';
            return;
        }

        const videoType = String(this.config.video_type || 'video').toLowerCase();
        let youtubeEmbedUrl;
        let youtubeExternalUrl;

        if (videoType === 'short' || videoType === 'shorts') {
            youtubeEmbedUrl = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtubeVideoId)}?autoplay=1&playsinline=1`;
            youtubeExternalUrl = `https://www.youtube.com/shorts/${encodeURIComponent(youtubeVideoId)}`;
        } else if (videoType === 'video') {
            youtubeEmbedUrl = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtubeVideoId)}?autoplay=1`;
            youtubeExternalUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeVideoId)}`;
        } else {
            videoContainer.style.display = 'none';
            return;
        }

        this._youtubeEmbedUrl = youtubeEmbedUrl;
        this._youtubeThumbnailUrl = `https://img.youtube.com/vi/${encodeURIComponent(youtubeVideoId)}/hqdefault.jpg`;

        const videoThumbnail = videoContainer.querySelector('.youtube-thumbnail');
        const thumbnailImg = videoThumbnail?.querySelector('.thumbnail-img');
        const btn = videoContainer.querySelector('.ytb-btn');

        if (btn) {
            btn.addEventListener('click', () => {
                openExternalUrl(youtubeExternalUrl);
            });
        }

        if (videoThumbnail && thumbnailImg) {
            thumbnailImg.src = this._youtubeThumbnailUrl;
            thumbnailImg.loading = 'lazy';
            thumbnailImg.decoding = 'async';

            videoThumbnail.addEventListener('click', () => {
                if (videoThumbnail.querySelector('iframe')) return;
                videoThumbnail.innerHTML = `<iframe width="500" height="290" src="${escapeHtml(youtubeEmbedUrl)}" frameborder="0" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
            });
        }
    }

    initAdvert() {
        const advertBanner = document.querySelector('.advert-banner');
        if (!advertBanner) return;

        if (this.config.alert_activate && this.config.alert_msg) {
            const message = String(this.config.alert_msg);
            const firstParagraph = message.includes('</p>')
                ? `${message.split('</p>')[0]}</p>`
                : message;
            const scrollingText = document.createElement('div');
            scrollingText.classList.add('scrolling-text');
            scrollingText.innerHTML = sanitizeHtml(firstParagraph);
            advertBanner.innerHTML = '';
            advertBanner.appendChild(scrollingText);
            scrollingText.classList.toggle('no-scroll', !this.config.alert_scroll);
            advertBanner.style.display = 'flex';
        } else {
            advertBanner.style.display = 'none';
        }
    }

    initBtn() {
        document.querySelector('.settings-btn').addEventListener('click', () => {
            changePanel('settings');
        });
    }

    getDate(rawDate) {
        if (!rawDate) return {};
        const date = new Date(rawDate);
        if (Number.isNaN(date.getTime())) return {};
        const year = date.getFullYear();
        const month = date.getMonth();
        const day = date.getDate();
        const months = [
            t('january'),
            t('february'),
            t('march'),
            t('april'),
            t('may'),
            t('june'),
            t('july'),
            t('august'),
            t('september'),
            t('october'),
            t('november'),
            t('december'),
        ];
        return { year, month: months[month] || '', day };
    }

    async verifyModsBeforeLaunch() {
        try {
            const inst = this.activeInstance || (await getActiveInstance(this.config, this.database));
            if (!isInstanceModded(inst, this.config)) {
                return;
            }
            const slug = inst?.slug || 'default';
            const gameRoot = resolveGameRoot(this.meta, this.config.dataDirectory);
            const modsUrl = inst?.mods_url || this.getFallbackModsUrl(slug);
            await syncOptionalMods(gameRoot, slug, modsUrl);
        } catch (err) {
            console.warn('Skipping optional mods pre-launch sync:', err);
        }
    }
}

export default Home;
