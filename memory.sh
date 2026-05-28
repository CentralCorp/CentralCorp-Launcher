#!/usr/bin/env bash
# memory.sh — Capture le contexte du projet Geoventure Launcher
# Usage : ./memory.sh [--full] [--clip]
#   --full  : inclut le contenu des fichiers clés
#   --clip  : copie la sortie dans le presse-papier (xclip/pbcopy)

set -euo pipefail

FULL=false
CLIP=false

for arg in "$@"; do
  case $arg in
    --full) FULL=true ;;
    --clip) CLIP=true ;;
  esac
done

OUTPUT=""

snapshot() {
  OUTPUT+="$1\n"
}

# ── En-tête ────────────────────────────────────────────────────────────────────
snapshot "# Geoventure Launcher — Snapshot contexte"
snapshot "Date      : $(date '+%Y-%m-%d %H:%M:%S')"
snapshot "Répertoire: $(pwd)"
snapshot ""

# ── Git ────────────────────────────────────────────────────────────────────────
snapshot "## Git"
snapshot "Branche   : $(git branch --show-current 2>/dev/null || echo 'N/A')"
snapshot "Dernier commit : $(git log -1 --oneline 2>/dev/null || echo 'N/A')"
snapshot "5 derniers commits :"
snapshot "$(git log -5 --oneline 2>/dev/null || echo '  (pas de repo git)')"
snapshot ""

# ── Version ───────────────────────────────────────────────────────────────────
if [ -f package.json ]; then
  VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "?")
  SETTINGS=$(node -p "require('./package.json').settings" 2>/dev/null || echo "?")
  ENV=$(node -p "require('./package.json').env" 2>/dev/null || echo "?")
  snapshot "## Package"
  snapshot "Version   : $VERSION  (auto-bumped par CI à chaque push)"
  snapshot "Panel URL : $SETTINGS"
  snapshot "env       : $ENV  (panel = CentralCorp Installer, NE PAS CHANGER)"
  snapshot ""
fi

# ── URLs critiques ─────────────────────────────────────────────────────────────
snapshot "## URLs critiques"
snapshot "Panel config API : \${settings}/utils/api"
snapshot "Auth Geoventure  : https://geoventure.bmeouchi.fr/"
snapshot "Auth Elandor     : TBD"
snapshot "Auth Pokeland    : TBD"
snapshot ""

# ── Règles importantes ─────────────────────────────────────────────────────────
snapshot "## Règles à ne pas oublier"
snapshot "1. env DOIT rester 'panel' — 'azuriom' casse toutes les routes API"
snapshot "2. Ne pas bumper la version manuellement — CI le fait automatiquement"
snapshot "3. config.js n'utilise PAS localStorage (corrigé — ne pas réintroduire)"
snapshot "4. position:fixed dans panels → toujours vérifier visibility:hidden sur .panel"
snapshot ""

# ── Node/npm ──────────────────────────────────────────────────────────────────
snapshot "## Environnement"
snapshot "Node      : $(node --version 2>/dev/null || echo 'non installé')"
snapshot "npm       : $(npm --version 2>/dev/null || echo 'non installé')"
snapshot ""

# ── Fichiers modifiés récemment ───────────────────────────────────────────────
snapshot "## Fichiers modifiés (7 derniers jours)"
snapshot "$(find . -not -path './.git/*' -not -path './node_modules/*' -not -path './dist/*' -not -path './app/*' -newer package-lock.json -type f 2>/dev/null | head -20 || echo '  aucun')"
snapshot ""

# ── TODO ouvert ───────────────────────────────────────────────────────────────
snapshot "## TODO ouvert (voir hindsight.md pour détails)"
snapshot "- Renseigner les vraies URLs Elandor et Pokeland dans package.json"
snapshot "- Remettre message d'erreur propre dans index.js (actuellement en mode debug)"
snapshot "- Community mods tab → brancher sur la vraie API panel"
snapshot "- contextIsolation: true (sécurité Electron)"
snapshot ""

# ── Fichiers clés (mode --full) ───────────────────────────────────────────────
if [ "$FULL" = true ]; then
  snapshot "## package.json"
  snapshot "\`\`\`json"
  snapshot "$(cat package.json 2>/dev/null || echo 'introuvable')"
  snapshot "\`\`\`"
  snapshot ""

  snapshot "## .github/workflows/ci.yml"
  snapshot "\`\`\`yaml"
  snapshot "$(cat .github/workflows/ci.yml 2>/dev/null || echo 'introuvable')"
  snapshot "\`\`\`"
  snapshot ""

  if [ -f primer.md ]; then
    snapshot "## primer.md (extrait)"
    snapshot "$(head -80 primer.md)"
    snapshot ""
  fi

  if [ -f hindsight.md ]; then
    snapshot "## hindsight.md (extrait)"
    snapshot "$(head -60 hindsight.md)"
    snapshot ""
  fi

  snapshot "## src/assets/js/utils/config.js"
  snapshot "\`\`\`js"
  snapshot "$(cat src/assets/js/utils/config.js 2>/dev/null || echo 'introuvable')"
  snapshot "\`\`\`"
  snapshot ""
fi

# ── Sortie ─────────────────────────────────────────────────────────────────────
printf "%b" "$OUTPUT"

if [ "$CLIP" = true ]; then
  if command -v pbcopy &>/dev/null; then
    printf "%b" "$OUTPUT" | pbcopy
    echo "(copié dans le presse-papier via pbcopy)"
  elif command -v xclip &>/dev/null; then
    printf "%b" "$OUTPUT" | xclip -selection clipboard
    echo "(copié dans le presse-papier via xclip)"
  elif command -v xsel &>/dev/null; then
    printf "%b" "$OUTPUT" | xsel --clipboard --input
    echo "(copié dans le presse-papier via xsel)"
  else
    echo "(aucun outil clipboard disponible : pbcopy/xclip/xsel)"
  fi
fi
