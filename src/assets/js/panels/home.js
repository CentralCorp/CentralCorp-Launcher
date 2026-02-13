/**
 * @author Luuxis
 * Licensed under CC BY-NC 4.0
 * https://creativecommons.org/licenses/by-nc/4.0/
 *
 * Edited by CentralCorp Team
 */
'use strict';

import { logger, database, changePanel, t } from '../utils.js';
const { Launch, Status } = require('minecraft-java-core-azbetter');
const { ipcRenderer, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const launch = new Launch();
const pkg = require('../package.json');
const settings_url = pkg.user ? `${pkg.settings}/${pkg.user}` : pkg.settings;


const dataDirectory = process.env.APPDATA || (process.platform == 'darwin' ? `${process.env.HOME}/Library/Application Support` : process.env.HOME);
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

class Home {
    static id = "home";

    async init(config, news) {
        this.database = await new database().init();
        this.config = config;
        this.news = await news;

        this.setStaticTexts();
        this.initNews();
        this.initLaunch();
        this.initStatusServer();
        this.initBtn();
        this.initVideo();
        this.initAdvert();
        this.verifyModsBeforeLaunch();
    }

    setStaticTexts() {
        document.getElementById('play-btn').title = t('play');
        document.getElementById('text-download').textContent = t('verification');
        document.getElementById('server-name').textContent = t('offline');
        document.getElementById('server-desc').innerHTML = `<span class="red">${t('closed')}</span>`;
        document.getElementById('video-title').textContent = t('community_video');
        document.getElementById('play-video-btn').innerHTML = '&#9658;';
        document.getElementById('view-video-btn').textContent = t('view_video');
    }

    async initNews() {
        const newsContainer = document.querySelector('.news-list');
        if (this.news) {
            if (!this.news.length) {
                this.createNewsBlock(newsContainer, t('no_news_available'), t('news_follow_here'));
            } else {
                for (const newsItem of this.news) {
                    const date = await this.getDate(newsItem.publish_date);
                    this.createNewsBlock(newsContainer, newsItem.title, newsItem.content, newsItem.author, date, newsItem.image);
                }
            }
        } else {
            this.createNewsBlock(newsContainer, t('error_contacting_server'), t('error_contacting_server'));
        }
        this.setServerIcon();
    }

    createNewsBlock(container, title, content, author = '', date = {}, image = null) {
        const blockNews = document.createElement('div');
        blockNews.classList.add('news-block', 'opacity-1');
        blockNews.innerHTML = `
            <div class="news-header">
                <div class="header-text">
                    <div class="title">${title}</div>
                </div>
                ${date.day ? `<div class="date"><div class="day">${date.day}</div><div class="month">${date.month}</div></div>` : ''}
            </div>
            ${image ? `<div class="news-image" style="background-image: url('${image}');"></div>` : ''}
            <div class="news-content">
                <div class="bbWrapper">
                    <p>${content}</p>
                    ${author ? `<p class="news-author"><span>${author}</span></p>` : ''}
                </div>
            </div>`;
        container.appendChild(blockNews);
    }

    setServerIcon() {
        const serverImg = document.querySelector('.server-img');
        serverImg.setAttribute("src", this.config.server_icon);
        if (!this.config.server_icon) {
            serverImg.style.display = "none";
        }
    }

    async initLaunch() {
        document.querySelector('.play-btn').addEventListener('click', async () => {
            await this.verifyModsBeforeLaunch();
            const opts = await this.getLaunchOptions();
            const playBtn = document.querySelector('.play-btn');
            const info = document.querySelector(".text-download");
            const progressBar = document.querySelector(".progress-bar");

            playBtn.style.display = "none";
            info.style.display = "block";
            launch.Launch(opts);

            const launcherSettings = (await this.database.get('1234', 'launcher')).value;
            this.setupLaunchListeners(launch, info, progressBar, playBtn, launcherSettings);
        });
    }

    async getLaunchOptions() {
        const urlpkg = this.getBaseUrl();
        const uuid = (await this.database.get('1234', 'accounts-selected')).value;
        const account = (await this.database.get(uuid.selected, 'accounts')).value;
        const ram = (await this.database.get('1234', 'ram')).value;
        const javaPath = (await this.database.get('1234', 'java-path')).value;
        const javaArgs = (await this.database.get('1234', 'java-args')).value;
        const resolution = (await this.database.get('1234', 'screen')).value;
        const launcherSettings = (await this.database.get('1234', 'launcher')).value;

        const screen = resolution.screen.width === '<auto>' ? false : { width: resolution.screen.width, height: resolution.screen.height };

        return {
            url: urlpkg,
            authenticator: account,
            timeout: 10000,
            path: `${dataDirectory}/${process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`}`,
            version: this.config.game_version,
            detached: launcherSettings.launcher.close === 'close-all' ? false : true,
            downloadFileMultiple: 30,
            loader: {
                type: this.config.loader.type,
                build: this.config.loader.build,
                enable: this.config.loader.enable,
            },
            verify: this.config.verify,
            ignored: [
                ...(Array.isArray(this.config.ignored) ? this.config.ignored : Object.values(this.config.ignored)),
                "launcher_config",
            ],
            intelEnabledMac: process.platform === 'darwin' && process.arch === 'arm64',
            downloadFileMultiple: 30,
            JVM_ARGS: [],
            GAME_ARGS: [],
            java: this.config.java,
            memory: {
                min: `${ram.ramMin * 1024}M`,
                max: `${ram.ramMax * 1024}M`
            }
        };
    }

    getBaseUrl() {
        const baseUrl = settings_url.endsWith('/') ? settings_url : `${settings_url}/`;
        return pkg.env === 'azuriom' ? `${baseUrl}api/centralcorp/files` : `${baseUrl}data/`;
    }

    setupLaunchListeners(launch, info, progressBar, playBtn, launcherSettings) {
        launch.on('extract', extract => console.log(extract));
        launch.on('progress', (progress, size) => this.updateProgressBar(progressBar, info, progress, size, t('download')));
        launch.on('check', (progress, size) => this.updateProgressBar(progressBar, info, progress, size, t('verification')));
        launch.on('estimated', time => console.log(this.formatTime(time)));
        launch.on('speed', speed => console.log(`${(speed / 1067008).toFixed(2)} Mb/s`));
        launch.on('patch', patch => info.innerHTML = t('patch_in_progress'));
        launch.on('data', e => this.handleLaunchData(e, info, progressBar, playBtn, launcherSettings));
        launch.on('close', code => this.handleLaunchClose(code, info, progressBar, playBtn, launcherSettings));
        launch.on('error', err => console.log(err));
    }

    updateProgressBar(progressBar, info, progress, size, text) {
        progressBar.style.display = "block";
        info.innerHTML = `${text} ${((progress / size) * 100).toFixed(0)}%`;
        ipcRenderer.send('main-window-progress', { progress, size });
        progressBar.value = progress;
        progressBar.max = size;
    }

    formatTime(time) {
        const hours = Math.floor(time / 3600);
        const minutes = Math.floor((time - hours * 3600) / 60);
        const seconds = Math.floor(time - hours * 3600 - minutes * 60);
        return `${hours}h ${minutes}m ${seconds}s`;
    }

    handleLaunchData(e, info, progressBar, playBtn, launcherSettings) {
        new logger('Minecraft', '#36b030');
        if (launcherSettings.launcher.close === 'close-launcher') ipcRenderer.send("main-window-hide");
        ipcRenderer.send('main-window-progress-reset');
        progressBar.style.display = "none";
        info.innerHTML = t('starting');
        console.log(e);
    }

    handleLaunchClose(code, info, progressBar, playBtn, launcherSettings) {
        if (launcherSettings.launcher.close === 'close-launcher') ipcRenderer.send("main-window-show");
        progressBar.style.display = "none";
        info.style.display = "none";
        playBtn.style.display = "block";
        info.innerHTML = t('verification');
        new logger('Launcher', '#7289da');
        console.log('Close');
    }

    async initStatusServer() {
        const nameServer = document.querySelector('.server-text .name');
        const serverMs = document.querySelector('.server-text .desc');
        const playersConnected = document.querySelector('.etat-text .text');
        const online = document.querySelector(".etat-text .online");

        let ip = this.config.status.ip;
        let port = this.config.status.port;

        if (!port) {
            try {
                const dns = require('dns');
                const srvRecords = await new Promise((resolve, reject) => {
                    dns.resolveSrv(`_minecraft._tcp.${ip}`, (err, records) => {
                        if (err) reject(err);
                        else resolve(records);
                    });
                });
                if (srvRecords && srvRecords.length > 0) {
                    ip = srvRecords[0].name;
                    port = srvRecords[0].port;
                }
            } catch (e) {
                port = 25565;
            }
        }

        try {
            const serverPing = await new Status(ip, port).getStatus();
            if (!serverPing.error) {
                nameServer.textContent = this.config.status.nameServer;
                serverMs.innerHTML = `<span class="green">${t('server_online')}</span> - ${serverPing.ms}${t('server_ping')}`;
                online.classList.toggle("off");
                playersConnected.textContent = serverPing.playersConnect;
            } else {
                nameServer.textContent = t('server_unavailable');
                serverMs.innerHTML = `<span class="red">${t('server_closed')}</span>`;
            }
        } catch (e) {
            nameServer.textContent = t('server_unavailable');
            serverMs.innerHTML = `<span class="red">${t('server_closed')}</span>`;
        }
    }

    async initVideo() {
        const videoContainer = document.querySelector('.ytb');
        if (!this.config.video_activate) {
            videoContainer.style.display = 'none';
            return;
        }

        const youtubeVideoId = this.config.video_url;
        const videoType = this.config.video_type;
        let youtubeEmbedUrl;

        if (videoType === 'short') {
            youtubeEmbedUrl = `https://www.youtube.com/embed/${youtubeVideoId}?autoplay=1&playsinline=1`;
        } else if (videoType === 'video') {
            youtubeEmbedUrl = `https://www.youtube.com/embed/${youtubeVideoId}?autoplay=1`;
        } else {
            console.error('Invalid video type specified in the configuration.');
            return;
        }

        const youtubeThumbnailUrl = `https://img.youtube.com/vi/${youtubeVideoId}/hqdefault.jpg`;
        const videoThumbnail = videoContainer.querySelector('.youtube-thumbnail');
        const thumbnailImg = videoThumbnail.querySelector('.thumbnail-img');
        const playButton = videoThumbnail.querySelector('.ytb-play-btn');
        const btn = videoContainer.querySelector('.ytb-btn');

        btn.addEventListener('click', () => shell.openExternal(`https://youtube.com/watch?v=${youtubeVideoId}`));

        if (thumbnailImg && playButton) {
            thumbnailImg.src = youtubeThumbnailUrl;
            videoThumbnail.addEventListener('click', () => {
                videoThumbnail.innerHTML = `<iframe width="500" height="290" src="${youtubeEmbedUrl}" frameborder="0" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"></iframe>`;
            });
        }
    }

    async initAdvert() {
        const advertBanner = document.querySelector('.advert-banner');
        if (this.config.alert_activate) {
            const message = this.config.alert_msg;
            const firstParagraph = message.split('</p>')[0] + '</p>';
            const scrollingText = document.createElement('div');
            scrollingText.classList.add('scrolling-text');
            scrollingText.innerHTML = `${firstParagraph}`;
            advertBanner.innerHTML = '';
            advertBanner.appendChild(scrollingText);
            scrollingText.classList.toggle('no-scroll', !this.config.alert_scroll);
            advertBanner.style.display = 'block';
        } else {
            advertBanner.style.display = 'none';
        }
    }

    initBtn() {
        document.querySelector('.settings-btn').addEventListener('click', () => {
            changePanel('settings');
        });
    }

    async getDate(e) {
        const date = new Date(e);
        const year = date.getFullYear();
        const month = date.getMonth();
        const day = date.getDate();
        const months = [
            t('january'), t('february'), t('march'), t('april'), t('may'), t('june'),
            t('july'), t('august'), t('september'), t('october'), t('november'), t('december')
        ];
        return { year, month: months[month], day };
    }

    async verifyModsBeforeLaunch() {
        const modsDir = path.join(dataDirectory, process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`, 'mods');
        const launcherConfigDir = path.join(dataDirectory, process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`, 'launcher_config');
        const modsConfigFile = path.join(launcherConfigDir, 'mods_config.json');

        if (!fs.existsSync(modsDir) || !fs.existsSync(modsConfigFile)) {
            console.log("Mods directory or config not found, skipping mod verification (first launch).");
            return;
        }

        let modsConfig;
        try {
            modsConfig = JSON.parse(fs.readFileSync(modsConfigFile));
        } catch (error) {
            console.error("Failed to read mods config file:", error);
            return;
        }

        for (const mod in modsConfig) {
            const modFiles = fs.readdirSync(modsDir).filter(file => file.startsWith(mod) && (file.endsWith('.jar') || file.endsWith('.jar-disable')));
            if (modFiles.length > 0) {
                const modFile = modFiles[0];
                const modFilePath = path.join(modsDir, modFile);
                const newModFilePath = modsConfig[mod] ? modFilePath.replace('.jar-disable', '.jar') : modFilePath.endsWith('.jar-disable') ? modFilePath : `${modFilePath}.disable`;
                if (modFilePath !== newModFilePath) {
                    fs.renameSync(modFilePath, newModFilePath);
                }
            }
        }
    }

    displayEmptyModsMessage(modsListElement) {
        const modElement = document.createElement('div');
        modElement.innerHTML = `
            <div class="mods-container-empty">
              <h2>${t('optional_mods_not_downloaded')}</h2>
            </div>`;
        modsListElement.appendChild(modElement);
    }

    updateRole(account) {
        const tooltipRole = document.querySelector('.player-tooltip-role');
        const sidebarRole = document.querySelector('.player-role');

        if (this.config.role && account.user_info.role) {
            const roleName = account.user_info.role.name;
            tooltipRole.textContent = roleName;
            sidebarRole.textContent = roleName;
        } else {
            tooltipRole.style.display = 'none';
            sidebarRole.style.display = 'none';
        }
    }

    updateWhitelist(account) {
        const playBtn = document.querySelector(".play-btn");
        if (this.config.whitelist_activate &&
            (!this.config.whitelist.includes(account.name) &&
                !this.config.whitelist_roles.includes(account.user_info.role.name))) {
            playBtn.style.background = "#696969";
            playBtn.style.pointerEvents = "none";
            playBtn.style.boxShadow = "none";
            playBtn.style.opacity = "0.6";
            playBtn.title = t('unavailable');
        } else {
            playBtn.style.background = "";
            playBtn.style.pointerEvents = "auto";
            playBtn.style.boxShadow = "";
            playBtn.style.opacity = "1";
            playBtn.title = t('play');
        }
    }
}

export default Home;