/**
 * @author Luuxis
 * @license CC-BY-NC 4.0 - https://creativecommons.org/licenses/by-nc/4.0/
 */

'use strict';

// libs 
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
                document.querySelector(".preload-content").style.display = "none";
                return;
            }
            changePanel("home");
            this.refreshData();
        }
        document.querySelector(".preload-content").style.display = "none";
    }

    async refreshData() {
        document.querySelector('.player-role').innerHTML = '';
        document.querySelector('.player-monnaie').innerHTML = '';
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
        if (this.config.role && account.user_info.role) {
            const blockRole = document.createElement("div");
            blockRole.innerHTML = `<div>${t('grade')}: ${account.user_info.role.name}</div>`;
            document.querySelector('.player-role').appendChild(blockRole);
        } else {
            document.querySelector(".player-role").style.display = "none";
        }
    }

    updateMoney(account) {
        if (this.config.money) {
            const blockMonnaie = document.createElement("div");
            blockMonnaie.innerHTML = `<div>${account.user_info.monnaie} pts</div>`;
            document.querySelector('.player-monnaie').appendChild(blockMonnaie);
        } else {
            document.querySelector(".player-monnaie").style.display = "none";
        }
    }

    updateWhitelist(account) {
        const playBtn = document.querySelector(".play-btn");
        if (this.config.whitelist_activate && 
            (!this.config.whitelist.includes(account.name) &&
             !this.config.whitelist_roles.includes(account.user_info.role.name))) {
            playBtn.style.backgroundColor = "#696969";
            playBtn.style.pointerEvents = "none";
            playBtn.style.boxShadow = "none";
            playBtn.textContent = t('unavailable');
        } else {
            playBtn.style.backgroundColor = "#f8b704";
            playBtn.style.pointerEvents = "auto";
            playBtn.style.boxShadow = "2px 2px 5px rgba(0, 0, 0, 0.3)";
            playBtn.textContent = t('play');
        }
    }

    updateBackground(account) {
        if (this.config.role_data) {
            for (const roleKey in this.config.role_data) {
                if (this.config.role_data.hasOwnProperty(roleKey)) {
                    const role = this.config.role_data[roleKey];
                    if (account.user_info.role.name === role.name) {
                        const backgroundUrl = role.background;
                        document.body.style.background = urlPattern.test(backgroundUrl) 
                            ? `linear-gradient(rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0.4)), url(${backgroundUrl}) black no-repeat center center scroll`
                            : `linear-gradient(rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0.4)), url("../src/assets/images/background/light.jpg") black no-repeat center center scroll`;
                        break;
                    }
                }
            }
        }
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


