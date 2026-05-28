# Primer — Geoventure Launcher

> Guide de démarrage rapide pour comprendre et travailler sur le projet.  
> Minecraft **1.20.1** · Electron · Azuriom

---

## Ce que fait ce projet

Le Geoventure Launcher est une application desktop (Windows / macOS / Linux) qui :

1. Authentifie le joueur via l'API Azuriom du serveur
2. Télécharge et synchronise les mods (Forge 1.20.1)
3. Lance Minecraft avec la bonne configuration Java/RAM
4. Affiche les news, le statut du serveur, le skin du joueur

Le launcher ne contient **aucune configuration en dur** côté client : tout est chargé depuis `{settings_url}/api/centralcorp/options` au démarrage.

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
    └── translations/   ← en.json, fr.json, de.json, es.json, ru.json
```

**Flux d'exécution :**

```
app.js
 └─ updateWindow.js  →  index.html  (check mise à jour)
     └─ mainWindow.js →  launcher.html
          ├─ login.html  (si pas de session)
          └─ home.html   (si connecté)
```

---

## Fichiers clés à connaître

| Fichier | Ce qu'il fait |
|---|---|
| `src/app.js` | Point d'entrée Electron, gestion IPC, single-instance lock |
| `src/assets/js/utils/config.js` | Appels API Azuriom, chargement de la config distante |
| `src/assets/js/utils/database.js` | Stockage local (settings, session utilisateur) |
| `src/assets/js/panels/home.js` | Logique de lancement Minecraft, gestion des mods |
| `src/assets/js/panels/login.js` | Authentification Azuriom |
| `src/assets/js/panels/settings.js` | Préférences RAM, Java, couleur UI |
| `build.js` | Script de build : obfuscation JS + electron-builder |
| `package.json` | `settings` URL + version — les deux seuls champs à changer souvent |

---

## Minecraft 1.20.1 — Points spécifiques

- **Loader** : Forge (configuré côté backend Azuriom)
- **Java** : Java 17 requis (bundlé automatiquement par `minecraft-java-core-azbetter`)
- **Mods** : gérés entièrement par l'API — le joueur ne touche à rien
- **Mods optionnels** : liste définie dans l'API, cochable dans l'onglet Settings

La version Minecraft cible est définie dans la réponse de l'API, pas dans le code du launcher.

---

## Workflow de développement

```bash
# 1. Cloner et installer
git clone https://github.com/Geoventure-MC/Launcher.git && cd Launcher
npm install

# 2. Lancer en dev (hot-reload)
npm run dev

# 3. Build local (sans publish)
npm run build

# 4. Publier une nouvelle version
# → Bumper la version dans package.json
# → git commit + push sur main
# → Le CI crée la release et build automatiquement
```

---

## Variables d'environnement

| Variable | Usage |
|---|---|
| `NODE_ENV=dev` | Active les DevTools dans la fenêtre Electron |
| `DEV_TOOL=open` | Force l'ouverture des DevTools au démarrage |
| `GH_TOKEN` | (CI seulement) Token GitHub pour publier les releases |

---

## Ajouter une traduction

1. Copier `src/assets/translations/en.json`
2. Nommer le fichier avec le code langue ISO 639-1 (ex: `pt.json`)
3. Traduire les valeurs
4. La langue est sélectionnée automatiquement depuis `navigator.language`

---

## Déployer une mise à jour

1. Modifier `"version"` dans `package.json` (semver : `X.Y.Z`)
2. Commit sur `main`
3. Le workflow CI/CD :
   - Crée un tag `vX.Y.Z` sur GitHub
   - Build le launcher pour Win/Mac/Linux
   - Publie les artefacts sur la Release GitHub
4. L'auto-updater (`electron-updater`) détecte la nouvelle version et propose la mise à jour aux utilisateurs

---

## Liens utiles

- [Azuriom](https://azuriom.com) — Backend du launcher
- [AzLink (Spigot)](https://azuriom.com/fr/azlink) — Plugin serveur pour l'auth
- [minecraft-java-core-azbetter](https://www.npmjs.com/package/minecraft-java-core-azbetter) — Core Minecraft
- [electron-builder docs](https://www.electron.build) — Config de build
- [Documentation complète](docs/README.md)
