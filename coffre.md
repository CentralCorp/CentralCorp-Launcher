---
tags: [launcher, minecraft, geoventure, index]
created: 2025-05-28
version: 4.0.1
mc_version: 1.20.1
---

# Coffre — Geoventure Launcher

> Index principal du projet. Point d'entrée pour la navigation dans la documentation.

---

## Navigation rapide

### Documentation projet
- [[primer]] — Architecture, fichiers clés, workflow de dev
- [[hindsight]] — Décisions techniques, leçons apprises, TODO
- [[docs/README]] — Documentation complète EN/FR

### Code source
- `src/app.js` — Main process Electron
- `src/assets/js/utils/config.js` — API Azuriom
- `src/assets/js/utils/database.js` — Stockage local
- `src/assets/js/panels/home.js` — Lancement Minecraft
- `build.js` — Pipeline de build

### CI/CD
- `.github/workflows/ci.yml` — Build & Release automatique (branch `main`)

---

## Contexte serveur

| Paramètre | Valeur |
|---|---|
| Jeu | Minecraft Java Edition |
| Version | **1.20.1** |
| Mod loader | Forge |
| Backend | Azuriom |
| Authentification | Azuriom Auth API (offline) |
| URL settings | `https://conflictura.eu` |

---

## Versions & releases

| Version | Notes |
|---|---|
| 4.0.1 | Version actuelle — stable |

Les releases sont gérées automatiquement via GitHub Actions.  
Voir : [Releases GitHub](https://github.com/Geoventure-MC/Launcher/releases)

---

## Scripts utiles

```bash
# Dev
npm run dev

# Build local
npm run build

# Snapshot contexte (pour IA / debugging)
./memory.sh
./memory.sh --full --clip
```

---

## Ressources externes

| Ressource | Lien |
|---|---|
| Azuriom | https://azuriom.com |
| AzLink (plugin auth) | https://azuriom.com/fr/azlink |
| electron-builder | https://www.electron.build |
| minecraft-java-core | https://www.npmjs.com/package/minecraft-java-core-azbetter |
| Discord support | https://discord.gg/VCmNXHvf77 |

---

## Checklist déploiement

- [ ] Bumper version dans `package.json`
- [ ] Vérifier que le backend Azuriom est à jour
- [ ] Tester en local (`npm run dev`)
- [ ] Commit + push sur `main`
- [ ] Vérifier la Release sur GitHub
- [ ] Tester l'auto-update depuis la version précédente
