/**
 * @author Luuxis
 * Licensed under CC BY-NC 4.0
 * https://creativecommons.org/licenses/by-nc/4.0/
 *
 * Edited by CentralCorp Team
 */
import { database, changePanel, addAccount, accountSelect, showLoadingOverlay, hideLoadingOverlay, t } from '../utils.js';
const { AZauth } = require('minecraft-java-core-azbetter');
const { ipcRenderer, shell } = require('electron');
const pkg = require('../package.json');
const settings_url = pkg.user ? `${pkg.settings}/${pkg.user}` : pkg.settings;

'use strict';

class Login {
    static id = "login";

    async init(config) {
        this.config = config;
        this.database = await new database().init();
        this.setStaticTexts();
        this.config.online ? this.getOnline() : this.getOffline();
    }

    setStaticTexts() {
        document.getElementById('login-title').textContent = t('connect');
        document.getElementById('cancel-login-btn').textContent = t('cancel');
        document.getElementById('a2f-label').textContent = t('2fa_enabled');
        document.getElementById('a2f-login-btn').textContent = t('play');
        document.getElementById('cancel-a2f-btn').textContent = t('cancel');
        document.getElementById('email-verify-label').textContent = t('verify_email');
        document.getElementById('cancel-email-btn').textContent = t('cancel');
        document.getElementById('username-label').textContent = t('username');
        document.getElementById('password-label').textContent = t('password');
        document.getElementById('login-btn').textContent = t('play');
        document.getElementById('password-reset-link').textContent = t('forgot_password');
        document.getElementById('new-user-link').textContent = t('no_account');
    }

    async refreshData() {
        document.querySelector('.player-role').innerHTML = '';
        document.querySelector('.player-monnaie').innerHTML = '';
        await this.initOthers();
        await this.initPreviewSkin();
        hideLoadingOverlay();
    }

    async initPreviewSkin() {
        console.log('initPreviewSkin called');
        const baseUrl = settings_url.endsWith('/') ? settings_url : `${settings_url}/`;
        const websiteUrl = pkg.env === 'azuriom' ? `${baseUrl}` : this.config.azauth;
        const uuid = (await this.database.get('1234', 'accounts-selected')).value;
        const account = (await this.database.get(uuid.selected, 'accounts')).value;

        document.querySelector('.player-skin-title').innerHTML = `${t('skin_of')} ${account.name}`;
        document.querySelector('.skin-renderer-settings').src = `${websiteUrl}skin3d/3d-api/skin-api/${account.name}`;
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
            playBtn.style.backgroundColor = "#696969";
            playBtn.style.pointerEvents = "none";
            playBtn.style.boxShadow = "none";
            playBtn.textContent = t('unavailable');
        } else {
            playBtn.style.backgroundColor = "#00bd7a";
            playBtn.style.pointerEvents = "auto";
            playBtn.style.boxShadow = "2px 2px 5px rgba(0, 0, 0, 0.3)";
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

    getOnline() {
        console.log(`Initializing Az Panel...`);
        this.loginAzAuth();
    }

    async loginAzAuth() {
        const elements = this.getElements();
        const azauth = this.getAzAuthUrl();

        this.setupExternalLinks(azauth);
        this.setupEventListeners(elements, azauth);
    }

    getElements() {
        return {
            mailInput: document.querySelector('.Mail'),
            passwordInput: document.querySelector('.Password'),
            cancelLoginBtn: document.querySelector('.cancel-login'),
            infoLogin: document.querySelector('.info-login'),
            loginBtn: document.querySelector(".login-btn"),
            loginBtn2f: document.querySelector('.login-btn-2f'),
            a2finput: document.querySelector('.a2f'),
            infoLogin2f: document.querySelector('.info-login-2f'),
            cancel2f: document.querySelector('.cancel-2f'),
            infoLoginEmail: document.querySelector('.info-login-email'),
            cancelEmail: document.querySelector('.cancel-email')
        };
    }

    getAzAuthUrl() {
        const baseUrl = settings_url.endsWith('/') ? settings_url : `${settings_url}/`;
        return pkg.env === 'azuriom'
            ? baseUrl
            : this.config.azauth.endsWith('/')
                ? this.config.azauth
                : `${this.config.azauth}/`;
    }

    setupExternalLinks(azauth) {
        const newuserurl = `${azauth}user/register`;
        const passwordreseturl = `${azauth}user/password/reset`;

        this.newuser = document.querySelector(".new-user");
        this.newuser.innerHTML = t('no_account');
        this.newuser.addEventListener('click', () => shell.openExternal(newuserurl));

        this.passwordreset = document.querySelector(".password-reset");
        this.passwordreset.innerHTML = t('forgot_password');
        this.passwordreset.addEventListener('click', () => shell.openExternal(passwordreseturl));
    }

    setupEventListeners(elements, azauth) {
        elements.cancelLoginBtn.addEventListener("click", () => {
            changePanel("settings");
        });
        elements.cancel2f.addEventListener("click", () => this.resetLoginForm(elements));
        elements.cancelEmail.addEventListener("click", () => this.resetLoginForm(elements));

        elements.loginBtn2f.addEventListener("click", async () => {
            elements.infoLogin2f.innerHTML = t('connecting');
            if (elements.a2finput.value === "") {
                elements.infoLogin2f.innerHTML = t('enter_2fa_code');
                return;
            }
            await this.handleLogin(elements, azauth, elements.a2finput.value);
        });

        elements.loginBtn.addEventListener("click", async () => {
            elements.loginBtn.disabled = true;
            elements.mailInput.disabled = true;
            elements.passwordInput.disabled = true;
            elements.infoLogin.innerHTML = t('connecting');

            if (elements.mailInput.value === "") {
                elements.infoLogin.innerHTML = t('enter_username');
                this.enableLoginForm(elements);
                return;
            }

            if (elements.passwordInput.value === "") {
                elements.infoLogin.innerHTML = t('enter_password');
                this.enableLoginForm(elements);
                return;
            }

            await this.handleLogin(elements, azauth);
        });
    }

    toggleLoginCards(cardType) {
        const loginCardMain = document.querySelector(".login-card-main");
        const a2fCard = document.querySelector('.a2f-card');
        const emailVerifyCard = document.querySelector('.email-verify-card');

        loginCardMain.style.display = cardType === "default" || cardType === "mojang" ? "block" : "none";
        a2fCard.style.display = cardType === "a2f" ? "block" : "none";
        emailVerifyCard.style.display = cardType === "email" ? "block" : "none";
    }

    resetLoginForm(elements) {
        this.toggleLoginCards("default");
        elements.infoLogin.innerHTML = "";
        elements.infoLogin2f.innerHTML = "";
        elements.mailInput.value = "";
        elements.loginBtn.disabled = false;
        elements.mailInput.disabled = false;
        elements.passwordInput.disabled = false;
        elements.passwordInput.value = "";
        elements.a2finput.value = "";
    }

    enableLoginForm(elements) {
        elements.loginBtn.disabled = false;
        elements.mailInput.disabled = false;
        elements.passwordInput.disabled = false;
    }

    async handleLogin(elements, azauth, a2fCode = null) {
        const azAuth = new AZauth(azauth);
        try {
            const account_connect = a2fCode
                ? await azAuth.login(elements.mailInput.value, elements.passwordInput.value, a2fCode)
                : await azAuth.login(elements.mailInput.value, elements.passwordInput.value);

            if (account_connect.error) {
                if (account_connect.reason === 'user_banned') {
                    elements.infoLogin.innerHTML = t('account_banned');
                } else if (account_connect.reason === 'invalid_credentials') {
                    elements.infoLogin.innerHTML = t('invalid_credentials');
                } else if (account_connect.reason === 'invalid_2fa') {
                    elements.infoLogin2f.innerHTML = t('invalid_2fa_code');
                } else {
                    elements.infoLogin.innerHTML = t('error_occurred');
                    elements.infoLogin2f.innerHTML = t('error_occurred');
                }
                this.enableLoginForm(elements);
                return;
            }

            if (account_connect.A2F === true) {
                this.toggleLoginCards("a2f");
                elements.a2finput.value = "";
                elements.cancelMojangBtn.disabled = false;
                return;
            }

            if (this.config.email_verified && !account_connect.user_info.verified) {
                elements.infoLogin.innerHTML = t('verify_email');
                elements.infoLogin2f.innerHTML = t('verify_email');
                this.enableLoginForm(elements);
                return;
            }

            console.log(account_connect);

            const account = this.createAccountObject(account_connect);
            await this.saveAccount(account);
            this.resetLoginForm(elements);
            elements.loginBtn.style.display = "block";
            elements.infoLogin.innerHTML = "&nbsp;";
        } catch (err) {
            console.error(err);
            elements.infoLogin.innerHTML = t('connection_error');
            this.enableLoginForm(elements);
        }
    }

    createAccountObject(account_connect) {
        return {
            access_token: account_connect.access_token,
            client_token: account_connect.uuid,
            uuid: account_connect.uuid,
            name: account_connect.name,
            user_properties: account_connect.user_properties,
            meta: {
                type: account_connect.meta.type,
                offline: true
            },
            user_info: {
                role: account_connect.user_info.role,
                monnaie: account_connect.user_info.money,
                verified: account_connect.user_info.verified,
            },
        };
    }

    async saveAccount(account) {
        const existingAccount = await this.database.get(account.uuid, 'accounts');
        if (existingAccount && existingAccount.value) {
            showLoadingOverlay();
            await this.database.update(account, 'accounts');
            await this.database.update({ uuid: "1234", selected: account.uuid }, 'accounts-selected');
            accountSelect(account.uuid);
            changePanel("home");
            await this.refreshData();
            return;
        }

        showLoadingOverlay();
        await this.database.add(account, 'accounts');
        await this.database.update({ uuid: "1234", selected: account.uuid }, 'accounts-selected');
        addAccount(account);
        accountSelect(account.uuid);
        changePanel("home");
        await this.refreshData();
    }
}

export default Login;
