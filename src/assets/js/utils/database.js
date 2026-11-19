/**
 * @author Luuxis
 * Licensed under CC BY-NC 4.0
 * https://creativecommons.org/licenses/by-nc/4.0/
 *
 * Edited by CentralCorp Team
 */
const STORE_NAMES = [
    'accounts',
    'accounts-selected',
    'java-path',
    'java-args',
    'launcher',
    'profile',
    'ram',
    'screen',
];

class database {
    static _dbPromise = null;

    static _openSharedDb() {
        if (!database._dbPromise) {
            database._dbPromise = new Promise((resolve, reject) => {
                const request = indexedDB.open('database', 1);

                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    for (const storeName of STORE_NAMES) {
                        if (!db.objectStoreNames.contains(storeName)) {
                            db.createObjectStore(storeName, { keyPath: 'key' });
                        }
                    }
                };

                request.onsuccess = (event) => {
                    const db = event.target.result;
                    db.onversionchange = () => {
                        db.close();
                        database._dbPromise = null;
                    };
                    db.onclose = () => {
                        database._dbPromise = null;
                    };
                    resolve(db);
                };

                request.onerror = (event) => {
                    database._dbPromise = null;
                    reject(event.target.error);
                };
            });
        }
        return database._dbPromise;
    }

    async init() {
        this.db = await database._openSharedDb();
        return this;
    }

    async ensureDb() {
        if (!this.db) {
            this.db = await database._openSharedDb();
        }
        return this.db;
    }

    normalizeKey(rawKey) {
        return String(rawKey ?? '');
    }

    genKey(rawKey) {
        let key = 0;
        const str = String(rawKey ?? '');
        for (let i = 0; i < str.length; i++) {
            key = (((key << 5) - key) + str.charCodeAt(i)) & 0xffffffff;
        }
        return key;
    }

    async add(data, type) {
        return this.update(data, type);
    }

    async update(data, type) {
        const db = await this.ensureDb();
        const strKey = this.normalizeKey(data?.uuid);
        const legacyKey = this.genKey(strKey);

        return new Promise((resolve) => {
            const tx = db.transaction(type, 'readwrite');
            const store = tx.objectStore(type);
            store.delete(legacyKey);
            const putReq = store.put({ key: strKey, value: data });
            putReq.onsuccess = () => resolve(putReq.result);
            putReq.onerror = () => resolve(null);
            tx.onerror = () => resolve(null);
        });
    }

    async get(keys, type) {
        const db = await this.ensureDb();
        const strKey = this.normalizeKey(keys);
        const legacyKey = this.genKey(strKey);

        return new Promise((resolve) => {
            const tx = db.transaction(type, 'readonly');
            const store = tx.objectStore(type);
            const directReq = store.get(strKey);

            directReq.onsuccess = (event) => {
                const directResult = event.target.result;
                if (directResult !== undefined) {
                    resolve(directResult);
                    return;
                }

                const legacyReq = store.get(legacyKey);
                legacyReq.onsuccess = (legacyEvent) => {
                    const legacyResult = legacyEvent.target.result;
                    if (legacyResult !== undefined && legacyResult?.value !== undefined) {
                        // Transparently migrate legacy integer-hashed record to collision-free string key
                        this._migrateLegacyRecord(type, strKey, legacyKey, legacyResult.value);
                        resolve({ key: strKey, value: legacyResult.value });
                    } else {
                        resolve(undefined);
                    }
                };
                legacyReq.onerror = () => resolve(undefined);
            };

            directReq.onerror = () => resolve(undefined);
        });
    }

    async getAll(type) {
        const db = await this.ensureDb();
        return new Promise((resolve) => {
            const tx = db.transaction(type, 'readonly');
            const store = tx.objectStore(type);
            const req = store.getAll();

            req.onsuccess = (event) => {
                const rawEntries = event.target.result || [];
                const seenKeys = new Map();
                const legacyMigrations = [];

                for (const entry of rawEntries) {
                    const uuid = entry?.value?.uuid;
                    const canonicalKey = uuid !== undefined ? this.normalizeKey(uuid) : String(entry?.key ?? '');
                    if (typeof entry?.key === 'number' && uuid !== undefined) {
                        legacyMigrations.push({ strKey: canonicalKey, legacyKey: entry.key, value: entry.value });
                        if (!seenKeys.has(canonicalKey)) {
                            seenKeys.set(canonicalKey, { key: canonicalKey, value: entry.value });
                        }
                    } else {
                        seenKeys.set(canonicalKey, entry);
                    }
                }

                for (const m of legacyMigrations) {
                    const current = seenKeys.get(m.strKey);
                    this._migrateLegacyRecord(type, m.strKey, m.legacyKey, current?.value ?? m.value);
                }

                resolve(Array.from(seenKeys.values()));
            };
            req.onerror = () => resolve([]);
        });
    }

    async delete(key, type) {
        const db = await this.ensureDb();
        const strKey = this.normalizeKey(key);
        const legacyKey = this.genKey(strKey);

        return new Promise((resolve) => {
            const tx = db.transaction(type, 'readwrite');
            const store = tx.objectStore(type);
            store.delete(strKey);
            store.delete(legacyKey);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    }

    _migrateLegacyRecord(type, strKey, legacyKey, value) {
        if (!this.db) return;
        try {
            const tx = this.db.transaction(type, 'readwrite');
            const store = tx.objectStore(type);
            store.delete(legacyKey);
            store.put({ key: strKey, value });
        } catch (_) {
            // Best-effort background migration
        }
    }

    getStore(type, mode = 'readwrite') {
        return this.db.transaction(type, mode).objectStore(type);
    }
}

export default database;