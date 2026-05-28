# Primer — Geoventure Launcher

> Guide de démarrage rapide pour comprendre et travailler sur le projet.  
> Minecraft **1.20.1** · Electron · CentralCorp Installer Panel

---

## Ce que fait ce projet

Le Geoventure Launcher est une application desktop (Windows / macOS / Linux) qui :

1. Authentifie le joueur via AZauth sur `https://geoventure.bmeouchi.fr/`
2. Télécharge et synchronise les mods (Forge 1.20.1-47.4.20)
3. Lance Minecraft avec la bonne configuration Java/RAM
4. Affiche les news, le statut du serveur, le skin du joueur
5. Supporte 3 serveurs : **Geoventure**, **Elandor**, **Pokeland**

La config est chargée depuis `https://launcher.bmeouchi.fr/utils/api` au démarrage.

---

## Architecture en 30 secondes

```
src/
├── app.js              ← Main process Electron (entry point)
├── index.html          ← Splash screen / update screen
├── launcher.html       ← Shell UI principal
├── panels/             ← Pages HTML (home, login, settings)
└── assets/
    ├── js/
    │   ├── panels/     ← Logique de chaque panel
    │   ├── utils/      ← config.js, database.js, logger.js
    │   └── windows/    ← mainWindow.js, updateWindow.js
    ├── css/            ← Styles globaux + par panel
    ├── images/         ← Icônes, backgrounds, logos
    ├── fonts/          ← Poppins, Apocalypse, icomoon
    └── translations/   ← en.json, fr.json (seuls supportés)
```

**Flux d'exécution :**

```
app.js
 └─ updateWindow.js  →  index.html  (check mise à jour + splash)
     └─ mainWindow.js →  launcher.html
          ├─ login.html  (si pas de session)
          └─ home.html   (si connecté)
```

---

## URLs critiques

| Usage | URL |
|---|---|
| Panel config (API) | `https://launcher.bmeouchi.fr/utils/api` |
| Auth / skins Geoventure | `https://geoventure.bmeouchi.fr/` |
| Auth Elandor | TBD (à remplir dans `package.json`) |
| Auth Pokeland | TBD (à remplir dans `package.json`) |

---

## Variables `package.json` importantes

```json
{
  "version": "4.0.x",          ← auto-bumped par CI à chaque push
  "env": "panel",               ← NE PAS CHANGER — CentralCorp Installer
  "settings": "https://launcher.bmeouchi.fr/",  ← URL du panel config
  "servers": [
    { "id": "geoventure", "settings": "https://geoventure.bmeouchi.fr/" },
    { "id": "elandor",    "settings": "https://conflictura.eu" },   ← à mettre à jour
    { "id": "pokeland",   "settings": "https://conflictura.eu" }    ← à mettre à jour
  ]
}
```

---

## Fichiers clés à connaître

| Fichier | Ce qu'il fait |
|---|---|
| `src/app.js` | Point d'entrée Electron, gestion IPC, single-instance lock |
| `src/assets/js/utils/config.js` | Fetch `/utils/api`, **utilise toujours `pkg.settings`** (jamais localStorage) |
| `src/assets/js/utils/database.js` | Stockage local (settings, session utilisateur) |
| `src/assets/js/panels/home.js` | Lancement Minecraft, anti-cheat, logs, multi-serveur |
| `src/assets/js/panels/login.js` | Authentification AZauth |
| `src/assets/js/panels/settings.js` | RAM, Java, community mods, open folder |
| `src/assets/js/utils.js` | `changePanel()`, helpers globaux |
| `src/assets/css/launcher.css` | `.panel` / `.active` — visibility + transition fade/slide |
| `build.js` | Obfuscation JS + electron-builder programmatique |
| `.github/workflows/ci.yml` | Auto-bump version + build 4 plateformes + publish |

---

## env: "panel" vs "azuriom" — IMPORTANT

| `env` | Config URL | Auth URL |
|---|---|---|
| `"panel"` | `/utils/api` | `config.azauth` (champ du JSON retourné) |
| `"azuriom"` | `/api/centralcorp/options` | `pkg.settings` directement |

**Ce projet utilise `"panel"** car le plugin CentralCorp Azuriom est payant.  
Le panel CentralCorp Installer tourne sur `launcher.bmeouchi.fr`.

---

## CI/CD — Workflow auto-update

```
git push master
    ↓
job: version-bump (ubuntu ~10s)
    → npm version patch  (ex: 4.0.5 → 4.0.6)
    → git push [skip ci]
    ↓
jobs: build x4 (Windows / macOS arm64 / macOS x64 / Linux)
    → checkout SHA exact après bump
    → electron-builder --publish always
    → GitHub Release v4.0.6 créée automatiquement
    ↓
.exe installés chez les joueurs détectent v4.0.6
    → téléchargement + installation auto au prochain lancement
```

**Ne jamais bumper manuellement** la version — le CI le fait.

---

## Minecraft 1.20.1 — Points spécifiques

- **Loader** : Forge `1.20.1-47.4.20`
- **Java** : Java 17 auto-bundlé par `minecraft-java-core-azbetter`
- **Mods** : gérés par l'API panel, le joueur ne touche à rien
- **Serveur principal** : Geoventure (Syphera) `84.235.238.100:25566`

---

## Workflow de développement

```bash
# 1. Cloner et installer
git clone https://github.com/Geoventure-MC/Launcher.git && cd Launcher
npm install

# 2. Vider le localStorage si problème de connexion (dev)
rm -rf AppData/Launcher/Local\ Storage/

# 3. Lancer en dev
npm run dev
# ou
npm start

# 4. Publier une mise à jour
# → git commit + push sur master
# → CI bumpe la version et build automatiquement
# JAMAIS besoin de bumper manuellement ni de rebuild local
```

---

## Traductions

Seuls `fr.json` et `en.json` sont maintenus. La langue est détectée via `navigator.language`.

---

## Liens utiles

- [CentralCorp Installer Panel](https://github.com/CentralCorp/Installer/releases/latest)
- [minecraft-java-core-azbetter](https://www.npmjs.com/package/minecraft-java-core-azbetter)
- [electron-builder docs](https://www.electron.build)
- [Releases GitHub](https://github.com/Geoventure-MC/Launcher/releases)
- [Discord Geoventure](https://discord.gg/VCmNXHvf77)
