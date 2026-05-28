# Hindsight — Geoventure Launcher

> Retrospective technique, décisions, et leçons apprises.  
> Document vivant — mis à jour à chaque cycle de dev significatif.

---

## Décisions d'architecture

### Electron comme base
**Pourquoi** : Cross-platform natif (Win/Mac/Linux) depuis une seule codebase JS. Alternative directe à JavaFX (lourd, verbeux) ou Tauri (Rust, barrière d'entrée).  
**Inconvénient accepté** : Bundle volumineux (~150-200 MB). Pour un launcher de modpack, acceptable — les joueurs téléchargent une seule fois.

### Azuriom comme backend
**Pourquoi** : S'intègre nativement avec l'écosystème Minecraft Spigot/Paper. API Auth + gestion des mods centralisée = zéro update launcher côté config.  
**Inconvénient** : Dépendance externe forte. Si Azuriom change son API, le launcher casse.

### Obfuscation du code en production
**Pourquoi** : Protection contre la copie/revente du launcher personnalisé.  
**Inconvénient** : Debugging en production impossible. Les erreurs dans les logs sont illisibles.  
**Règle** : Ne jamais activer `--obf=false` en production.

### CI/CD sur `main` uniquement
**Pourquoi** : Éviter de créer des releases depuis des branches de feature.  
**Règle** : Tout merge vers `main` déclenche une build + release automatique.

---

## Ce qui a bien fonctionné

- **Auto-update** : `electron-updater` + GitHub Releases = expérience utilisateur fluide, zéro friction
- **Traductions automatiques** : Détection `navigator.language` = pas de setting à configurer pour l'utilisateur
- **Build matrix** : Win/Mac/Linux buildés en parallèle sur GitHub Actions = release complète en ~15 min
- **Config distante** : Changer les mods ou la version Minecraft = juste une modification backend, aucune mise à jour launcher

---

## Ce qui a posé problème

### Modules natifs
**Problème** : `@electron/rebuild` échoue parfois sur macOS arm64 avec certaines versions de Node.  
**Contournement** : CI utilise `macos-14` (Apple Silicon) + `setup-python` pour les bindings natifs.

### Obfuscation et source maps
**Problème** : Les erreurs rapportées par les utilisateurs sont des stacks obfusquées — difficile à debugger.  
**Contournement actuel** : Logger les erreurs avec suffisamment de contexte (action en cours, panel actif) avant qu'elles ne remontent.  
**TODO** : Intégrer Sentry ou équivalent pour le suivi des erreurs en production.

### Discord RPC déconnexion
**Problème** : `discord-rpc` peut crasher silencieusement si Discord se ferme/relance pendant que Minecraft tourne.  
**Contournement** : Try/catch autour des appels RPC, reconnexion en background.

### `actions/create-release@v1` déprécié
**Problème** : L'action GitHub était dépréciée et parfois instable.  
**Fix** : Migré vers `softprops/action-gh-release@v2` (plus maintenu, meilleure API).

---

## Minecraft 1.20.1 — Notes spécifiques

| Point | Statut |
|---|---|
| Java 17 requis | ✅ Auto-bundlé par `minecraft-java-core-azbetter` |
| Forge compatible 1.20.1 | ✅ Configuré côté Azuriom |
| OptiFine / Shader support | ⚠️ Non testé, à vérifier selon les mods du pack |
| Mods ARM (Apple Silicon) | ⚠️ Certains mods natifs peuvent nécessiter Rosetta 2 |

---

## Ce qu'on ferait différemment aujourd'hui

1. **TypeScript dès le départ** — Le JS non typé dans les panels est difficile à maintenir quand le projet grossit.
2. **Séparation stricte main/renderer** — Quelques appels Node.js dans le renderer process (à sécuriser avec `contextIsolation: true` + preload scripts).
3. **Tests unitaires sur `config.js` et `database.js`** — Ce sont les modules les plus critiques et ils n'ont aucun test.
4. **Versioning du schéma de config** — Si l'API Azuriom change un champ, le launcher peut casser sans avertissement.

---

## TODO techniques

- [ ] Migrer vers `contextIsolation: true` (sécurité Electron)
- [ ] Ajouter un système de reporting d'erreurs (Sentry)
- [ ] Tests unitaires sur `utils/config.js`
- [ ] Documenter le schéma JSON attendu de l'API Azuriom
- [ ] Vérifier la compatibilité des mods ARM sur macOS
