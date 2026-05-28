# Hindsight — Geoventure Launcher

> Retrospective technique, décisions, et leçons apprises.  
> Document vivant — mis à jour à chaque cycle de dev significatif.

---

## Décisions d'architecture

### env: "panel" — CentralCorp Installer (pas Azuriom plugin)
**Pourquoi** : Le plugin CentralCorp pour Azuriom est payant. On utilise le panel CentralCorp Installer indépendant.  
**Impact** : Les routes API sont `/utils/api` (panel) au lieu de `/api/centralcorp/options` (Azuriom).  
**Règle** : Ne JAMAIS remettre `env: "azuriom"` — ça casse toute la connexion.

### config.js n'utilise plus localStorage
**Pourquoi** : L'override `localStorage.getItem('geoventure_server_url')` causait une régression : si Elandor/Pokeland était sélectionné (URL `conflictura.eu`), le panel config pointait vers `conflictura.eu/utils/api` qui retourne du HTML → crash JSON.  
**Fix** : `config.js` utilise toujours `pkg.settings` directement. Le localStorage ne sert qu'à switcher les fichiers de jeu dans `home.js`.

### position: fixed → absolute pour settings sidebar
**Pourquoi** : `.tabs-settings-btn` était `position: fixed`, ce qui fait sortir l'élément du stacking context. Quand le panel `.settings` passait à `opacity: 0`, la sidebar restait visible.  
**Fix** : `position: absolute` + `position: relative` sur le parent + `visibility: hidden/visible` sur `.panel`/`.active`.

### Auto-bump version dans CI
**Pourquoi** : Éviter d'oublier de bumper la version (sans bump, electron-updater ne détecte pas de nouvelle release).  
**Implémentation** : Job `version-bump` tourne en premier, fait `npm version patch`, commit avec `[skip ci]`, push. Les 4 jobs build checkoutent le SHA exact post-bump.

### electron-builder programmatique
**Pourquoi** : `npm run build -- --publish always` passe le flag au CLI mais pas à l'API programmatique `builder.build()`.  
**Fix critique** : `builder.build({ publish: 'always', config: {...} })` — le `publish` doit être au niveau de l'objet passé, pas dans `config`.

### macOS : deux runners séparés
**Pourquoi** : `arch: "universal"` échoue avec `discord-rpc` (module natif).  
**Solution** : `macos-14` (Apple Silicon arm64) + `macos-13` (Intel x64) en parallèle.

---

## Bugs résolus

| Bug | Cause | Fix |
|---|---|---|
| "Aucune connexion internet" | `localStorage geoventure_server_url` = `conflictura.eu` → `/utils/api` retourne HTML | `config.js` n'utilise plus localStorage |
| Settings panel reste visible | `.tabs-settings-btn` `position: fixed` ignore `opacity: 0` parent | `visibility: hidden` + `position: absolute` |
| Build artifacts jamais uploadés | `publish: 'always'` ignoré par API programmatique electron-builder | `builder.build({ publish: 'always', ... })` |
| macOS universal build échoue | `discord-rpc` module natif incompatible avec `arch: universal` | Deux runners séparés arm64/x64 |
| `minimumSystemVersion` invalide | Propriété non supportée dans electron-builder 26.x | Supprimée |
| Push 403 GitHub | App Claude Code non installée sur l'org Geoventure-MC | Installée manuellement |

---

## Ce qui a bien fonctionné

- **Auto-update complet** : `electron-updater` + GitHub Releases + auto-bump CI = joueurs mis à jour sans rien faire
- **Multi-serveur** : Sélecteur de serveur via `pkg.servers` + localStorage dans `home.js`
- **Panel transitions** : `visibility` + `opacity` + `transform` = animations fluides sans flash
- **Build matrix** : 4 plateformes en parallèle, release complète en ~15 min
- **CentralCorp Installer** : Panel léger, pas besoin du plugin Azuriom payant

---

## Ce qui a posé problème

### modules natifs + macOS
**Problème** : `discord-rpc` bloque les builds universels.  
**Contournement** : CI split en deux runners macOS.

### localStorage comme URL override
**Problème** : L'idée de persister l'URL du serveur sélectionné dans localStorage est dangereuse si la valeur est corrompue ou pointe vers un serveur mort.  
**Leçon** : localStorage ne doit stocker que des préférences UI, jamais des URLs critiques pour le démarrage.

### Obfuscation + debugging
**Problème** : Erreurs en production illisibles.  
**TODO** : Intégrer un système de log côté panel.

---

## Deux repos liés

Ce projet est lié à un second repo (panel / backend). Les deux repos sont "fusionnels" — les mises à jour d'un impactent l'autre. Toujours vérifier la cohérence des URLs et des routes API entre les deux.

---

## Minecraft 1.20.1 — Notes spécifiques

| Point | Statut |
|---|---|
| Java 17 requis | ✅ Auto-bundlé |
| Forge `1.20.1-47.4.20` | ✅ Configuré dans `/utils/api` |
| Serveur Geoventure | ✅ `84.235.238.100:25566` |
| Serveur Elandor | ⚠️ URL à configurer dans `package.json` |
| Serveur Pokeland | ⚠️ URL à configurer dans `package.json` |
| OptiFine / Shaders | ⚠️ Non testé |

---

## TODO techniques

- [ ] Renseigner les vraies URLs pour Elandor et Pokeland dans `package.json`
- [ ] Vider le message d'erreur debug (`index.js` montre l'erreur réelle) → remettre un message propre une fois stable
- [ ] Migrer vers `contextIsolation: true` (sécurité Electron)
- [ ] Tests unitaires sur `utils/config.js`
- [ ] Documenter le schéma JSON attendu de `/utils/api`
- [ ] Vérifier la compatibilité des mods ARM sur macOS
- [ ] Community mods tab — brancher sur la vraie API panel
