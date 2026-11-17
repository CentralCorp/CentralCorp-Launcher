/**
 * CentralCorp Launcher — Crisp 2D Head & Interactive 3D Minecraft Skin + Cape Studio
 * Zero-dependency HTML5 Canvas pixel-accurate renderer supporting Classic (4px) & Slim (3px)
 * models, full 64x64 outer overlays, and animated back cape mesh.
 */
'use strict';

const DEFAULT_STEVE_AVATAR = './assets/images/default/setve.png';

function normalizeTextureSource(src) {
    if (!src || typeof src !== 'string') return null;
    const trimmed = src.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('data:image/')) return trimmed;
    if (/^http:\/\/textures\.minecraft\.net\//i.test(trimmed)) {
        return trimmed.replace(/^http:\/\//i, 'https://');
    }
    if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('./') || trimmed.startsWith('../')) {
        return trimmed;
    }
    return `data:image/png;base64,${trimmed}`;
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const normalized = normalizeTextureSource(src);
        if (!normalized) {
            reject(new Error('Empty texture source'));
            return;
        }
        const img = new Image();
        if (/^https?:\/\//i.test(normalized)) {
            img.crossOrigin = 'anonymous';
        }
        img.onload = () => resolve(img);
        img.onerror = (err) => reject(err);
        img.src = normalized;
    });
}

/**
 * Extracts a crisp 64x64 2D Minecraft player face + hat overlay from a 64x64 / 64x32 skin texture.
 * Crops face (8,8,8,8) + hat layer (40,8,8,8) with nearest-neighbor scaling.
 */
export async function renderMinecraftHeadDataUrl(skinBase64OrUrl) {
    const img = await loadImage(skinBase64OrUrl);
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    const scale = img.width >= 64 ? img.width / 64 : 1;
    // Base head front: (8, 8, 8, 8)
    ctx.drawImage(img, 8 * scale, 8 * scale, 8 * scale, 8 * scale, 0, 0, 64, 64);
    // Hat / outer head front: (40, 8, 8, 8)
    ctx.drawImage(img, 40 * scale, 8 * scale, 8 * scale, 8 * scale, 0, 0, 64, 64);

    return canvas.toDataURL('image/png');
}

/**
 * Resolves the best active skin URL from a Microsoft AuthAccount.
 */
export function getActiveMicrosoftSkin(account) {
    const skins = account?.profile?.skins;
    if (Array.isArray(skins) && skins.length > 0) {
        const active = skins.find((s) => String(s.state || '').toUpperCase() === 'ACTIVE') || skins[0];
        if (active?.url) {
            return {
                url: normalizeTextureSource(active.url),
                slim: String(active.variant || '').toUpperCase() === 'SLIM',
            };
        }
    }
    if (account?.user_properties) {
        try {
            const parsed = JSON.parse(account.user_properties);
            const texProp = Array.isArray(parsed)
                ? parsed.find((p) => p.name === 'textures')
                : null;
            if (texProp?.value) {
                const decoded = JSON.parse(atob(texProp.value));
                const skinObj = decoded?.textures?.SKIN;
                if (skinObj?.url) {
                    return {
                        url: normalizeTextureSource(skinObj.url),
                        slim: skinObj?.metadata?.model === 'slim',
                    };
                }
            }
        } catch (_) {
            // Ignore malformed user_properties
        }
    }
    return null;
}

/**
 * Resolves the active cape object from a Microsoft AuthAccount.
 */
export function getActiveMicrosoftCape(account) {
    const capes = account?.profile?.capes;
    if (!Array.isArray(capes) || capes.length === 0) return null;
    return capes.find((c) => String(c.state || '').toUpperCase() === 'ACTIVE') || null;
}

/**
 * Resolves a 2D avatar URL or data URL for any account (AZauth or Microsoft).
 */
export async function resolveAccountAvatarUrl(account, azauthUrl = '') {
    if (!account) return DEFAULT_STEVE_AVATAR;
    const type = String(account?.meta?.type || '').toLowerCase();
    if (type === 'microsoft') {
        const skin = getActiveMicrosoftSkin(account);
        if (skin?.url) {
            try {
                return await renderMinecraftHeadDataUrl(skin.url);
            } catch (_) {
                // Fall back to mc-heads
            }
        }
        const cleanUuid = String(account.uuid || '').replace(/-/g, '');
        if (cleanUuid) {
            return `https://mc-heads.net/avatar/${cleanUuid}/64`;
        }
        return DEFAULT_STEVE_AVATAR;
    }

    if (azauthUrl && account.name) {
        const base = azauthUrl.endsWith('/') ? azauthUrl : `${azauthUrl}/`;
        return `${base}api/skin-api/avatars/face/${encodeURIComponent(account.name)}/?t=${Date.now()}`;
    }
    return DEFAULT_STEVE_AVATAR;
}

/**
 * Renders a crisp 2D preview data URL of a cape's front emblem (1, 1, 10, 16).
 */
export async function renderMinecraftCapePreviewDataUrl(capeUrl) {
    const img = await loadImage(capeUrl);
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    const scale = img.width >= 64 && img.width % 64 === 0 ? img.width / 64 : 1;
    ctx.drawImage(img, 1 * scale, 1 * scale, 10 * scale, 16 * scale, 0, 0, 40, 64);
    return canvas.toDataURL('image/png');
}

// ---------------------------------------------------------------------------
// Interactive 3D Minecraft Character + Cape Studio Renderer
// ---------------------------------------------------------------------------

function extractImagePixels(img) {
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return {
        width: img.width,
        height: img.height,
        data: ctx.getImageData(0, 0, img.width, img.height).data,
    };
}

function createProceduralStevePixels() {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    // Hair & head
    ctx.fillStyle = '#c68f65';
    ctx.fillRect(0, 0, 32, 16);
    ctx.fillStyle = '#3b2618';
    ctx.fillRect(8, 0, 8, 8);
    ctx.fillRect(8, 8, 8, 2);
    ctx.fillRect(0, 8, 8, 4);
    ctx.fillRect(16, 8, 16, 5);
    // Eyes & mouth
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(9, 12, 1, 1);
    ctx.fillRect(14, 12, 1, 1);
    ctx.fillStyle = '#493b7f';
    ctx.fillRect(10, 12, 1, 1);
    ctx.fillRect(13, 12, 1, 1);
    ctx.fillStyle = '#6c3f2b';
    ctx.fillRect(11, 14, 2, 1);
    // Torso (cyan shirt)
    ctx.fillStyle = '#00a8b5';
    ctx.fillRect(16, 16, 24, 16);
    // Arms
    ctx.fillStyle = '#00a8b5';
    ctx.fillRect(40, 16, 16, 6);
    ctx.fillRect(32, 48, 16, 6);
    ctx.fillStyle = '#c68f65';
    ctx.fillRect(40, 22, 16, 10);
    ctx.fillRect(32, 54, 16, 10);
    // Legs (indigo pants + shoes)
    ctx.fillStyle = '#3c368c';
    ctx.fillRect(0, 16, 16, 14);
    ctx.fillRect(16, 48, 16, 14);
    ctx.fillStyle = '#555555';
    ctx.fillRect(0, 30, 16, 2);
    ctx.fillRect(16, 62, 16, 2);
    return {
        width: 64,
        height: 64,
        data: ctx.getImageData(0, 0, 64, 64).data,
    };
}

export class MinecraftSkinViewer3D {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.skinPixels = createProceduralStevePixels();
        this.capePixels = null;
        this.slim = false;
        this.yaw = -0.52;
        this.pitch = 0.16;
        this.dragging = false;
        this.lastX = 0;
        this.lastY = 0;
        this.animFrame = null;
        this.running = false;
        this.startTime = performance.now();

        this.bindInteraction();
    }

    bindInteraction() {
        this.onPointerDown = (e) => {
            this.dragging = true;
            const pt = e.touches ? e.touches[0] : e;
            this.lastX = pt.clientX;
            this.lastY = pt.clientY;
        };

        this.onPointerMove = (e) => {
            if (!this.dragging) return;
            const pt = e.touches ? e.touches[0] : e;
            const dx = pt.clientX - this.lastX;
            const dy = pt.clientY - this.lastY;
            this.lastX = pt.clientX;
            this.lastY = pt.clientY;
            this.yaw += dx * 0.014;
            this.pitch = Math.max(-0.85, Math.min(0.85, this.pitch + dy * 0.01));
        };

        this.onPointerUp = () => {
            this.dragging = false;
        };

        this.canvas.addEventListener('mousedown', this.onPointerDown);
        window.addEventListener('mousemove', this.onPointerMove);
        window.addEventListener('mouseup', this.onPointerUp);
        this.canvas.addEventListener('touchstart', this.onPointerDown, { passive: true });
        window.addEventListener('touchmove', this.onPointerMove, { passive: true });
        window.addEventListener('touchend', this.onPointerUp);
    }

    async setSkin(skinUrlOrBase64, slim = false) {
        this.slim = Boolean(slim);
        if (!skinUrlOrBase64) {
            this.skinPixels = createProceduralStevePixels();
            this.renderFrame(performance.now());
            return;
        }
        try {
            const img = await loadImage(skinUrlOrBase64);
            this.skinPixels = extractImagePixels(img);
        } catch (err) {
            console.warn('Fallback to procedural Steve skin in 3D viewer:', err);
            this.skinPixels = createProceduralStevePixels();
        }
        this.renderFrame(performance.now());
    }

    setSlim(slim) {
        this.slim = Boolean(slim);
        this.renderFrame(performance.now());
    }

    async setCape(capeUrlOrNull) {
        if (!capeUrlOrNull) {
            this.capePixels = null;
            this.renderFrame(performance.now());
            return;
        }
        try {
            const img = await loadImage(capeUrlOrNull);
            this.capePixels = extractImagePixels(img);
        } catch (err) {
            console.warn('Failed to load cape texture:', err);
            this.capePixels = null;
        }
        this.renderFrame(performance.now());
    }

    start() {
        if (this.running) return;
        this.running = true;
        const loop = (now) => {
            if (!this.running) return;
            this.renderFrame(now);
            this.animFrame = requestAnimationFrame(loop);
        };
        this.animFrame = requestAnimationFrame(loop);
    }

    stop() {
        this.running = false;
        if (this.animFrame) {
            cancelAnimationFrame(this.animFrame);
            this.animFrame = null;
        }
    }

    transformPoint(x, y, z, part) {
        // 1. Local limb X-rotation around pivot (shoulder / hip / upper-back)
        let lx = x;
        let ly = y - part.pivotY;
        let lz = z - part.pivotZ;

        if (part.rotX) {
            const cx = Math.cos(part.rotX);
            const sx = Math.sin(part.rotX);
            const ny = ly * cx - lz * sx;
            const nz = ly * sx + lz * cx;
            ly = ny;
            lz = nz;
        }
        if (part.rotZ) {
            const cz = Math.cos(part.rotZ);
            const sz = Math.sin(part.rotZ);
            const nx = lx * cz - ly * sz;
            const ny = lx * sz + ly * cz;
            lx = nx;
            ly = ny;
        }

        const wx = lx + part.offsetX;
        const wy = ly + part.pivotY + part.offsetY;
        const wz = lz + part.pivotZ + part.offsetZ;

        // 2. Scene Yaw (around Y) + Pitch (around X)
        const cy = Math.cos(this.yaw);
        const sy = Math.sin(this.yaw);
        const rx = wx * cy + wz * sy;
        const rz1 = -wx * sy + wz * cy;

        const cp = Math.cos(this.pitch);
        const sp = Math.sin(this.pitch);
        const ry = wy * cp - rz1 * sp;
        const rz = wy * sp + rz1 * cp;

        return { x: rx, y: ry, z: rz };
    }

    project(pt, width, height) {
        const camDist = 68;
        const fov = 420;
        const denom = Math.max(10, camDist - pt.z);
        const scale = fov / denom;
        return {
            sx: width * 0.5 + pt.x * scale,
            sy: height * 0.52 - pt.y * scale,
            z: pt.z,
        };
    }

    buildBoxFaces(w, h, d, inflate, u0, v0, uvW, uvH, uvD, flipX = false, isCape = false) {
        const hw = w / 2 + inflate;
        const hh = h / 2 + inflate;
        const hd = d / 2 + inflate;

        // Each face specifies 4 3D corners (TL, TR, BR, BL) and UV rect (u, v, uw, uh)
        if (isCape) {
            // Official Minecraft cloak has emblem at (1, 1, 10, 16) on outer back (-Z)
            return [
                {
                    shade: 0.95,
                    corners: [
                        [hw, hh, -hd],
                        [-hw, hh, -hd],
                        [-hw, -hh, -hd],
                        [hw, -hh, -hd],
                    ],
                    uv: [u0 + uvD, v0 + uvD, uvW, uvH],
                },
                {
                    shade: 0.78,
                    corners: [
                        [-hw, hh, hd],
                        [hw, hh, hd],
                        [hw, -hh, hd],
                        [-hw, -hh, hd],
                    ],
                    uv: [u0 + uvD + uvW + uvD, v0 + uvD, uvW, uvH],
                },
                {
                    shade: 0.84,
                    corners: [
                        [-hw, hh, -hd],
                        [-hw, hh, hd],
                        [-hw, -hh, hd],
                        [-hw, -hh, -hd],
                    ],
                    uv: [u0, v0 + uvD, uvD, uvH],
                },
                {
                    shade: 0.84,
                    corners: [
                        [hw, hh, hd],
                        [hw, hh, -hd],
                        [hw, -hh, -hd],
                        [hw, -hh, hd],
                    ],
                    uv: [u0 + uvD + uvW, v0 + uvD, uvD, uvH],
                },
                {
                    shade: 1.0,
                    corners: [
                        [hw, hh, hd],
                        [-hw, hh, hd],
                        [-hw, hh, -hd],
                        [hw, hh, -hd],
                    ],
                    uv: [u0 + uvD, v0, uvW, uvD],
                },
                {
                    shade: 0.68,
                    corners: [
                        [hw, -hh, -hd],
                        [-hw, -hh, -hd],
                        [-hw, -hh, hd],
                        [hw, -hh, hd],
                    ],
                    uv: [u0 + uvD + uvW, v0, uvW, uvD],
                },
            ];
        }

        return [
            // Front (+Z)
            {
                shade: 0.96,
                flipU: flipX,
                corners: [
                    [-hw, hh, hd],
                    [hw, hh, hd],
                    [hw, -hh, hd],
                    [-hw, -hh, hd],
                ],
                uv: [u0 + uvD, v0 + uvD, uvW, uvH],
            },
            // Back (-Z)
            {
                shade: 0.82,
                flipU: flipX,
                corners: [
                    [hw, hh, -hd],
                    [-hw, hh, -hd],
                    [-hw, -hh, -hd],
                    [hw, -hh, -hd],
                ],
                uv: [u0 + uvD + uvW + uvD, v0 + uvD, uvW, uvH],
            },
            // Right (-X)
            {
                shade: 0.84,
                flipU: flipX,
                corners: [
                    [-hw, hh, -hd],
                    [-hw, hh, hd],
                    [-hw, -hh, hd],
                    [-hw, -hh, -hd],
                ],
                uv: flipX
                    ? [u0 + uvD + uvW, v0 + uvD, uvD, uvH]
                    : [u0, v0 + uvD, uvD, uvH],
            },
            // Left (+X)
            {
                shade: 0.86,
                flipU: flipX,
                corners: [
                    [hw, hh, hd],
                    [hw, hh, -hd],
                    [hw, -hh, -hd],
                    [hw, -hh, hd],
                ],
                uv: flipX
                    ? [u0, v0 + uvD, uvD, uvH]
                    : [u0 + uvD + uvW, v0 + uvD, uvD, uvH],
            },
            // Top (+Y)
            {
                shade: 1.0,
                flipU: flipX,
                corners: [
                    [-hw, hh, -hd],
                    [hw, hh, -hd],
                    [hw, hh, hd],
                    [-hw, hh, hd],
                ],
                uv: [u0 + uvD, v0, uvW, uvD],
            },
            // Bottom (-Y)
            {
                shade: 0.68,
                flipU: flipX,
                corners: [
                    [-hw, -hh, hd],
                    [hw, -hh, hd],
                    [hw, -hh, -hd],
                    [-hw, -hh, -hd],
                ],
                uv: [u0 + uvD + uvW, v0, uvW, uvD],
            },
        ];
    }

    collectTexelQuads(quads, pixels, faces, part, isOverlay, width, height, uvScale = 1) {
        if (!pixels) return;
        const { data, width: texW, height: texH } = pixels;

        for (const face of faces) {
            const c0 = this.transformPoint(face.corners[0][0], face.corners[0][1], face.corners[0][2], part);
            const c1 = this.transformPoint(face.corners[1][0], face.corners[1][1], face.corners[1][2], part);
            const c2 = this.transformPoint(face.corners[2][0], face.corners[2][1], face.corners[2][2], part);
            const c3 = this.transformPoint(face.corners[3][0], face.corners[3][1], face.corners[3][2], part);

            const p0 = this.project(c0, width, height);
            const p1 = this.project(c1, width, height);
            const p2 = this.project(c2, width, height);
            const p3 = this.project(c3, width, height);

            // Screen-space winding check for backface culling on opaque base parts
            const cross = (p1.sx - p0.sx) * (p2.sy - p0.sy) - (p1.sy - p0.sy) * (p2.sx - p0.sx);
            if (!isOverlay && cross <= 0) {
                continue;
            }

            const [uStart, vStart, uLen, vLen] = face.uv;
            const cols = Math.max(1, Math.round(uLen * uvScale));
            const rows = Math.max(1, Math.round(vLen * uvScale));
            const shade = isOverlay && cross <= 0 ? face.shade * 0.85 : face.shade;

            for (let row = 0; row < rows; row++) {
                const v0t = row / rows;
                const v1t = (row + 1) / rows;
                const py = Math.min(texH - 1, Math.max(0, Math.floor(vStart * uvScale + row)));

                for (let col = 0; col < cols; col++) {
                    const texCol = face.flipU ? cols - 1 - col : col;
                    const px = Math.min(texW - 1, Math.max(0, Math.floor(uStart * uvScale + texCol)));
                    const idx = (py * texW + px) * 4;
                    const a = data[idx + 3];
                    if (a < 12) continue;

                    const u0t = col / cols;
                    const u1t = (col + 1) / cols;

                    // Bilinear interpolation in 3D world space before projection = true perspective!
                    const bilerp3D = (u, v) => ({
                        x:
                            (1 - u) * (1 - v) * c0.x +
                            u * (1 - v) * c1.x +
                            u * v * c2.x +
                            (1 - u) * v * c3.x,
                        y:
                            (1 - u) * (1 - v) * c0.y +
                            u * (1 - v) * c1.y +
                            u * v * c2.y +
                            (1 - u) * v * c3.y,
                        z:
                            (1 - u) * (1 - v) * c0.z +
                            u * (1 - v) * c1.z +
                            u * v * c2.z +
                            (1 - u) * v * c3.z,
                    });

                    const q0w = bilerp3D(u0t, v0t);
                    const q1w = bilerp3D(u1t, v0t);
                    const q2w = bilerp3D(u1t, v1t);
                    const q3w = bilerp3D(u0t, v1t);

                    const q0 = this.project(q0w, width, height);
                    const q1 = this.project(q1w, width, height);
                    const q2 = this.project(q2w, width, height);
                    const q3 = this.project(q3w, width, height);

                    const r = Math.round(data[idx] * shade);
                    const g = Math.round(data[idx + 1] * shade);
                    const b = Math.round(data[idx + 2] * shade);
                    const color = a >= 250 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${(a / 255).toFixed(2)})`;

                    quads.push({
                        z: (q0w.z + q1w.z + q2w.z + q3w.z) * 0.25 + (isOverlay ? 0.02 : 0),
                        q0,
                        q1,
                        q2,
                        q3,
                        color,
                    });
                }
            }
        }
    }

    renderFrame(now) {
        const { width, height } = this.canvas;
        const ctx = this.ctx;
        ctx.clearRect(0, 0, width, height);

        // Subtle floor shadow ellipse beneath feet
        ctx.save();
        const shadowGrad = ctx.createRadialGradient(
            width * 0.5,
            height * 0.89,
            4,
            width * 0.5,
            height * 0.89,
            54
        );
        shadowGrad.addColorStop(0, 'rgba(0, 0, 0, 0.45)');
        shadowGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = shadowGrad;
        ctx.beginPath();
        ctx.ellipse(width * 0.5, height * 0.89, 52, 13, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        const t = (now - this.startTime) * 0.0022;
        const swing = Math.sin(t) * 0.22;
        const breathe = Math.sin(t * 0.7) * 0.035;

        const is64x64 = this.skinPixels && this.skinPixels.height >= 64;
        const skinScale = this.skinPixels && this.skinPixels.width >= 64 ? this.skinPixels.width / 64 : 1;
        const armW = this.slim ? 3 : 4;
        const armOffsetX = 4 + armW / 2;

        const quads = [];

        // 1. Head (centered at y = 12)
        const headPart = { offsetX: 0, offsetY: 12, offsetZ: 0, pivotY: -4, pivotZ: 0, rotX: breathe * 0.4, rotZ: 0 };
        this.collectTexelQuads(
            quads,
            this.skinPixels,
            this.buildBoxFaces(8, 8, 8, 0, 0, 0, 8, 8, 8),
            headPart,
            false,
            width,
            height,
            skinScale
        );
        this.collectTexelQuads(
            quads,
            this.skinPixels,
            this.buildBoxFaces(8, 8, 8, 0.48, 32, 0, 8, 8, 8),
            headPart,
            true,
            width,
            height,
            skinScale
        );

        // 2. Torso (centered at y = 2)
        const bodyPart = { offsetX: 0, offsetY: 2, offsetZ: 0, pivotY: 0, pivotZ: 0, rotX: 0, rotZ: 0 };
        this.collectTexelQuads(
            quads,
            this.skinPixels,
            this.buildBoxFaces(8, 12, 4, 0, 16, 16, 8, 12, 4),
            bodyPart,
            false,
            width,
            height,
            skinScale
        );
        if (is64x64) {
            this.collectTexelQuads(
                quads,
                this.skinPixels,
                this.buildBoxFaces(8, 12, 4, 0.35, 16, 32, 8, 12, 4),
                bodyPart,
                true,
                width,
                height,
                skinScale
            );
        }

        // 3. Right Arm (-X)
        const rightArmPart = {
            offsetX: -armOffsetX,
            offsetY: 2,
            offsetZ: 0,
            pivotY: 5,
            pivotZ: 0,
            rotX: swing,
            rotZ: -0.04 - Math.abs(breathe),
        };
        this.collectTexelQuads(
            quads,
            this.skinPixels,
            this.buildBoxFaces(armW, 12, 4, 0, 40, 16, armW, 12, 4),
            rightArmPart,
            false,
            width,
            height,
            skinScale
        );
        if (is64x64) {
            this.collectTexelQuads(
                quads,
                this.skinPixels,
                this.buildBoxFaces(armW, 12, 4, 0.35, 40, 32, armW, 12, 4),
                rightArmPart,
                true,
                width,
                height,
                skinScale
            );
        }

        // 4. Left Arm (+X)
        const leftArmPart = {
            offsetX: armOffsetX,
            offsetY: 2,
            offsetZ: 0,
            pivotY: 5,
            pivotZ: 0,
            rotX: -swing,
            rotZ: 0.04 + Math.abs(breathe),
        };
        if (is64x64) {
            this.collectTexelQuads(
                quads,
                this.skinPixels,
                this.buildBoxFaces(armW, 12, 4, 0, 32, 48, armW, 12, 4),
                leftArmPart,
                false,
                width,
                height,
                skinScale
            );
            this.collectTexelQuads(
                quads,
                this.skinPixels,
                this.buildBoxFaces(armW, 12, 4, 0.35, 48, 48, armW, 12, 4),
                leftArmPart,
                true,
                width,
                height,
                skinScale
            );
        } else {
            this.collectTexelQuads(
                quads,
                this.skinPixels,
                this.buildBoxFaces(armW, 12, 4, 0, 40, 16, armW, 12, 4, true),
                leftArmPart,
                false,
                width,
                height,
                skinScale
            );
        }

        // 5. Right Leg (-X, centered at y = -10)
        const rightLegPart = {
            offsetX: -2,
            offsetY: -10,
            offsetZ: 0,
            pivotY: 6,
            pivotZ: 0,
            rotX: -swing * 0.8,
            rotZ: 0,
        };
        this.collectTexelQuads(
            quads,
            this.skinPixels,
            this.buildBoxFaces(4, 12, 4, 0, 0, 16, 4, 12, 4),
            rightLegPart,
            false,
            width,
            height,
            skinScale
        );
        if (is64x64) {
            this.collectTexelQuads(
                quads,
                this.skinPixels,
                this.buildBoxFaces(4, 12, 4, 0.35, 0, 32, 4, 12, 4),
                rightLegPart,
                true,
                width,
                height,
                skinScale
            );
        }

        // 6. Left Leg (+X, centered at y = -10)
        const leftLegPart = {
            offsetX: 2,
            offsetY: -10,
            offsetZ: 0,
            pivotY: 6,
            pivotZ: 0,
            rotX: swing * 0.8,
            rotZ: 0,
        };
        if (is64x64) {
            this.collectTexelQuads(
                quads,
                this.skinPixels,
                this.buildBoxFaces(4, 12, 4, 0, 16, 48, 4, 12, 4),
                leftLegPart,
                false,
                width,
                height,
                skinScale
            );
            this.collectTexelQuads(
                quads,
                this.skinPixels,
                this.buildBoxFaces(4, 12, 4, 0.35, 0, 48, 4, 12, 4),
                leftLegPart,
                true,
                width,
                height,
                skinScale
            );
        } else {
            this.collectTexelQuads(
                quads,
                this.skinPixels,
                this.buildBoxFaces(4, 12, 4, 0, 0, 16, 4, 12, 4, true),
                leftLegPart,
                false,
                width,
                height,
                skinScale
            );
        }

        // 7. Equipped Official Cape (10x16x1 hinged at upper back z = -2.4, y = 8)
        if (this.capePixels) {
            const capeScale =
                this.capePixels.width >= 64 && this.capePixels.width % 64 === 0
                    ? this.capePixels.width / 64
                    : 1;
            const capePart = {
                offsetX: 0,
                offsetY: 0,
                offsetZ: -2.6,
                pivotY: 8,
                pivotZ: 0,
                rotX: 0.18 + Math.abs(swing) * 0.35 + breathe,
                rotZ: 0,
            };
            this.collectTexelQuads(
                quads,
                this.capePixels,
                this.buildBoxFaces(10, 16, 1, 0, 0, 0, 10, 16, 1, false, true),
                capePart,
                false,
                width,
                height,
                capeScale
            );
        }

        // Painter's depth sort (back-to-front)
        quads.sort((a, b) => a.z - b.z);

        // Draw crisp pixel quads with subtle sub-pixel edge seal
        ctx.lineJoin = 'round';
        ctx.lineWidth = 0.55;
        for (let i = 0; i < quads.length; i++) {
            const q = quads[i];
            ctx.fillStyle = q.color;
            ctx.strokeStyle = q.color;
            ctx.beginPath();
            ctx.moveTo(q.q0.sx, q.q0.sy);
            ctx.lineTo(q.q1.sx, q.q1.sy);
            ctx.lineTo(q.q2.sx, q.q2.sy);
            ctx.lineTo(q.q3.sx, q.q3.sy);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        }
    }
}
