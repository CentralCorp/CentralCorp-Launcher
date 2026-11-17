/**
 * @author Luuxis
 * Licensed under CC BY-NC 4.0
 * https://creativecommons.org/licenses/by-nc/4.0/
 *
 * Edited by CentralCorp Team
 */
class database {
    async init() {
        this.db = await new Promise((resolve, reject) => {
            let request = indexedDB.open('database', 1);

            request.onupgradeneeded = (event) => {
                let db = event.target.result;

                if (!db.objectStoreNames.contains('accounts')) {
                    db.createObjectStore('accounts', { keyPath: "key" });
                }

                if (!db.objectStoreNames.contains('accounts-selected')) {
                    db.createObjectStore('accounts-selected', { keyPath: "key" });
                }

                if (!db.objectStoreNames.contains('java-path')) {
                    db.createObjectStore('java-path', { keyPath: "key" });
                }

                if (!db.objectStoreNames.contains('java-args')) {
                    db.createObjectStore('java-args', { keyPath: "key" });
                }

                if (!db.objectStoreNames.contains('launcher')) {
                    db.createObjectStore('launcher', { keyPath: "key" });
                }

                if (!db.objectStoreNames.contains('profile')) {
                    db.createObjectStore('profile', { keyPath: "key" });
                }

                if (!db.objectStoreNames.contains('ram')) {
                    db.createObjectStore('ram', { keyPath: "key" });
                }

                if (!db.objectStoreNames.contains('screen')) {
                    db.createObjectStore('screen', { keyPath: "key" });
                }
            };

            request.onsuccess = (event) => {
                resolve(event.target.result);
            };

            request.onerror = (event) => {
                reject(event.target.error);
            };
        });
        return this;
    }

    add(data, type) {
        let store = this.getStore(type);
        return new Promise((resolve) => {
            let req = store.put({ key: this.genKey(data.uuid), value: data });
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
    }

    get(keys, type) {
        let store = this.getStore(type);
        let Key = this.genKey(keys);
        return new Promise((resolve) => {
            let get = store.get(Key);
            get.onsuccess = (event) => {
                resolve(event.target.result);
            };
            get.onerror = () => resolve(undefined);
        });
    }

    getAll(type) {
        let store = this.getStore(type);
        return new Promise((resolve) => {
            let getAll = store.getAll();
            getAll.onsuccess = (event) => {
                resolve(event.target.result || []);
            };
            getAll.onerror = () => resolve([]);
        });
    }

    update(data, type) {
        let self = this;
        return new Promise((resolve) => {
            let store = self.getStore(type);
            let key = self.genKey(data.uuid);
            let keyCursor = store.openCursor(key);
            keyCursor.onsuccess = (event) => {
                let cursor = event.target.result;
                if (!cursor) {
                    let putReq = store.put({ key, value: data });
                    putReq.onsuccess = () => resolve(putReq.result);
                    putReq.onerror = () => resolve(null);
                    return;
                }
                for (let [k, value] of Object.entries({ value: data })) {
                    cursor.value[k] = value;
                }
                let updReq = cursor.update(cursor.value);
                updReq.onsuccess = () => resolve(updReq.result);
                updReq.onerror = () => resolve(null);
            };
            keyCursor.onerror = () => resolve(null);
        });
    }

    delete(key, type) {
        let store = this.getStore(type);
        return new Promise((resolve) => {
            let req = store.delete(this.genKey(key));
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
        });
    }

    getStore(type) {
        return this.db.transaction(type, "readwrite").objectStore(type);
    }

    genKey(int) {
        var key = 0;
        for (let c of String(int).split("")) key = (((key << 5) - key) + c.charCodeAt()) & 0xFFFFFFFF;
        return key;
    }
}

export default database;