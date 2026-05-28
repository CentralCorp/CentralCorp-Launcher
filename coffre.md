---
tags: [launcher, minecraft, geoventure, index]
updated: 2026-05-28
version: auto (CI bump)
mc_version: 1.20.1
forge: 1.20.1-47.4.20
---

# Coffre — Geoventure Launcher

> Index principal du projet. Point d'entrée pour la navigation dans la documentation.

---

## Navigation rapide

### Documentation projet
- [[primer]] — Architecture, fichiers clés, workflow de dev
- [[hindsight]] — Décisions techniques, bugs résolus, TODO

### Code source critique
- `src/app.js` — Main process Electron
- `src/assets/js/utils/config.js` — Fetch panel API (utilise `pkg.settings`, PAS localStorage)
- `src/assets/js/utils/database.js` — Stockage local
- `src/assets/js/panels/home.js` — Lancement Minecraft, multi-serveur, anti-cheat
- `src/assets/js/panels/login.js` — Auth AZauth
- `src/assets/css/launcher.css` — `.panel` visibility + transitions
- `build.js` — Pipeline build (`publish: 'always'` obligatoire dans `builder.build()`)

### CI/CD
- `.github/workflows/ci.yml` — Auto-bump version + build 4 plateformes + publish GitHub Release

---

## Contexte serveur

| Paramètre | Valeur |
|---|---|
| Jeu | Minecraft Java Edition |
| Version | **1.20.1** |
| Mod loader | Forge `1.20.1-47.4.20` |
| env | `"panel"` (CentralCorp Installer — NE PAS CHANGER) |
| Panel config URL | `https://launcher.bmeouchi.fr/utils/api` |
| Auth Geoventure | `https://geoventure.bmeouchi.fr/` |
| Auth Elandor | TBD |
| Auth Pokeland | TBD |
| Serveur MC Geoventure | `84.235.238.100:25566` |

---

## Règles importantes

1. **`env` doit rester `"panel"`** — changer en `"azuriom"` casse toutes les routes API
2. **Ne pas toucher à la version** — le CI la bumpe automatiquement à chaque push
3. **`config.js` n'utilise pas localStorage** — ne pas réintroduire cet override
4. **localStorage** — sert uniquement aux préférences UI (serveur sélectionné dans `home.js`)

---

## Versions & releases

| Version | Date | Notes |
|---|---|---|
| 4.0.1 | 2026-05-28 | Première release CI |
| 4.0.x | auto | Auto-bump CI — voir [Releases GitHub](https://github.com/Geoventure-MC/Launcher/releases) |

---

## Scripts utiles

```bash
# Dev
npm run dev
npm start

# Vider localStorage si bug de connexion (dev uniquement)
rm -rf AppData/Launcher/Local\ Storage/
# PowerShell :
# Remove-Item -Recurse -Force ".\AppData\Launcher\Local Storage" -ErrorAction SilentlyContinue

# Snapshot contexte
./memory.sh
./memory.sh --full --clip
```

---

## Checklist déploiement

- [ ] Coder la feature / fix
- [ ] Tester en local (`npm start`)
- [ ] `git commit + push master`
- [ ] CI bumpe la version automatiquement
- [ ] Vérifier la Release sur [GitHub Releases](https://github.com/Geoventure-MC/Launcher/releases)
- [ ] Les joueurs reçoivent l'update au prochain lancement (auto)

---

## Ressources externes

| Ressource | Lien |
|---|---|
| CentralCorp Installer | https://github.com/CentralCorp/Installer/releases/latest |
| electron-builder | https://www.electron.build |
| minecraft-java-core | https://www.npmjs.com/package/minecraft-java-core-azbetter |
| Discord Geoventure | https://discord.gg/VCmNXHvf77 |
| Releases GitHub | https://github.com/Geoventure-MC/Launcher/releases |
