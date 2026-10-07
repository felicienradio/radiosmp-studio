#!/usr/bin/env bash
# Mise à jour de RadioSMP Studio depuis GitHub. Lancé en root par systemd :
#   - flux-update.service       à la demande du dashboard (bouton « Mettre à jour » / « Vérifier »)
#   - flux-update-check.timer   vérification automatique toutes les 6 heures
# Utilisable aussi à la main :  bash /opt/flux/scripts/update.sh check|update
#
# Tout est dans main() : bash lit la fonction en entier avant de l'exécuter, ce qui permet
# de remplacer ce fichier pendant la mise à jour sans risque.

main() {
  set -uo pipefail
  [ -f /etc/flux/update.env ] && . /etc/flux/update.env
  APP_DIR=${APP_DIR:-/opt/flux}
  APP_USER=${APP_USER:-flux}
  REPO_DIR=${REPO_DIR:-/opt/flux-src}
  REPO_URL=${REPO_URL:-https://github.com/felicienradio/radiosmp-studio.git}
  BRANCH=${BRANCH:-main}
  KEY=${DEPLOY_KEY:-/root/.ssh/radiosmp_deploy}
  UPD="$APP_DIR/data/update"
  export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes"

  mkdir -p "$UPD"
  local mode=${1:-check}
  if [ "$mode" = run ]; then
    mode=$(tr -dc 'a-z' < "$UPD/request" 2>/dev/null || true)
    rm -f "$UPD/request"
  fi
  [ "$mode" = update ] || mode=check

  # Clé de déploiement : seulement pour un dépôt privé (adresse git@github.com:…)
  case "$REPO_URL" in
    git@*|ssh://*) ensure_key ;;
    *) rm -f "$UPD/deploy_key.pub" ;;
  esac
  status state checking
  if ! ensure_repo; then
    case "$REPO_URL" in
      git@*|ssh://*) status state needs-key error "GitHub refuse l'accès : ajoutez la clé de déploiement au dépôt." ;;
      *) status state error error "Impossible de récupérer le dépôt : $(tail -n 2 "$UPD/git.err" | tr '\n' ' ')" ;;
    esac
    return 0
  fi
  if ! git -C "$REPO_DIR" fetch --quiet origin "$BRANCH" 2>"$UPD/git.err"; then
    status state error error "$(tail -n 3 "$UPD/git.err" | tr '\n' ' ')"
    return 0
  fi

  local current latest
  current=$(cat "$APP_DIR/VERSION" 2>/dev/null | tr -dc '0-9a-f')
  latest=$(git -C "$REPO_DIR" rev-parse "origin/$BRANCH")
  if [ -n "$current" ] && git -C "$REPO_DIR" cat-file -e "$current^{commit}" 2>/dev/null; then
    git -C "$REPO_DIR" log --format='%h%x09%cI%x09%s' "$current..origin/$BRANCH" > "$UPD/commits.tsv"
  else
    git -C "$REPO_DIR" log -n 15 --format='%h%x09%cI%x09%s' "origin/$BRANCH" > "$UPD/commits.tsv"
  fi
  if [ "$current" = "$latest" ]; then : > "$UPD/commits.tsv"; fi

  if [ "$mode" = check ]; then
    if [ "$current" = "$latest" ]; then
      status state uptodate latest "$latest"
    else
      status state available latest "$latest"
    fi
    return 0
  fi

  # Mise à jour : le dépôt suit exactement GitHub, puis l'installation recopie l'application
  status state updating latest "$latest"
  : > "$UPD/update.log"
  {
    echo "Mise à jour vers ${latest:0:7} — $(date '+%d/%m/%Y %H:%M:%S')"
    git -C "$REPO_DIR" reset --hard "origin/$BRANCH"
    FLUX_UPDATING=1 bash "$REPO_DIR/scripts/install-lxc.sh"
  } >> "$UPD/update.log" 2>&1
  if [ $? -eq 0 ]; then
    : > "$UPD/commits.tsv"
    status state done latest "$latest"
  else
    status state error latest "$latest" error "L'installation a échoué, voir le journal de mise à jour."
  fi
}

# Écrit status.env (clé=valeur), lu par le dashboard
status() {
  local file="$UPD/status.env"
  {
    echo "checked_at=$(date +%s)"
    while [ $# -ge 2 ]; do
      printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr '\n' ' ')"
      shift 2
    done
  } > "$file.tmp"
  mv "$file.tmp" "$file"
  chown -R "$APP_USER:$APP_USER" "$UPD" 2>/dev/null || true
}

# Clé SSH de déploiement (lecture seule) : sa partie publique est affichée dans le dashboard
ensure_key() {
  if [ ! -f "$KEY" ]; then
    install -d -m 700 "$(dirname "$KEY")"
    ssh-keygen -q -t ed25519 -N "" -C "radiosmp-studio@$(hostname)" -f "$KEY"
  fi
  cp "$KEY.pub" "$UPD/deploy_key.pub"
}

ensure_repo() {
  if [ -d "$REPO_DIR/.git" ]; then
    git -C "$REPO_DIR" remote set-url origin "$REPO_URL"
    return 0
  fi
  rm -rf "$REPO_DIR"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$REPO_DIR" 2>"$UPD/git.err"
}

main "$@"
exit $?
