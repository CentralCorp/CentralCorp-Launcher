/**
 * @author Luuxis
 * Licensed under CC BY-NC 4.0
 * https://creativecommons.org/licenses/by-nc/4.0/
 *
 * Edited by CentralCorp Team
 */
import { getLauncherMeta, fetchRemoteConfig, fetchNews } from './tauri-bridge.js';

class Config {
    constructor() {
        this.config = null;
        this.meta = null;
        this._news = null;
        this._activeInstance = null;
        this._inFlightConfigPromise = null;
        this._inFlightNewsPromise = null;
    }

    async ensureMeta() {
        if (!this.meta) {
            this.meta = await getLauncherMeta();
        }
        return this.meta;
    }

    async GetConfig(forceRefresh = false) {
        if (!forceRefresh && this.config) {
            return this.config;
        }
        if (!forceRefresh && this._inFlightConfigPromise) {
            return this._inFlightConfigPromise;
        }

        const promise = (async () => {
            try {
                await this.ensureMeta();
                const fetched = await fetchRemoteConfig(Boolean(forceRefresh));
                if (this._activeInstance && fetched) {
                    fetched._activeInstance = this._activeInstance;
                }
                this.config = fetched;
                return this.config;
            } catch (error) {
                console.error('Failed to fetch config:', error);
                throw error;
            } finally {
                if (this._inFlightConfigPromise === promise) {
                    this._inFlightConfigPromise = null;
                }
            }
        })();

        this._inFlightConfigPromise = promise;
        return promise;
    }

    async getPanelBaseUrl() {
        const meta = await this.ensureMeta();
        const base = meta.settings_url || '';
        return base.endsWith('/') ? base : `${base}/`;
    }

    async getAzAuthUrl(cfg = null) {
        const meta = await this.ensureMeta();
        const activeCfg = cfg || this.config || {};
        const rawSettingsUrl = meta?.settings_url || '';
        const base = rawSettingsUrl.endsWith('/') ? rawSettingsUrl : `${rawSettingsUrl}/`;
        if (meta?.env === 'azuriom') {
            return rawSettingsUrl ? base : '';
        }
        const az = activeCfg.azauth || '';
        if (!az) return '';
        return az.endsWith('/') ? az : `${az}/`;
    }

    async GetNews(forceRefresh = false) {
        if (!forceRefresh && Array.isArray(this._news)) {
            return this._news;
        }
        if (!forceRefresh && this._inFlightNewsPromise) {
            return this._inFlightNewsPromise;
        }

        const promise = (async () => {
            try {
                const [cfg, meta] = await Promise.all([this.GetConfig(), this.ensureMeta()]);
                const base = await this.getPanelBaseUrl();
                const azauthUrl = await this.getAzAuthUrl(cfg);

                let newsSource = cfg.news_source;
                if (!newsSource) {
                    newsSource = meta.env === 'azuriom' ? 'azuriom' : (azauthUrl ? 'azuriom' : 'panel');
                }
                const newsUrl = cfg.news_url || (meta.env !== 'azuriom' ? `${base}utils/news` : null);

                const items = await fetchNews({
                    news_source: newsSource,
                    news_url: newsUrl,
                    azauth_url: azauthUrl || null,
                });

                this._news = Array.isArray(items) ? items : [];
                return this._news;
            } catch (error) {
                console.error('Failed to fetch news:', error);
                return null;
            } finally {
                if (this._inFlightNewsPromise === promise) {
                    this._inFlightNewsPromise = null;
                }
            }
        })();

        this._inFlightNewsPromise = promise;
        return promise;
    }
}

export default new Config();
