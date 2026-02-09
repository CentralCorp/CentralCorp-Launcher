/**
 * @author Luuxis
 * Licensed under CC BY-NC 4.0
 * https://creativecommons.org/licenses/by-nc/4.0/
 *
 * Edited by CentralCorp Team
 */
'use strict';

import { database, changePanel, accountSelect, Slider, showLoadingOverlay, hideLoadingOverlay, t } from '../utils.js';
const dataDirectory = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + '/Library/Application Support' : process.env.HOME);

const os = require('os');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const pkg = require('../package.json');
const { ipcRenderer, shell } = require('electron');
const settings_url = pkg.user ? `${pkg.settings}/${pkg.user}` : pkg.settings;

class Settings {
    static id = "settings";

    async init(config) {
        this.config = config;
        this.database = await new database().init();
        this.initSettingsDefault();
        this.initTab();
        this.initAccount();
        this.initRam();
        this.initLauncherSettings();
        this.updateModsConfig();
        this.initOptionalMods();
        this.headplayer();
        this.initSkinDropzone();
    }

    initSkinDropzone() {
        const dropzone = document.getElementById('skinDropzone');
        const fileInput = document.getElementById('fileInput');

        if (!dropzone || !fileInput) return;

        dropzone.addEventListener('click', () => {
            fileInput.click();
        });

        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                await this.handleSkinFile(file);
            }
        });

        dropzone.addEventListener('dragenter', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.add('drag-over');
        });

        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.add('drag-over');
        });

        dropzone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove('drag-over');
        });

        dropzone.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove('drag-over');

            const files = e.dataTransfer.files;
            if (files.length > 0) {
                await this.handleSkinFile(files[0]);
            }
        });
    }

    async handleSkinFile(file) {
        if (!file) return;

        if (file.type !== 'image/png') {
            alert(t('error_png_required'));
            return;
        }

        const img = new Image();
        img.src = URL.createObjectURL(file);
        img.onload = async () => {
            if (img.width !== 64 || img.height !== 64) {
                alert(t('error_skin_size'));
                return;
            }

            const dropzone = document.getElementById('skinDropzone');
            dropzone.classList.add('upload-success');

            await this.processSkinChange(file);

            setTimeout(() => {
                dropzone.classList.remove('upload-success');
            }, 2000);
        };
    }

    async refreshData() {
        document.querySelector('.player-role').innerHTML = '';
        document.querySelector('.player-monnaie').innerHTML = '';
        await this.initOthers();
        await this.initPreviewSkin();
        await this.updateAccountImage();
        hideLoadingOverlay();
    }

    async headplayer() {
        const uuid = (await this.database.get('1234', 'accounts-selected')).value;
        const account = (await this.database.get(uuid.selected, 'accounts')).value;
        const pseudo = account.name;
        const azauth = this.getAzAuthUrl();
        const timestamp = new Date().getTime();
        const skin_url = `${azauth}api/skin-api/avatars/face/${pseudo}/?t=${timestamp}`;
        document.querySelector(".player-head").style.backgroundImage = `url(${skin_url})`;
    }

    async updateAccountImage() {
        const uuid = (await this.database.get('1234', 'accounts-selected')).value;
        const account = (await this.database.get(uuid.selected, 'accounts')).value;
        const azauth = this.getAzAuthUrl();
        const timestamp = new Date().getTime();

        const accountDiv = document.getElementById(account.uuid);
        if (accountDiv) {
            const accountImage = accountDiv.querySelector('.account-image');
            if (accountImage) {
                accountImage.src = `${azauth}api/skin-api/avatars/face/${account.name}/?t=${timestamp}`;
            } else {
                console.error('Image not found in the selected account div.');
            }
        } else {
            console.error(`No div found with UUID: ${account.uuid}`);
        }
    }

    async initOthers() {
        const uuid = (await this.database.get('1234', 'accounts-selected')).value;
        const account = (await this.database.get(uuid.selected, 'accounts')).value;

        this.updateRole(account);
        this.updateMoney(account);
        this.updateWhitelist(account);
        await this.updateBackground(account);
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
            playBtn.style.background = "#696969";
            playBtn.style.pointerEvents = "none";
            playBtn.style.boxShadow = "none";
            playBtn.textContent = t('unavailable');
        } else {
            playBtn.style.background = "";
            playBtn.style.pointerEvents = "auto";
            playBtn.style.boxShadow = "";
            playBtn.style.opacity = "1";
            playBtn.textContent = t('play');
        }
    }

    updateBackground(account) {
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
            img.onload = () => {
                document.body.style.background = `linear-gradient(rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0.4)), url(${finalBgUrl}) black no-repeat center center scroll`;
                document.body.style.backgroundSize = 'cover';
                resolve();
            };

            img.onerror = () => {
                document.body.style.background = `linear-gradient(rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0.4)), url(${defaultBg}) black no-repeat center center scroll`;
                document.body.style.backgroundSize = 'cover';
                resolve();
            };

            img.src = finalBgUrl;
        });
    }

    initAccount() {
        document.querySelector('.accounts').addEventListener('click', async (e) => {
            const path = e.composedPath();
            const uuid = e.target.id;
            const selectedaccount = await this.database.get('1234', 'accounts-selected');

            if (path[0].classList.contains('account')) {
                showLoadingOverlay();
                accountSelect(uuid);
                await this.database.update({ uuid: "1234", selected: uuid }, 'accounts-selected');
                await this.refreshData();
            }

            if (e.target.classList.contains("account-delete")) {
                const accountElement = path[1];
                this.database.delete(accountElement.id, 'accounts');
                document.querySelector('.accounts').removeChild(accountElement);

                if (!document.querySelector('.accounts').children.length) {
                    changePanel("login");
                    return;
                }

                if (accountElement.id === selectedaccount?.value?.selected) {
                    const allAccounts = await this.database.getAll('accounts');
                    if (Array.isArray(allAccounts) && allAccounts.length > 0) {
                        const newUuid = allAccounts[0]?.value?.uuid;
                        if (newUuid) {
                            this.database.update({ uuid: "1234", selected: newUuid }, 'accounts-selected');
                            accountSelect(newUuid);
                        }
                    } else {
                        changePanel("login");
                    }
                }
            }
        });


        document.querySelector('.add-account').addEventListener('click', () => {
            document.querySelector(".cancel-login").style.display = "contents";
            changePanel("login");
        });
    }

    async initRam() {
        const ramDatabase = (await this.database.get('1234', 'ram'))?.value;
        const totalMem = Math.trunc(os.totalmem() / 1073741824 * 10) / 10;
        const freeMem = Math.trunc(os.freemem() / 1073741824 * 10) / 10;

        document.getElementById("total-ram").textContent = `${totalMem} Go RAM`;
        document.getElementById("free-ram").textContent = `${freeMem} Go RAM disponible`;

        const sliderDiv = document.querySelector(".memory-slider");
        sliderDiv.setAttribute("max", Math.trunc((80 * totalMem) / 100));

        const ram = ramDatabase ? ramDatabase : { ramMin: this.config.ram_min, ramMax: this.config.ram_max };
        const slider = new Slider(".memory-slider", parseFloat(ram.ramMin), parseFloat(ram.ramMax));

        const minSpan = document.querySelector(".slider-touch-left span");
        const maxSpan = document.querySelector(".slider-touch-right span");

        minSpan.setAttribute("value", `${ram.ramMin} Go`);
        maxSpan.setAttribute("value", `${ram.ramMax} Go`);

        slider.on("change", (min, max) => {
            minSpan.setAttribute("value", `${min} Go`);
            maxSpan.setAttribute("value", `${max} Go`);
            this.database.update({ uuid: "1234", ramMin: `${min}`, ramMax: `${max}` }, 'ram');
        });
    }

    async updateModsConfig() {
        const modsDir = path.join(`${dataDirectory}/${process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`}`, 'mods');
        const launcherConfigDir = path.join(`${dataDirectory}/${process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`}`, 'launcher_config');
        const modsConfigFile = path.join(launcherConfigDir, 'mods_config.json');

        const baseUrl = settings_url.endsWith('/') ? settings_url : `${settings_url}/`;
        const response = await fetch(pkg.env === 'azuriom' ? `${baseUrl}api/centralcorp/mods` : `${baseUrl}utils/mods`);
        const apiMods = await response.json();
        const apiModsSet = new Set(apiMods.optionalMods);

        let localModsConfig;
        try {
            localModsConfig = JSON.parse(fs.readFileSync(modsConfigFile));
        } catch (error) {
            await this.createModsConfig(modsConfigFile);
            localModsConfig = JSON.parse(fs.readFileSync(modsConfigFile));
        }

        for (const localMod in localModsConfig) {
            if (!apiModsSet.has(localMod)) {
                if (!localModsConfig[localMod]) {
                    const modFiles = fs.readdirSync(modsDir).filter(file => file.startsWith(localMod) && file.endsWith('.jar-disable'));
                    if (modFiles.length > 0) {
                        const modFile = modFiles[0];
                        const modFilePath = path.join(modsDir, modFile);
                        const newModFilePath = modFilePath.replace('.jar-disable', '.jar');
                        fs.renameSync(modFilePath, newModFilePath);
                    }
                }
                delete localModsConfig[localMod];
            }
        }

        apiMods.optionalMods.forEach(apiMod => {
            if (!(apiMod in localModsConfig)) {
                localModsConfig[apiMod] = true;
            }
        });

        fs.writeFileSync(modsConfigFile, JSON.stringify(localModsConfig, null, 2));
    }

    async initOptionalMods() {
        const modsDir = path.join(`${dataDirectory}/${process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`}`, 'mods');
        const launcherConfigDir = path.join(`${dataDirectory}/${process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`}`, 'launcher_config');
        const modsConfigFile = path.join(launcherConfigDir, 'mods_config.json');
        const modsListElement = document.getElementById('mods-list');

        if (!fs.existsSync(launcherConfigDir)) {
            fs.mkdirSync(launcherConfigDir, { recursive: true });
        }

        if (!fs.existsSync(modsDir) || fs.readdirSync(modsDir).length === 0) {
            this.displayEmptyModsMessage(modsListElement);
            if (!fs.existsSync(modsConfigFile)) {
                await this.createModsConfig(modsConfigFile);
            }
        } else {
            await this.displayMods(modsConfigFile, modsDir, modsListElement);
        }
    }

    displayEmptyModsMessage(modsListElement) {
        const modElement = document.createElement('div');
        modElement.innerHTML = `
            <div class="mods-container-empty">
              <h2>⚠️ Les mods optionnels n'ont pas encore étés téléchargés. Veuillez lancer une première fois le jeu pour pouvoir les configurer, puis redémarrez le launcher. ⚠️<h2>
            </div>`;
        modsListElement.appendChild(modElement);
    }

    async createModsConfig(modsConfigFile) {
        const baseUrl = settings_url.endsWith('/') ? settings_url : `${settings_url}/`;
        const response = await fetch(pkg.env === 'azuriom' ? `${baseUrl}api/centralcorp/mods` : `${baseUrl}utils/mods`);
        const data = await response.json();
        const modsConfig = {};

        data.optionalMods.forEach(mod => {
            modsConfig[mod] = true;
        });

        fs.writeFileSync(modsConfigFile, JSON.stringify(modsConfig, null, 2));
    }

    async displayMods(modsConfigFile, modsDir, modsListElement) {
        let modsConfig;

        try {
            modsConfig = JSON.parse(fs.readFileSync(modsConfigFile));
        } catch (error) {
            await this.createModsConfig(modsConfigFile);
            modsConfig = JSON.parse(fs.readFileSync(modsConfigFile));
        }

        const baseUrl = settings_url.endsWith('/') ? settings_url : `${settings_url}/`;
        const response = await fetch(pkg.env === 'azuriom' ? `${baseUrl}api/centralcorp/mods` : `${baseUrl}utils/mods`);
        const data = await response.json();

        if (!data.optionalMods || !data.mods) {
            console.error('La réponse API ne contient pas "optionalMods" ou "mods".');
            return;
        }

        data.optionalMods.forEach(mod => {
            const modElement = document.createElement('div');
            const modInfo = data.mods[mod];
            if (!modInfo) {
                console.error(`Les informations pour le mod "${mod}" sont manquantes dans "mods".`);
                modElement.innerHTML = `
                <div class="mods-container">
                  <h2>${t('mod_info_missing_admin').replace('${mod}', mod)}<h2>
                   <div class="switch">
                      <label class="switch-label">
                        <input type="checkbox" id="${mod}" name="mod" value="${mod}" ${modsConfig[mod] ? 'checked' : ''}>
                        <span class="slider round"></span>
                      </label>
                  </div>
                </div>
                <hr>`;
                return;
            }

            const modName = modInfo.name;
            const modDescription = modInfo.description || t('no_mod_description');
            const modLink = modInfo.icon;
            const modRecommanded = modInfo.recommanded;

            modElement.innerHTML = `
                <div class="mods-container">
                  ${modLink ? `<img src="${modLink}" class="mods-icon" alt="${modName} logo">` : ''}
                  <div class="mods-container-text">
                    <div class="mods-container-name">                    
                        <h2>${modName}</h2>
                        <div class="mods-recommanded" style="display: none;">${t('recommended')}</div>
                    </div>
                    <div class="mod-description">${modDescription}</div>
                  </div>
                  <div class="switch">
                    <label class="switch-label">
                      <input type="checkbox" id="${mod}" name="mod" value="${mod}" ${modsConfig[mod] ? 'checked' : ''}>
                      <span class="slider round"></span>
                    </label>
                  </div>
                </div>
                <hr>
            `;

            if (modRecommanded) {
                modElement.querySelector('.mods-recommanded').style.display = 'block';
            }

            modElement.querySelector('input').addEventListener('change', (e) => {
                this.toggleMod(mod, e.target.checked, modsConfig, modsDir, modsConfigFile);
            });

            modsListElement.appendChild(modElement);
        });
    }

    async toggleMod(mod, enabled, modsConfig, modsDir, modsConfigFile) {
        const modFiles = fs.readdirSync(modsDir).filter(file => file.startsWith(mod) && (file.endsWith('.jar') || file.endsWith('.jar-disable')));

        if (modFiles.length > 0) {
            const modFile = modFiles[0];
            const modFilePath = path.join(modsDir, modFile);
            const newModFilePath = enabled ? modFilePath.replace('.jar-disable', '.jar') : modFilePath.replace('.jar', '.jar-disable');

            fs.renameSync(modFilePath, newModFilePath);

            modsConfig[mod] = enabled;
            fs.writeFileSync(modsConfigFile, JSON.stringify(modsConfig, null, 2));
        }
    }

    async selectFile() {
        const input = document.getElementById('fileInput');
        input.click();

        input.onchange = async () => {
            const file = input.files[0];
            if (!file) return;
            if (file.type !== 'image/png') {
                alert(t('error_png_required'));
                return;
            }
            const img = new Image();
            img.src = URL.createObjectURL(file);
            img.onload = async () => {
                if (img.width !== 64 || img.height !== 64) {
                    alert(t('error_skin_size'));
                    return;
                }

                await this.processSkinChange.bind(this)(file);
            };
        };
    }

    async processSkinChange(file) {
        if (!file) {
            console.error('No file provided');
            return;
        }
        const azauth = this.getAzAuthUrl();
        let uuid = (await this.database.get('1234', 'accounts-selected')).value;
        let account = (await this.database.get(uuid.selected, 'accounts')).value;
        const access_token = account.access_token;
        const formData = new FormData();
        formData.append('access_token', access_token);
        formData.append('skin', file);
        const xhr = new XMLHttpRequest();

        xhr.open('POST', `${azauth}api/skin-api/skins/update`, true);

        xhr.onload = async () => {
            console.log(`XHR Response: ${xhr.response}`);
            if (xhr.status === 200) {
                console.log('Skin updated successfully!');
                await this.initPreviewSkin();
                await this.headplayer();
            } else {
                console.error(`Failed to update skin. Status code: ${xhr.status}`);
            }
        };

        xhr.onerror = () => {
            console.error('Request failed');
        };

        xhr.send(formData);
    }

    async initPreviewSkin() {
        console.log('initPreviewSkin called');
        const azauth = this.getAzAuthUrl();
        let uuid = (await this.database.get('1234', 'accounts-selected')).value;
        let account = (await this.database.get(uuid.selected, 'accounts')).value;

        let title = document.querySelector('.player-skin-title');
        title.innerHTML = `Skin de ${account.name}`;

        const skin = document.querySelector('.skin-renderer-settings');
        const cacheBuster = new Date().getTime();
        const url = `${azauth}skin3d/3d-api/skin-api/${account.name}`;
        skin.src = url;
    }

    async initResolution() {
        let resolutionDatabase = (await this.database.get('1234', 'screen'))?.value?.screen;
        let resolution = resolutionDatabase ? resolutionDatabase : { width: "1280", height: "720" };

        let width = document.querySelector(".width-size");
        width.value = resolution.width;

        let height = document.querySelector(".height-size");
        height.value = resolution.height;

        let select = document.getElementById("select");
        select.addEventListener("change", (event) => {
            let resolution = select.options[select.options.selectedIndex].value.split(" x ");
            select.options.selectedIndex = 0;

            width.value = resolution[0];
            height.value = resolution[1];
            this.database.update({ uuid: "1234", screen: { width: resolution[0], height: resolution[1] } }, 'screen');
        });
    }

    async initLauncherSettings() {
        let launcherDatabase = (await this.database.get('1234', 'launcher'))?.value;
        let settingsLauncher = {
            uuid: "1234",
            launcher: {
                close: launcherDatabase?.launcher?.close || 'close-launcher'
            }
        }

        let closeLauncher = document.getElementById("launcher-close");
        let closeAll = document.getElementById("launcher-close-all");
        let openLauncher = document.getElementById("launcher-open");

        if (settingsLauncher.launcher.close === 'close-launcher') {
            closeLauncher.checked = true;
        } else if (settingsLauncher.launcher.close === 'close-all') {
            closeAll.checked = true;
        } else if (settingsLauncher.launcher.close === 'open-launcher') {
            openLauncher.checked = true;
        }

        closeLauncher.addEventListener("change", () => {
            if (closeLauncher.checked) {
                openLauncher.checked = false;
                closeAll.checked = false;
            }
            if (!closeLauncher.checked) closeLauncher.checked = true;
            settingsLauncher.launcher.close = 'close-launcher';
            this.database.update(settingsLauncher, 'launcher');
        })

        closeAll.addEventListener("change", () => {
            if (closeAll.checked) {
                closeLauncher.checked = false;
                openLauncher.checked = false;
            }
            if (!closeAll.checked) closeAll.checked = true;
            settingsLauncher.launcher.close = 'close-all';
            this.database.update(settingsLauncher, 'launcher');
        })

        openLauncher.addEventListener("change", () => {
            if (openLauncher.checked) {
                closeLauncher.checked = false;
                closeAll.checked = false;
            }
            if (!openLauncher.checked) openLauncher.checked = true;
            settingsLauncher.launcher.close = 'open-launcher';
            this.database.update(settingsLauncher, 'launcher');
        })
    }

    initTab() {
        let TabBtn = document.querySelectorAll('.tab-btn');
        let TabContent = document.querySelectorAll('.tabs-settings-content');

        for (let i = 0; i < TabBtn.length; i++) {
            TabBtn[i].addEventListener('click', () => {
                if (TabBtn[i].classList.contains('save-tabs-btn')) return;
                for (let j = 0; j < TabBtn.length; j++) {
                    TabContent[j].classList.remove('active-tab-content');
                    TabBtn[j].classList.remove('active-tab-btn');
                }
                TabContent[i].classList.add('active-tab-content');
                TabBtn[i].classList.add('active-tab-btn');
            });
        }

        document.querySelector('.save-tabs-btn').addEventListener('click', async () => {
            document.querySelector('.default-tab-btn').click();
            showLoadingOverlay();
            changePanel("home");
            await this.refreshData();
        });

        document.getElementById('accounts-tab').innerHTML = `<i class="fas fa-user"></i><span>${t('accounts')}</span>`;
        document.getElementById('ram-tab').innerHTML = `<i class="fab fa-java"></i><span>${t('ram_settings')}</span>`;
        document.getElementById('launch-tab').innerHTML = `<i class="fas fa-rocket"></i><span>${t('launcher_loading')}</span>`;
        document.getElementById('mods-tab').innerHTML = `<i class="fas fa-puzzle-piece"></i><span>${t('optional_mods')}</span>`;
        document.getElementById('skin-tab').innerHTML = `<i class="fas fa-tshirt"></i><span>${t('skin')}</span>`;
        document.getElementById('save-tab').innerHTML = `<i class="fas fa-save"></i><span>${t('save')}</span>`;

        document.getElementById('add-account-btn').innerHTML = `<i class="fas fa-plus"></i> <span>${t('add_account')}</span>`;
        document.getElementById('ram-title').textContent = t('ram_settings');
        document.getElementById('ram-info').innerHTML = t('ram_detailed_info');
        document.getElementById('total-ram').textContent = t('total_ram');
        document.getElementById('free-ram').textContent = t('free_ram');
        document.getElementById('launch-title').textContent = t('launcher_loading');
        document.getElementById('close-launcher-text').textContent = t('close_launcher');
        document.getElementById('close-all-text').textContent = t('close_all');
        document.getElementById('open-launcher-text').textContent = t('open_launcher');
        document.getElementById('mods-title').textContent = t('optional_mods');
        document.getElementById('mods-info').innerHTML = t('mods_detailed_info');
        document.getElementById('skin-title').textContent = t('skin');

        const dropzoneText = document.getElementById('dropzone-text');
        if (dropzoneText) dropzoneText.textContent = t('dropzone_drag');
        const dropzoneSubtext = document.querySelector('.dropzone-subtext');
        if (dropzoneSubtext) dropzoneSubtext.textContent = t('dropzone_click');
        const dropzoneReq = document.querySelector('.dropzone-requirements');
        if (dropzoneReq) dropzoneReq.textContent = t('dropzone_requirements');
        const dropzoneHoverSpan = document.querySelector('.dropzone-hover-state span');
        if (dropzoneHoverSpan) dropzoneHoverSpan.textContent = t('dropzone_drop');
    }

    async initSettingsDefault() {
        if (!(await this.database.getAll('accounts-selected')).length) {
            this.database.add({ uuid: "1234" }, 'accounts-selected')
        }

        if (!(await this.database.getAll('java-path')).length) {
            this.database.add({ uuid: "1234", path: false }, 'java-path')
        }

        if (!(await this.database.getAll('java-args')).length) {
            this.database.add({ uuid: "1234", args: [] }, 'java-args')
        }

        if (!(await this.database.getAll('launcher')).length) {
            this.database.add({
                uuid: "1234",
                launcher: {
                    close: 'close-launcher'
                }
            }, 'launcher')
        }

        if (!(await this.database.getAll('ram')).length) {
            this.database.add({ uuid: "1234", ramMin: "2", ramMax: "4" }, 'ram')
        }

        if (!(await this.database.getAll('screen')).length) {
            this.database.add({ uuid: "1234", screen: { width: "1280", height: "720" } }, 'screen')
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
export default Settings;