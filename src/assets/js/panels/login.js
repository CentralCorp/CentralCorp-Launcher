/**
 * @author Luuxis
 * Licensed under CC BY-NC 4.0
 * https://creativecommons.org/licenses/by-nc/4.0/
 *
 * Edited by CentralCorp Team
 */
'use strict';

import {
    config as configUtil,
    database,
    changePanel,
    addAccount,
    accountSelect,
    normalizeAccount,
    stripHtmlToText,
    showLoadingOverlay,
    hideLoadingOverlay,
    t,
} from '../utils.js';
import {
    getLauncherMeta,
    authAzuriomLogin,
    authMicrosoftLogin,
    openExternalUrl,
} from '../utils/tauri-bridge.js';

class Login {
    static id = 'login';

    async init(config) {
        this.config = config;
        const [meta, db] = await Promise.all([getLauncherMeta(), new database().init()]);
        this.meta = meta;
        this.database = db;
        this.setStaticTexts();
        this.configureAuthMode();
        await this.setupAuthHandlers();
        this.refreshMaintenanceBanner();

        window.addEventListener('panel-changed', (e) => {
            if (e.detail?.panel === 'login') {
                this.refreshMaintenanceBanner();
            }
        });
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
        document.getElementById('auth-divider-text').textContent = t('or_divider');
        document.getElementById('microsoft-auth-desc').textContent = t('microsoft_auth_subtitle');
    }

    refreshMaintenanceBanner() {
        const elements = this.getElements();
        if (!elements.infoLogin) return;
        if (this.config?.maintenance && !elements.infoLogin.textContent.trim()) {
            const msg = stripHtmlToText(this.config.maintenance_message) || t('maintenance_active');
            elements.infoLogin.textContent = msg;
        }
    }

    getAuthMode() {
        const raw = String(this.config?.auth_mode || '').toLowerCase();
        if (raw === 'microsoft' || raw === 'both' || raw === 'azuriom') {
            return raw;
        }
        return 'azuriom';
    }

    configureAuthMode() {
        const mode = this.getAuthMode();
        const cardMain = document.querySelector('.login-card-main');
        const azSection = document.getElementById('azuriom-auth-section');
        const divider = document.getElementById('auth-divider');
        const msSection = document.getElementById('microsoft-auth-section');
        const msDesc = document.getElementById('microsoft-auth-desc');
        const msBtn = document.getElementById('microsoft-login-btn');
        const msBtnText = document.getElementById('microsoft-login-text');
        const headerIcon = document.getElementById('login-header-icon');
        const heroMsLogo = document.getElementById('login-ms-hero-logo');

        if (cardMain) {
            cardMain.classList.remove('mode-microsoft', 'mode-hybrid', 'mode-azuriom');
            cardMain.classList.add(
                mode === 'microsoft'
                    ? 'mode-microsoft'
                    : mode === 'both'
                        ? 'mode-hybrid'
                        : 'mode-azuriom'
            );
            cardMain.dataset.authMode = mode;
        }

        if (mode === 'microsoft') {
            azSection.style.display = 'none';
            divider.style.display = 'none';
            msSection.style.display = 'flex';
            msDesc.style.display = 'block';
            msBtn.classList.add('primary-ms');
            msBtnText.textContent = t('microsoft_login');
            if (headerIcon) headerIcon.style.display = 'none';
            if (heroMsLogo) heroMsLogo.style.display = 'block';
        } else if (mode === 'both') {
            azSection.style.display = 'flex';
            divider.style.display = 'flex';
            msSection.style.display = 'flex';
            msDesc.style.display = 'none';
            msBtn.classList.remove('primary-ms');
            msBtnText.textContent = t('continue_with_microsoft');
            if (headerIcon) headerIcon.style.display = '';
            if (heroMsLogo) heroMsLogo.style.display = 'none';
        } else {
            azSection.style.display = 'flex';
            divider.style.display = 'none';
            msSection.style.display = 'none';
            if (headerIcon) headerIcon.style.display = '';
            if (heroMsLogo) heroMsLogo.style.display = 'none';
        }
    }

    getElements() {
        return {
            mailInput: document.querySelector('.Mail'),
            passwordInput: document.querySelector('.Password'),
            cancelLoginBtn: document.querySelector('.cancel-login'),
            infoLogin: document.querySelector('.info-login'),
            loginBtn: document.querySelector('.login-btn'),
            msLoginBtn: document.getElementById('microsoft-login-btn'),
            loginBtn2f: document.querySelector('.login-btn-2f'),
            a2finput: document.querySelector('.a2f'),
            infoLogin2f: document.querySelector('.info-login-2f'),
            cancel2f: document.querySelector('.cancel-2f'),
            infoLoginEmail: document.querySelector('.info-login-email'),
            cancelEmail: document.querySelector('.cancel-email'),
        };
    }

    async setupAuthHandlers() {
        const elements = this.getElements();
        const azauth = await configUtil.getAzAuthUrl(this.config);

        if (azauth) {
            this.setupExternalLinks(azauth);
        } else {
            const linksBox = document.querySelector('.login-links');
            if (linksBox) linksBox.style.display = 'none';
        }

        elements.cancelLoginBtn.addEventListener('click', () => {
            elements.cancelLoginBtn.style.display = 'none';
            changePanel('settings');
        });
        elements.cancel2f.addEventListener('click', () => this.resetLoginForm(elements));
        elements.cancelEmail.addEventListener('click', () => this.resetLoginForm(elements));

        // Azuriom 2FA submit
        const submit2fa = async () => {
            elements.infoLogin2f.textContent = t('connecting');
            if (!elements.a2finput.value.trim()) {
                elements.infoLogin2f.textContent = t('enter_2fa_code');
                return;
            }
            await this.handleAzuriomLogin(elements, azauth, elements.a2finput.value.trim());
        };
        elements.loginBtn2f.addEventListener('click', submit2fa);
        elements.a2finput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submit2fa();
        });

        // Azuriom credentials submit
        const submitAzuriom = async () => {
            this.setFormDisabled(elements, true);
            elements.infoLogin.textContent = t('connecting');

            if (!elements.mailInput.value.trim()) {
                elements.infoLogin.textContent = t('enter_username');
                this.setFormDisabled(elements, false);
                return;
            }

            if (!elements.passwordInput.value) {
                elements.infoLogin.textContent = t('enter_password');
                this.setFormDisabled(elements, false);
                return;
            }

            await this.handleAzuriomLogin(elements, azauth);
        };
        elements.loginBtn.addEventListener('click', submitAzuriom);
        elements.passwordInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitAzuriom();
        });

        // Microsoft OAuth2 submit
        if (elements.msLoginBtn) {
            elements.msLoginBtn.addEventListener('click', async () => {
                await this.handleMicrosoftLogin(elements);
            });
        }
    }

    setupExternalLinks(azauth) {
        const newuserurl = `${azauth}user/register`;
        const passwordreseturl = `${azauth}user/password/reset`;

        const newUserEl = document.querySelector('.new-user');
        if (newUserEl) {
            newUserEl.textContent = t('no_account');
            newUserEl.addEventListener('click', (e) => {
                e.preventDefault();
                openExternalUrl(newuserurl);
            });
        }

        const pwdResetEl = document.querySelector('.password-reset');
        if (pwdResetEl) {
            pwdResetEl.textContent = t('forgot_password');
            pwdResetEl.addEventListener('click', (e) => {
                e.preventDefault();
                openExternalUrl(passwordreseturl);
            });
        }
    }

    setFormDisabled(elements, disabled) {
        if (elements.loginBtn) elements.loginBtn.disabled = disabled;
        if (elements.msLoginBtn) elements.msLoginBtn.disabled = disabled;
        if (elements.mailInput) elements.mailInput.disabled = disabled;
        if (elements.passwordInput) elements.passwordInput.disabled = disabled;
    }

    toggleLoginCards(cardType) {
        const loginCardMain = document.querySelector('.login-card-main');
        const a2fCard = document.querySelector('.a2f-card');
        const emailVerifyCard = document.querySelector('.email-verify-card');

        if (loginCardMain) loginCardMain.style.display = cardType === 'default' ? 'block' : 'none';
        if (a2fCard) a2fCard.style.display = cardType === 'a2f' ? 'block' : 'none';
        if (emailVerifyCard) emailVerifyCard.style.display = cardType === 'email' ? 'block' : 'none';
    }

    showEmailVerificationCard() {
        const elements = this.getElements();
        this.toggleLoginCards('email');
        if (elements.infoLoginEmail) {
            elements.infoLoginEmail.textContent = t('verify_email');
        }
        if (elements.cancelEmail) {
            elements.cancelEmail.disabled = false;
        }
        this.setFormDisabled(elements, false);
    }

    resetLoginForm(elements) {
        this.toggleLoginCards('default');
        elements.infoLogin.textContent = '';
        elements.infoLogin2f.textContent = '';
        if (elements.infoLoginEmail) elements.infoLoginEmail.textContent = '';
        elements.mailInput.value = '';
        elements.passwordInput.value = '';
        elements.a2finput.value = '';
        this.setFormDisabled(elements, false);
        this.refreshMaintenanceBanner();
    }

    mapAuthError(errMsg) {
        const lower = String(errMsg || '').toLowerCase();
        if (lower.includes('user_banned') || lower.includes('banned')) {
            return t('account_banned');
        }
        if (lower.includes('invalid_credentials') || lower.includes('invalid credentials')) {
            return t('invalid_credentials');
        }
        if (lower.includes('invalid_2fa') || lower.includes('2fa')) {
            return t('invalid_2fa_code');
        }
        if (lower.includes('2148916233') || lower.includes('no_xbox_account')) {
            return t('ms_no_xbox_account');
        }
        if (lower.includes('2148916238') || lower.includes('child')) {
            return t('ms_child_account');
        }
        if (lower.includes('ownership') || lower.includes('no_minecraft') || lower.includes('does not own')) {
            return t('ms_no_minecraft_ownership');
        }
        return t('connection_error');
    }

    async handleAzuriomLogin(elements, azauth, a2fCode = null) {
        try {
            const result = await authAzuriomLogin(
                azauth,
                elements.mailInput.value.trim(),
                elements.passwordInput.value,
                a2fCode
            );

            // AzAuthLoginResult: { status: "requires_2fa" | "requires2fa" } or { status: "success", account: {...} }
            const status = String(result?.status || '').toLowerCase();
            if (status === 'requires_2fa' || status === 'requires2fa' || result?.A2F === true) {
                this.toggleLoginCards('a2f');
                elements.a2finput.value = '';
                elements.infoLogin2f.textContent = '';
                elements.cancel2f.disabled = false;
                elements.a2finput.focus();
                return;
            }

            const rawAccount = result?.account || result;
            const account = normalizeAccount(rawAccount);

            if (account.user_info?.banned) {
                const msg = t('account_banned');
                if (a2fCode) {
                    elements.infoLogin2f.textContent = msg;
                } else {
                    elements.infoLogin.textContent = msg;
                }
                this.setFormDisabled(elements, false);
                return;
            }

            // Enforced after BOTH direct login AND 2FA completion
            if (this.config.email_verified && !account.user_info?.verified) {
                this.showEmailVerificationCard();
                return;
            }

            await this.saveAccount(account);
            this.resetLoginForm(elements);
            elements.cancelLoginBtn.style.display = 'none';
        } catch (err) {
            console.error('Azuriom login error:', err);
            const friendly = this.mapAuthError(err?.message || err);
            if (a2fCode) {
                elements.infoLogin2f.textContent = friendly;
            } else {
                elements.infoLogin.textContent = friendly;
            }
            this.setFormDisabled(elements, false);
        }
    }

    async handleMicrosoftLogin(elements) {
        this.setFormDisabled(elements, true);
        elements.infoLogin.textContent = t('connecting_microsoft');

        try {
            const panelBaseUrl = this.meta.env !== 'azuriom'
                ? await configUtil.getPanelBaseUrl()
                : null;
            const rawAccount = await authMicrosoftLogin(
                this.config.client_id || null,
                panelBaseUrl
            );

            // Null means user closed the OAuth2 popup window
            if (!rawAccount) {
                elements.infoLogin.textContent = t('login_cancelled');
                this.setFormDisabled(elements, false);
                return;
            }

            const account = normalizeAccount(rawAccount);
            if (account.user_info?.banned) {
                elements.infoLogin.textContent = t('account_banned');
                this.setFormDisabled(elements, false);
                return;
            }

            await this.saveAccount(account);
            this.resetLoginForm(elements);
            elements.cancelLoginBtn.style.display = 'none';
        } catch (err) {
            console.error('Microsoft login error:', err);
            elements.infoLogin.textContent = this.mapAuthError(err?.message || err);
            this.setFormDisabled(elements, false);
        }
    }

    async saveAccount(account) {
        showLoadingOverlay();
        try {
            await this.database.update(account, 'accounts');
            await this.database.update({ uuid: '1234', selected: account.uuid }, 'accounts-selected');
            await addAccount(account);
            await accountSelect(account.uuid, account);

            window.dispatchEvent(new CustomEvent('account-changed', { detail: { account } }));
            changePanel('home');
        } finally {
            hideLoadingOverlay();
        }
    }
}

export default Login;
