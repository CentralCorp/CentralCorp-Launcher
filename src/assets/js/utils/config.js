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
        this._activeInstance = null;
    }

    async ensureMeta() {
        if (!this.meta) {
            this.meta = await getLauncherMeta();
        }
        return this.meta;
    }

    async GetConfig(forceRefresh = false) {
        try {
            await this.ensureMeta();
            if (!this.config || forceRefresh) {
                this.config = await fetchRemoteConfig();
            }
            return this.config;
        } catch (error) {
            console.error('Failed to fetch config:', error);
            throw error;
        }
    }

    async getPanelBaseUrl() {
        const meta = await this.ensureMeta();
        const base = meta.settings_url || '';
        return base.endsWith('/') ? base : `${base}/`;
    }

    async getAzAuthUrl(cfg = null) {
        const meta = await this.ensureMeta();
        const activeCfg = cfg || this.config || {};
        const base = meta.settings_url.endsWith('/') ? meta.settings_url : `${meta.settings_url}/`;
        if (meta.env === 'azuriom') {
            return base;
        }
        const az = activeCfg.azauth || '';
        if (!az) return '';
        return az.endsWith('/') ? az : `${az}/`;
    }

    async GetNews() {
        try {
            const cfg = await this.GetConfig();
            const meta = await this.ensureMeta();
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

            return Array.isArray(items) ? items : [];
        } catch (error) {
            console.error('Failed to fetch news:', error);
            return null;
        }
    }
}

export default new Config();
