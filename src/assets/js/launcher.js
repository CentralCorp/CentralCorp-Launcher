/**
 * @author Luuxis
 * Licensed under CC BY-NC 4.0
 * https://creativecommons.org/licenses/by-nc/4.0/
 *
 * Edited by CentralCorp Team
 */
'use strict';
const fs = require('fs');
const { Microsoft, Mojang, AZauth } = require('minecraft-java-core-azbetter');
const pkg = require('../package.json');
const { ipcRenderer } = require('electron');
const DiscordRPC = require('discord-rpc');

import { config, logger, changePanel, database, addAccount, accountSelect, t } from './utils.js';
import Login from './panels/login.js';
import Home from './panels/home.js';
import Settings from './panels/settings.js';

const settings_url = pkg.user ? `${pkg.settings}/${pkg.user}` : pkg.settings;
const urlPattern = /^(https?:\/\/)/;

class Launcher {
    async init() {
        this.initLog();
        console.log("Initializing Launcher...");
        if (process.platform === "win32") this.initFrame();
        this.config = await config.GetConfig();
        this.applyAccentColor();
        this.news = await config.GetNews();
        this.database = await new database().init();
        this.createPanels(Login, Home, Settings);
        this.getAccounts();
        this.initDiscordRPC();
    }

    initLog() {
        document.addEventListener("keydown", (e) => {
            if ((e.ctrlKey && e.shiftKey && e.keyCode === 73) || e.keyCode === 123) {
                ipcRenderer.send("main-window-dev-tools");
            }
        });
        new logger('Launcher', '#7289da');
    }

    initDiscordRPC() {
        if (this.config.rpc_activation) {
            const rpc = new DiscordRPC.Client({ transport: 'ipc' });
            rpc.on('ready', () => {
                const presence = {
                    details: this.config.rpc_details,
                    state: this.config.rpc_state,
                    largeImageKey: this.config.rpc_large_image,
                    largeImageText: this.config.rpc_large_text,
                    smallImageKey: this.config.rpc_small_image,
                    smallImageText: this.config.rpc_small_text,
                    buttons: [
                        { label: this.config.rpc_button1, url: this.config.rpc_button1_url },
                        { label: this.config.rpc_button2, url: this.config.rpc_button2_url }
                    ]
                };
                rpc.setActivity(presence);
            });
            rpc.login({ clientId: this.config.rpc_id }).catch(console.error);
        }
    }

    initFrame() {
        console.log("Initializing Frame...");
        document.querySelector(".frame").classList.toggle("hide");
        document.querySelector(".dragbar").classList.toggle("hide");

        document.querySelector("#minimize").addEventListener("click", () => {
            ipcRenderer.send("main-window-minimize");
        });

        let maximized = false;
        const maximize = document.querySelector("#maximize");
        maximize.addEventListener("click", () => {
            ipcRenderer.send("main-window-maximize");
            maximized = !maximized;
            maximize.classList.toggle("icon-maximize");
            maximize.classList.toggle("icon-restore-down");
        });

        document.querySelector("#close").addEventListener("click", () => {
            ipcRenderer.send("main-window-close");
        });
    }

    createPanels(...panels) {
        const panelsElem = document.querySelector(".panels");
        for (const panel of panels) {
            console.log(`Initializing ${panel.name} Panel...`);
            const div = document.createElement("div");
            div.classList.add("panel", panel.id);
            div.innerHTML = fs.readFileSync(`${__dirname}/panels/${panel.id}.html`, "utf8");
            panelsElem.appendChild(div);
            new panel().init(this.config, this.news);
        }
    }

    async getAccounts() {
        const baseUrl = settings_url.endsWith('/') ? settings_url : `${settings_url}/`;
        const AZAuth = new AZauth(this.getAzAuthUrl());
        const accounts = await this.database.getAll('accounts');
        const selectedAccount = (await this.database.get('1234', 'accounts-selected'))?.value?.selected;

        if (!accounts.length) {
            changePanel("login");
            this.hidePreloader();
        } else {
            for (let account of accounts) {
                account = account.value;
                if (account.meta.type === 'AZauth') {
                    const refresh = await AZAuth.verify(account);
                    console.log(refresh);
                    console.log(`Initializing Mojang account ${account.name}...`);

                    if (refresh.error) {
                        this.database.delete(account.uuid, 'accounts');
                        if (account.uuid === selectedAccount) this.database.update({ uuid: "1234" }, 'accounts-selected');
                        console.error(`[Account] ${account.uuid}: ${refresh.errorMessage}`);
                        continue;
                    }

                    const refreshAccounts = {
                        access_token: refresh.access_token,
                        client_token: refresh.uuid,
                        uuid: refresh.uuid,
                        name: refresh.name,
                        user_properties: refresh.user_properties,
                        meta: {
                            type: refresh.meta.type,
                            offline: refresh.meta.offline
                        },
                        user_info: {
                            role: refresh.user_info.role,
                            monnaie: refresh.user_info.money,
                            verified: refresh.user_info.verified,
                        },
                    };

                    if (this.config.email_verified && !account.user_info.verified) {
                        this.database.delete(account.uuid, 'accounts');
                        if (account.uuid === selectedAccount) this.database.update({ uuid: "1234" }, 'accounts-selected');
                    }

                    this.database.update(refreshAccounts, 'accounts');
                    addAccount(refreshAccounts);
                    if (account.uuid === selectedAccount) accountSelect(refresh.uuid);
                } else {
                    this.database.delete(account.uuid, 'accounts');
                    if (account.uuid === selectedAccount) this.database.update({ uuid: "1234" }, 'accounts-selected');
                }
            }

            if (!(await this.database.get('1234', 'accounts-selected')).value.selected) {
                const uuid = (await this.database.getAll('accounts'))[0]?.value?.uuid;
                if (uuid) {
                    this.database.update({ uuid: "1234", selected: uuid }, 'accounts-selected');
                    accountSelect(uuid);
                }
            }

            if ((await this.database.getAll('accounts')).length === 0) {
                changePanel("login");
                this.hidePreloader();
                return;
            }
            await this.refreshDataAndPreload();
        }
    }

    hidePreloader() {
        const preloader = document.querySelector(".preload-content");
        if (preloader) {
            preloader.classList.add('fade-out');
            setTimeout(() => {
                preloader.style.display = "none";
            }, 500);
        }
    }

    async refreshDataAndPreload() {
        document.querySelector('.player-role').innerHTML = '';
        document.querySelector('.player-monnaie').innerHTML = '';
        document.querySelector('.player-tooltip-role').innerHTML = '';

        const loadPromises = [];
        loadPromises.push(this.initPreviewSkin());

        const uuid = (await this.database.get('1234', 'accounts-selected')).value;
        const account = (await this.database.get(uuid.selected, 'accounts')).value;

        this.updateRole(account);
        this.updateMoney(account);
        this.updateWhitelist(account);

        loadPromises.push(this.preloadBackground(account));
        loadPromises.push(this.preloadNewsImages());

        const timeout = new Promise(resolve => setTimeout(resolve, 5000));
        await Promise.race([
            Promise.all(loadPromises),
            timeout
        ]);
        this.updateBackground(account);
        changePanel("home");
        this.hidePreloader();
    }

    async refreshData() {
        document.querySelector('.player-role').innerHTML = '';
        document.querySelector('.player-monnaie').innerHTML = '';
        document.querySelector('.player-tooltip-role').innerHTML = '';
        await this.initPreviewSkin();
        await this.initOthers();
    }

    async initPreviewSkin() {
        console.log('initPreviewSkin called');
        const baseUrl = settings_url.endsWith('/') ? settings_url : `${settings_url}/`;
        const azauth = this.getAzAuthUrl();
        const uuid = (await this.database.get('1234', 'accounts-selected')).value;
        const account = (await this.database.get(uuid.selected, 'accounts')).value;

        document.querySelector('.player-skin-title').innerHTML = `Skin de ${account.name}`;
        document.querySelector('.skin-renderer-settings').src = `${azauth}skin3d/3d-api/skin-api/${account.name}`;
    }

    async initOthers() {
        const uuid = (await this.database.get('1234', 'accounts-selected')).value;
        const account = (await this.database.get(uuid.selected, 'accounts')).value;

        this.updateRole(account);
        this.updateMoney(account);
        this.updateWhitelist(account);
        this.updateBackground(account);
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

    updateMoney(account) {
        const monnaieEl = document.querySelector('.player-monnaie');
        if (this.config.money) {
            monnaieEl.textContent = `${account.user_info.monnaie} pts`;
        } else {
            monnaieEl.style.display = 'none';
        }
    }

    applyAccentColor() {
        if (this.config.accent_color) {
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

    preloadBackground(account) {
        return new Promise((resolve) => {
            const defaultBg = '../src/assets/images/background/light.jpg';
            let backgroundUrl = null;

            if (this.config.role_data && account.user_info && account.user_info.role) {
                for (const roleKey in this.config.role_data) {
                    if (this.config.role_data.hasOwnProperty(roleKey)) {
                        const role = this.config.role_data[roleKey];
                        if (account.user_info.role.name === role.name && role.background) {
                            const urlPattern = /^(https?:\/\/)/;
                            if (urlPattern.test(role.background)) {
                                backgroundUrl = role.background;
                            }
                            break;
                        }
                    }
                }
            }

            const finalBgUrl = backgroundUrl || defaultBg;
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

            newsImages.forEach(newsImg => {
                const bgImage = newsImg.style.backgroundImage;
                if (bgImage && bgImage !== 'none') {
                    const url = bgImage.replace(/url\(['"]?([^'"\)]+)['"]?\)/g, '$1');
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
        const defaultBg = '../src/assets/images/background/light.jpg';
        let backgroundUrl = null;

        if (this.config.role_data && account.user_info && account.user_info.role) {
            for (const roleKey in this.config.role_data) {
                if (this.config.role_data.hasOwnProperty(roleKey)) {
                    const role = this.config.role_data[roleKey];
                    if (account.user_info.role.name === role.name && role.background) {
                        const urlPattern = /^(https?:\/\/)/;
                        if (urlPattern.test(role.background)) {
                            backgroundUrl = role.background;
                        }
                        break;
                    }
                }
            }
        }

        const finalBgUrl = backgroundUrl || defaultBg;

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
        overlay.style.backgroundImage = `linear-gradient(rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0.4)), url(${finalBgUrl})`;

        requestAnimationFrame(() => {
            overlay.style.opacity = '1';
        });

        setTimeout(() => {
            document.body.style.background = `linear-gradient(rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0.4)), url(${finalBgUrl}) black no-repeat center center scroll`;
            document.body.style.backgroundSize = 'cover';
            overlay.style.opacity = '0';
        }, 550);
    }
    getAzAuthUrl() {
        const baseUrl = settings_url.endsWith('/') ? settings_url : `${settings_url}/`;
        return pkg.env === 'azuriom'
            ? baseUrl
            : this.config.azauth.endsWith('/')
                ? this.config.azauth
                : `${this.config.azauth}/`;
    }
}

new Launcher().init();

document.getElementById('preload-title').textContent = t('loading');


