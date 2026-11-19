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
    escapeHtml,
    addAccount,
    accountSelect,
    headplayer,
    normalizeAccount,
    ensureFreshMicrosoftAccount,
    isInstanceModded,
    resolveInstanceRam,
    getActiveInstance,
    Slider,
    showLoadingOverlay,
    hideLoadingOverlay,
    t,
} from '../utils.js';
import {
    getLauncherMeta,
    resolveGameRoot,
    getSystemMemory,
    authAzuriomLogout,
    listOptionalMods,
    toggleOptionalMod,
    uploadPlayerSkin,
    setMicrosoftCape,
    setCloseBehavior,
} from '../utils/tauri-bridge.js';
import {
    MinecraftSkinViewer3D,
    resolveAccountSkinSources,
    resolveAccountAvatarUrl,
    getActiveMicrosoftCape,
    renderMinecraftCapePreviewDataUrl,
    invalidateSkinCache,
} from '../utils/skin-renderer.js';

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const res = String(reader.result || '');
            const idx = res.indexOf(',');
            resolve(idx !== -1 ? res.slice(idx + 1) : res);
        };
        reader.onerror = (err) => reject(err);
        reader.readAsDataURL(file);
    });
}

class Settings {
    static id = 'settings';

    async init(config) {
        this.config = config;
        const [meta, db] = await Promise.all([getLauncherMeta(), new database().init()]);
        this.meta = meta;
        this.database = db;
        this.skinViewer3D = null;
        this.selectedSlimModel = false;
        this._isPanelActive = false;
        this._ramDirty = true;
        this._modsDirty = true;
        this._skinDirty = true;

        await this.initSettingsDefault();
        this.initTab();
        this.initAccount();
        await this.initLauncherSettings();
        this.initSkinStudioControls();
        this.initSkinDropzone();
        await this.updateModsTabVisibility();

        // Lazy hydration: RAM, Optional Mods, and 3D Skin Studio only run when Settings is opened
        window.addEventListener('panel-changed', (e) => {
            const activePanel = e.detail?.panel;
            if (activePanel === 'settings') {
                this._isPanelActive = true;
                this.refreshDirtySections();
                this.updateViewerAnimationState();
            } else {
                this._isPanelActive = false;
                if (this.skinViewer3D) {
                    this.skinViewer3D.stop();
                }
            }
        });

        window.addEventListener('instance-changed', async () => {
            this._ramDirty = true;
            this._modsDirty = true;
            await this.updateModsTabVisibility();
            if (this._isPanelActive) {
                this.refreshDirtySections();
            }
        });

        window.addEventListener('instance-launched-closed', () => {
            this._modsDirty = true;
            if (this._isPanelActive) {
                this.refreshDirtySections();
            }
        });

        window.addEventListener('account-changed', () => {
            this._skinDirty = true;
            if (this._isPanelActive) {
                this.refreshDirtySections();
            }
        });
    }

    async refreshDirtySections() {
        const tasks = [];
        if (this._ramDirty) {
            this._ramDirty = false;
            tasks.push(this.initRam());
        }
        if (this._modsDirty) {
            this._modsDirty = false;
            tasks.push(this.initOptionalMods());
        }
        if (this._skinDirty) {
            this._skinDirty = false;
            tasks.push(this.initPreviewSkin());
        }
        if (tasks.length) {
            await Promise.all(tasks);
        }
    }

    async updateModsTabVisibility() {
        const modsTabBtn = document.getElementById('mods-tab');
        if (!modsTabBtn) return;

        const inst = await getActiveInstance(this.config, this.database);
        const modded = isInstanceModded(inst, this.config);
        modsTabBtn.style.display = modded ? '' : 'none';

        if (!modded && modsTabBtn.classList.contains('active-tab-btn')) {
            document.querySelector('.default-tab-btn')?.click();
        }
    }

    async getSelectedAccount() {
        const selectedUuid = (await this.database.get('1234', 'accounts-selected'))?.value?.selected;
        if (!selectedUuid) return null;
        const rec = await this.database.get(selectedUuid, 'accounts');
        return rec?.value ? normalizeAccount(rec.value) : null;
    }

    // -----------------------------------------------------------------------
    // Unified 3D Skin + Cape Studio (Microsoft + Azuriom skin-api)
    // -----------------------------------------------------------------------

    initSkinStudioControls() {
        const classicBtn = document.getElementById('skinModelClassicBtn');
        const slimBtn = document.getElementById('skinModelSlimBtn');
        const rotateHint = document.getElementById('skinRotateHint');
        const capesTitle = document.getElementById('capesSectionTitle');

        if (classicBtn) classicBtn.textContent = t('skin_model_classic');
        if (slimBtn) slimBtn.textContent = t('skin_model_slim');
        if (rotateHint) rotateHint.textContent = t('skin_drag_rotate');
        if (capesTitle) {
            capesTitle.innerHTML = `<i class="fas fa-award"></i><span>${escapeHtml(t('official_capes'))}</span>`;
        }

        if (classicBtn && slimBtn) {
            classicBtn.addEventListener('click', () => this.selectSkinModel(false));
            slimBtn.addEventListener('click', () => this.selectSkinModel(true));
        }

        const canvas = document.getElementById('skin3dCanvas');
        if (canvas && !this.skinViewer3D) {
            this.skinViewer3D = new MinecraftSkinViewer3D(canvas);
        }
    }

    selectSkinModel(slim) {
        this.selectedSlimModel = Boolean(slim);
        const classicBtn = document.getElementById('skinModelClassicBtn');
        const slimBtn = document.getElementById('skinModelSlimBtn');
        if (classicBtn) classicBtn.classList.toggle('active', !this.selectedSlimModel);
        if (slimBtn) slimBtn.classList.toggle('active', this.selectedSlimModel);
        if (this.skinViewer3D) {
            this.skinViewer3D.setSlim(this.selectedSlimModel);
        }
    }

    showSkinStatus(text, isError = false) {
        const el = document.getElementById('skinStatusMsg');
        if (!el) return;
        el.style.color = isError ? '#ef4444' : 'var(--accent-color, #00bd7a)';
        el.textContent = text;
        if (text) {
            clearTimeout(this._skinMsgTimer);
            this._skinMsgTimer = setTimeout(() => {
                el.textContent = '';
            }, 3500);
        }
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
                fileInput.value = '';
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
            this.showSkinStatus(t('error_png_required'), true);
            return;
        }

        const objectUrl = URL.createObjectURL(file);
        const img = new Image();
        img.onload = async () => {
            URL.revokeObjectURL(objectUrl);
            const validSize = img.width === 64 && (img.height === 64 || img.height === 32);
            if (!validSize) {
                this.showSkinStatus(t('error_skin_size'), true);
                return;
            }

            const dropzone = document.getElementById('skinDropzone');
            dropzone.classList.add('upload-success');
            await this.processSkinChange(file);
            setTimeout(() => {
                dropzone.classList.remove('upload-success');
            }, 2000);
        };
        img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            this.showSkinStatus(t('error_png_required'), true);
        };
        img.src = objectUrl;
    }

    async processSkinChange(file) {
        let account = await this.getSelectedAccount();
        if (!account) return;

        const isMicrosoft = account.meta?.type === 'Microsoft';
        if (!isMicrosoft && this.config?.skin_api === false) {
            this.showSkinStatus(t('unavailable'), true);
            return;
        }

        try {
            if (isMicrosoft) {
                account = await ensureFreshMicrosoftAccount(
                    account,
                    this.config,
                    this.meta,
                    this.database
                );
            }

            const [pngBase64, azauth, panelBaseUrl] = await Promise.all([
                fileToBase64(file),
                configUtil.getAzAuthUrl(this.config),
                this.meta.env !== 'azuriom' ? configUtil.getPanelBaseUrl() : Promise.resolve(null),
            ]);

            const updatedRaw = await uploadPlayerSkin({
                account,
                base_url: azauth || null,
                panel_base_url: panelBaseUrl,
                png_base64: pngBase64,
                slim: this.selectedSlimModel,
            });

            const updated = normalizeAccount(updatedRaw);
            invalidateSkinCache(updated);
            await this.database.update(updated, 'accounts');
            await addAccount(updated);
            await headplayer(updated);
            await this.initPreviewSkin();
            this.showSkinStatus(t('skin_updated'), false);
        } catch (err) {
            console.error('Skin upload failed:', err);
            this.showSkinStatus(String(err?.message || err || t('error_occurred')), true);
        }
    }

    async initPreviewSkin() {
        const account = await this.getSelectedAccount();
        if (!account) return;

        const title = document.querySelector('.player-skin-title');
        const skinTabBtn = document.getElementById('skin-tab');
        const msWrap = document.getElementById('msSkinViewerWrap');
        const fallbackWrap = document.getElementById('skin2dFallbackWrap');
        const fallbackImg = document.getElementById('skin2dFallbackImg');
        const uploadContainer = document.getElementById('skinUploadContainer');
        const capesSection = document.getElementById('capesSection');

        if (title) {
            title.textContent = `${t('skin_of')} ${account.name}`;
        }

        const isMicrosoft = account.meta?.type === 'Microsoft';
        const azSkinApiAllowed = this.config?.skin_api !== false;

        if (skinTabBtn) {
            skinTabBtn.innerHTML = `<i class="fas fa-tshirt"></i><span>${escapeHtml(isMicrosoft ? t('skin_and_capes') : t('skin'))}</span>`;
        }

        // Respect `skin_api` option for Azuriom accounts while keeping Mojang upload enabled for Microsoft
        if (uploadContainer) {
            uploadContainer.style.display = isMicrosoft || azSkinApiAllowed ? '' : 'none';
        }

        const azauth = !isMicrosoft && azSkinApiAllowed
            ? await configUtil.getAzAuthUrl(this.config)
            : '';
        const skinInfo = resolveAccountSkinSources(account, azauth);

        if (isMicrosoft) {
            if (fallbackWrap) fallbackWrap.style.display = 'none';
            if (msWrap) msWrap.style.display = 'flex';
            if (capesSection) capesSection.style.display = 'block';

            const activeCape = getActiveMicrosoftCape(account);
            this.selectSkinModel(skinInfo.slim);

            if (this.skinViewer3D) {
                await this.skinViewer3D.setSkin(skinInfo.primaryUrl, skinInfo.slim, {
                    allowProceduralFallback: true,
                });
                await this.skinViewer3D.setCape(activeCape?.url || null);
                this.updateViewerAnimationState();
            }

            await this.renderCapesStrip(account);
            return;
        }

        // Azuriom account: render interactive 3D studio when full 64x64/64x32 skin exists,
        // or gracefully fall back to crisp 2D avatar card when no custom skin is uploaded yet.
        if (capesSection) capesSection.style.display = 'none';
        if (this.skinViewer3D) {
            await this.skinViewer3D.setCape(null);
        }

        let rendered3D = false;
        if (this.skinViewer3D && skinInfo.primaryUrl) {
            this.selectSkinModel(skinInfo.slim);
            rendered3D = await this.skinViewer3D.setSkin(skinInfo.primaryUrl, skinInfo.slim, {
                fallbackUrls: skinInfo.fallbackUrls,
                allowProceduralFallback: false,
            });
        }

        if (rendered3D) {
            if (fallbackWrap) fallbackWrap.style.display = 'none';
            if (msWrap) msWrap.style.display = 'flex';
            this.updateViewerAnimationState();
        } else {
            if (this.skinViewer3D) this.skinViewer3D.stop();
            if (msWrap) msWrap.style.display = 'none';
            if (fallbackWrap && fallbackImg) {
                const avatarUrl = await resolveAccountAvatarUrl(account, azauth);
                fallbackImg.alt = account.name || '';
                fallbackImg.onerror = () => {
                    if (!fallbackImg.src.endsWith('setve.png')) {
                        fallbackImg.src = './assets/images/default/setve.png';
                    }
                };
                fallbackImg.src = avatarUrl;
                fallbackWrap.style.display = 'flex';
            }
        }
    }

    async renderCapesStrip(account) {
        const strip = document.getElementById('capesStrip');
        if (!strip) return;
        strip.innerHTML = '';

        const capes = Array.isArray(account?.profile?.capes) ? account.profile.capes : [];
        const activeCape = getActiveMicrosoftCape(account);

        // 1. "No cape" card
        const noneCard = document.createElement('div');
        noneCard.className = `cape-card${!activeCape ? ' active' : ''}`;
        noneCard.innerHTML = `
            <div class="cape-card-preview"><i class="fas fa-ban"></i></div>
            <div class="cape-card-label">${escapeHtml(t('no_cape'))}</div>
        `;
        noneCard.addEventListener('click', () => this.applyMicrosoftCape(account, null));
        strip.appendChild(noneCard);

        // 2. Owned official capes
        for (const cape of capes) {
            const isEquipped = activeCape && activeCape.id === cape.id;
            const card = document.createElement('div');
            card.className = `cape-card${isEquipped ? ' active' : ''}`;
            card.title = cape.alias || 'Cape';
            card.innerHTML = `
                <img class="cape-card-preview" alt="${escapeHtml(cape.alias || 'Cape')}" decoding="async" />
                <div class="cape-card-label">${escapeHtml(cape.alias || 'Cape')}</div>
            `;

            const previewImg = card.querySelector('img');
            if (cape.url) {
                renderMinecraftCapePreviewDataUrl(cape.url)
                    .then((dataUrl) => {
                        previewImg.src = dataUrl;
                    })
                    .catch(() => {
                        previewImg.src = cape.url;
                    });
            }

            card.addEventListener('click', () => this.applyMicrosoftCape(account, cape.id));
            strip.appendChild(card);
        }
    }

    async applyMicrosoftCape(account, capeIdOrNull) {
        try {
            const freshAccount = await ensureFreshMicrosoftAccount(
                account,
                this.config,
                this.meta,
                this.database
            );
            const updatedProfile = await setMicrosoftCape(freshAccount.access_token, capeIdOrNull);
            const updatedAccount = normalizeAccount({
                ...freshAccount,
                profile: updatedProfile,
            });
            await this.database.update(updatedAccount, 'accounts');

            const activeCape = getActiveMicrosoftCape(updatedAccount);
            if (this.skinViewer3D) {
                await this.skinViewer3D.setCape(activeCape?.url || null);
            }
            await this.renderCapesStrip(updatedAccount);
            this.showSkinStatus(t('cape_updated'), false);
        } catch (err) {
            console.error('Failed to change cape:', err);
            this.showSkinStatus(String(err?.message || err || t('error_occurred')), true);
        }
    }

    updateViewerAnimationState() {
        if (!this.skinViewer3D) return;
        const skinTabBtn = document.getElementById('skin-tab');
        const msWrap = document.getElementById('msSkinViewerWrap');
        const isSkinTabActive = Boolean(
            this._isPanelActive &&
                skinTabBtn &&
                skinTabBtn.classList.contains('active-tab-btn') &&
                msWrap &&
                msWrap.style.display !== 'none'
        );
        if (isSkinTabActive) {
            this.skinViewer3D.start();
        } else {
            this.skinViewer3D.stop();
        }
    }

    // -----------------------------------------------------------------------
    // Accounts Management (Dual-Auth AZauth + Microsoft)
    // -----------------------------------------------------------------------

    initAccount() {
        document.querySelector('.accounts').addEventListener('click', async (e) => {
            const deleteBtn = e.target.closest('.account-delete');
            const accountCard = e.target.closest('.account');
            if (!accountCard) return;

            const targetUuid = accountCard.id;
            const selectedRec = await this.database.get('1234', 'accounts-selected');
            const currentSelectedUuid = selectedRec?.value?.selected;

            if (deleteBtn) {
                e.stopPropagation();
                const storedRec = await this.database.get(targetUuid, 'accounts');
                const storedAcc = storedRec?.value ? normalizeAccount(storedRec.value) : null;

                // Best-effort Azuriom token revocation on logout
                if (storedAcc && storedAcc.meta?.type === 'AZauth' && storedAcc.access_token) {
                    const azauth = await configUtil.getAzAuthUrl(this.config);
                    if (azauth) {
                        authAzuriomLogout(azauth, storedAcc.access_token).catch(() => {});
                    }
                }

                await this.database.delete(targetUuid, 'accounts');
                accountCard.remove();

                const remaining = await this.database.getAll('accounts');
                if (!remaining.length) {
                    if (this.skinViewer3D) this.skinViewer3D.stop();
                    await this.database.update({ uuid: '1234' }, 'accounts-selected');
                    const cancelLogin = document.querySelector('.cancel-login');
                    if (cancelLogin) cancelLogin.style.display = 'none';
                    changePanel('login');
                    return;
                }

                if (targetUuid === currentSelectedUuid) {
                    const nextAcc = normalizeAccount(remaining[0]?.value);
                    if (nextAcc?.uuid) {
                        await this.database.update({ uuid: '1234', selected: nextAcc.uuid }, 'accounts-selected');
                        await accountSelect(nextAcc.uuid, nextAcc);
                        window.dispatchEvent(new CustomEvent('account-changed', { detail: { account: nextAcc } }));
                    }
                }
                return;
            }

            if (targetUuid !== currentSelectedUuid) {
                showLoadingOverlay();
                try {
                    const accRec = await this.database.get(targetUuid, 'accounts');
                    const acc = normalizeAccount(accRec?.value);
                    await this.database.update({ uuid: '1234', selected: targetUuid }, 'accounts-selected');
                    await accountSelect(targetUuid, acc);
                    window.dispatchEvent(new CustomEvent('account-changed', { detail: { account: acc } }));
                } finally {
                    hideLoadingOverlay();
                }
            }
        });

        document.querySelector('.add-account').addEventListener('click', () => {
            if (this.skinViewer3D) this.skinViewer3D.stop();
            const cancelBtn = document.querySelector('.cancel-login');
            if (cancelBtn) cancelBtn.style.display = 'inline-block';
            changePanel('login');
        });
    }

    // -----------------------------------------------------------------------
    // System Memory & Per-Instance RAM Slider
    // -----------------------------------------------------------------------

    async initRam() {
        const [inst, mem] = await Promise.all([
            getActiveInstance(this.config, this.database),
            getSystemMemory().catch((err) => {
                console.warn('Fallback RAM metrics:', err);
                return { total_gb: 8, free_gb: 4 };
            }),
        ]);

        const totalMem = mem?.total_gb > 0 ? mem.total_gb : 8;
        const freeMem = mem?.free_gb >= 0 ? mem.free_gb : 4;

        const ramTitle = document.getElementById('ram-title');
        if (ramTitle) {
            const multiCount = Array.isArray(this.config?.instances) ? this.config.instances.length : 1;
            ramTitle.textContent =
                multiCount > 1 && inst?.name
                    ? `${t('ram_settings')} — ${inst.name}`
                    : t('ram_settings');
        }

        document.getElementById('total-ram').textContent = `${totalMem} Go RAM`;
        document.getElementById('free-ram').textContent = `${freeMem} Go ${t('free_ram')}`;

        const resolved = await resolveInstanceRam(inst, this.config, this.database, totalMem);
        const sliderDiv = document.querySelector('.memory-slider');
        if (!sliderDiv) return;

        sliderDiv.setAttribute('min', String(resolved.minBound));
        sliderDiv.setAttribute('max', String(resolved.maxBound));

        const slider = new Slider('.memory-slider', resolved.ramMin, resolved.ramMax);

        const minSpan = document.querySelector('.slider-touch-left span');
        const maxSpan = document.querySelector('.slider-touch-right span');

        if (minSpan) minSpan.setAttribute('value', `${resolved.ramMin} Go`);
        if (maxSpan) maxSpan.setAttribute('value', `${resolved.ramMax} Go`);

        slider.on('change', (min, max) => {
            if (minSpan) minSpan.setAttribute('value', `${min} Go`);
            if (maxSpan) maxSpan.setAttribute('value', `${max} Go`);
            this.database.update(
                {
                    uuid: resolved.ramKey,
                    ramMin: String(min),
                    ramMax: String(max),
                },
                'ram'
            );
        });
    }

    // -----------------------------------------------------------------------
    // Optional Mods (Instance-Scoped via Tauri Rust Commands)
    // -----------------------------------------------------------------------

    getModsUrlForInstance(instance) {
        if (instance?.mods_url) return instance.mods_url;
        const rawSettings = this.meta?.settings_url || '';
        const base = rawSettings.endsWith('/') ? rawSettings : `${rawSettings}/`;
        if (instance?.slug && instance.slug !== 'default') {
            return this.meta?.env === 'azuriom'
                ? `${base}api/centralcorp/instances/${instance.slug}/mods`
                : `${base}utils/instances/${instance.slug}/mods`;
        }
        return this.meta?.env === 'azuriom' ? `${base}api/centralcorp/mods` : `${base}utils/mods`;
    }

    async initOptionalMods() {
        const modsListElement = document.getElementById('mods-list');
        const modsTitleElement = document.getElementById('mods-title');
        if (!modsListElement) return;
        modsListElement.innerHTML = '';

        const inst = await getActiveInstance(this.config, this.database);
        if (!isInstanceModded(inst, this.config)) {
            await this.updateModsTabVisibility();
            return;
        }

        const slug = inst?.slug || 'default';
        if (modsTitleElement) {
            const multiCount = Array.isArray(this.config?.instances) ? this.config.instances.length : 1;
            modsTitleElement.textContent =
                multiCount > 1 && inst?.name
                    ? `${t('optional_mods')} — ${inst.name}`
                    : t('optional_mods');
        }

        const gameRoot = resolveGameRoot(this.meta, this.config.dataDirectory);
        const modsUrl = this.getModsUrlForInstance(inst);

        try {
            const mods = await listOptionalMods(gameRoot, slug, modsUrl);
            if (!Array.isArray(mods) || mods.length === 0) {
                const emptyDiv = document.createElement('div');
                emptyDiv.innerHTML = `
                    <div class="mods-container-empty">
                        <h2>${escapeHtml(t('no_optional_mods'))}</h2>
                    </div>`;
                modsListElement.appendChild(emptyDiv);
                return;
            }

            const fragment = document.createDocumentFragment();
            for (const mod of mods) {
                const modElement = document.createElement('div');
                const safeId = `opt-mod-${slug}-${mod.file}`;

                if (mod.info_missing) {
                    modElement.innerHTML = `
                        <div class="mods-container">
                            <h2>${escapeHtml(t('mod_info_missing_admin').replace('${mod}', mod.file))}</h2>
                            <div class="switch">
                                <label class="switch-label">
                                    <input type="checkbox" id="${escapeHtml(safeId)}" name="mod" ${mod.enabled ? 'checked' : ''}>
                                    <span class="slider round"></span>
                                </label>
                            </div>
                        </div>
                        <hr>`;
                } else {
                    const modName = mod.name || mod.file;
                    const modDescription = mod.description || t('no_mod_description');
                    const isRecommended = Boolean(mod.recommanded || mod.recommended);
                    const safeIcon =
                        mod.icon && /^https?:\/\//i.test(String(mod.icon).trim())
                            ? String(mod.icon).trim()
                            : null;

                    modElement.innerHTML = `
                        <div class="mods-container">
                            ${safeIcon ? `<img src="${escapeHtml(safeIcon)}" class="mods-icon" alt="${escapeHtml(modName)} logo" loading="lazy" decoding="async">` : ''}
                            <div class="mods-container-text">
                                <div class="mods-container-name">
                                    <h2>${escapeHtml(modName)}</h2>
                                    <div class="mods-recommanded" style="display: ${isRecommended ? 'block' : 'none'};">${escapeHtml(t('recommended'))}</div>
                                </div>
                                <div class="mod-description">${escapeHtml(modDescription)}</div>
                            </div>
                            <div class="switch">
                                <label class="switch-label">
                                    <input type="checkbox" id="${escapeHtml(safeId)}" name="mod" ${mod.enabled ? 'checked' : ''}>
                                    <span class="slider round"></span>
                                </label>
                            </div>
                        </div>
                        <hr>`;
                }

                const iconImg = modElement.querySelector('img.mods-icon');
                if (iconImg) {
                    iconImg.onerror = () => {
                        iconImg.remove();
                    };
                }

                const checkbox = modElement.querySelector('input[type="checkbox"]');
                checkbox.addEventListener('change', async (e) => {
                    const desired = e.target.checked;
                    checkbox.disabled = true;
                    try {
                        await toggleOptionalMod(gameRoot, slug, mod.file, desired);
                    } catch (err) {
                        console.error('Failed to toggle mod:', err);
                        e.target.checked = !desired;
                    } finally {
                        checkbox.disabled = false;
                    }
                });

                fragment.appendChild(modElement);
            }
            modsListElement.appendChild(fragment);
        } catch (err) {
            console.warn('Could not load optional mods:', err);
            this.displayEmptyModsMessage(modsListElement);
        }
    }

    displayEmptyModsMessage(modsListElement) {
        const modElement = document.createElement('div');
        modElement.innerHTML = `
            <div class="mods-container-empty">
                <h2>${escapeHtml(t('optional_mods_not_downloaded'))}</h2>
            </div>`;
        modsListElement.appendChild(modElement);
    }

    // -----------------------------------------------------------------------
    // Launcher Close Behavior & Tabs
    // -----------------------------------------------------------------------

    async initLauncherSettings() {
        const launcherDatabase = (await this.database.get('1234', 'launcher'))?.value;
        const settingsLauncher = {
            uuid: '1234',
            launcher: {
                close: launcherDatabase?.launcher?.close || 'close-launcher',
            },
        };

        setCloseBehavior(settingsLauncher.launcher.close).catch(() => {});

        const closeLauncher = document.getElementById('launcher-close');
        const closeAll = document.getElementById('launcher-close-all');
        const openLauncher = document.getElementById('launcher-open');

        if (settingsLauncher.launcher.close === 'close-launcher') {
            closeLauncher.checked = true;
        } else if (settingsLauncher.launcher.close === 'close-all') {
            closeAll.checked = true;
        } else if (settingsLauncher.launcher.close === 'open-launcher') {
            openLauncher.checked = true;
        }

        const applyChoice = (choice) => {
            closeLauncher.checked = choice === 'close-launcher';
            closeAll.checked = choice === 'close-all';
            openLauncher.checked = choice === 'open-launcher';
            settingsLauncher.launcher.close = choice;
            this.database.update(settingsLauncher, 'launcher');
            setCloseBehavior(choice).catch(() => {});
        };

        closeLauncher.addEventListener('change', () => applyChoice('close-launcher'));
        closeAll.addEventListener('change', () => applyChoice('close-all'));
        openLauncher.addEventListener('change', () => applyChoice('open-launcher'));
    }

    initTab() {
        const tabBtns = document.querySelectorAll('.tab-btn');
        const tabContents = document.querySelectorAll('.tabs-settings-content');

        for (let i = 0; i < tabBtns.length; i++) {
            tabBtns[i].addEventListener('click', () => {
                if (tabBtns[i].classList.contains('save-tabs-btn')) return;
                for (let j = 0; j < tabBtns.length; j++) {
                    if (tabContents[j]) tabContents[j].classList.remove('active-tab-content');
                    tabBtns[j].classList.remove('active-tab-btn');
                }
                if (tabContents[i]) tabContents[i].classList.add('active-tab-content');
                tabBtns[i].classList.add('active-tab-btn');
                this.updateViewerAnimationState();
            });
        }

        document.querySelector('.save-tabs-btn').addEventListener('click', async () => {
            if (this.skinViewer3D) this.skinViewer3D.stop();
            document.querySelector('.default-tab-btn').click();
            showLoadingOverlay();
            try {
                const acc = await this.getSelectedAccount();
                window.dispatchEvent(new CustomEvent('account-changed', { detail: { account: acc } }));
                changePanel('home');
            } finally {
                hideLoadingOverlay();
            }
        });

        document.getElementById('accounts-tab').innerHTML = `<i class="fas fa-user"></i><span>${escapeHtml(t('accounts'))}</span>`;
        document.getElementById('ram-tab').innerHTML = `<i class="fab fa-java"></i><span>${escapeHtml(t('ram_settings'))}</span>`;
        document.getElementById('launch-tab').innerHTML = `<i class="fas fa-rocket"></i><span>${escapeHtml(t('launcher_loading'))}</span>`;
        document.getElementById('mods-tab').innerHTML = `<i class="fas fa-puzzle-piece"></i><span>${escapeHtml(t('optional_mods'))}</span>`;
        document.getElementById('skin-tab').innerHTML = `<i class="fas fa-tshirt"></i><span>${escapeHtml(t('skin'))}</span>`;
        document.getElementById('save-tab').innerHTML = `<i class="fas fa-save"></i><span>${escapeHtml(t('save'))}</span>`;

        document.getElementById('add-account-btn').innerHTML = `<i class="fas fa-plus"></i> <span>${escapeHtml(t('add_account'))}</span>`;
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
        const defaultInst =
            (this.config?.instances || []).find((i) => i.is_default) ||
            (this.config?.instances || [])[0];

        const defaults = [
            ['accounts-selected', { uuid: '1234' }],
            ['java-path', { uuid: '1234', path: false }],
            ['java-args', { uuid: '1234', args: [] }],
            ['launcher', { uuid: '1234', launcher: { close: 'close-launcher' } }],
            ['profile', { uuid: '1234', selectedInstance: defaultInst?.slug || null }],
            ['screen', { uuid: '1234', screen: { width: '<auto>', height: '<auto>' } }],
        ];

        await Promise.all(
            defaults.map(async ([storeName, initialValue]) => {
                const existing = await this.database.get('1234', storeName);
                if (!existing) {
                    await this.database.add(initialValue, storeName);
                }
            })
        );
    }
}

export default Settings;