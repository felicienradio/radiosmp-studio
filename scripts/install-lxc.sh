#!/usr/bin/env bash
# Installe (ou met à jour) Flux, le dashboard Icecast de RadioSMP, dans un conteneur LXC
# Debian 12 / 13 (ou Ubuntu 22.04 / 24.04).
#
# Usage, en root, depuis le dossier du projet copié dans le conteneur :
#   bash scripts/install-lxc.sh
#
# Variables facultatives : APP_DIR (/opt/flux), DASHBOARD_PORT (3000), TZ_STATION (Europe/Paris),
#                         REPO_URL (dépôt GitHub pour les mises à jour), BRANCH (main)
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/flux}
APP_USER=${APP_USER:-flux}
DASHBOARD_PORT=${DASHBOARD_PORT:-3000}
TZ_STATION=${TZ_STATION:-Europe/Paris}
NODE_MAJOR=${NODE_MAJOR:-22}
REPO_URL=${REPO_URL:-git@github.com:felicienradio/radiosmp-studio.git}
BRANCH=${BRANCH:-main}
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

step() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Ce script doit être lancé en root." >&2
  exit 1
fi
. /etc/os-release
case "${ID:-}" in
  debian|ubuntu) ;;
  *) echo "Attention : système ${PRETTY_NAME:-inconnu} non testé (prévu pour Debian/Ubuntu)." >&2 ;;
esac

export DEBIAN_FRONTEND=noninteractive

step "Paquets de base"
apt-get update -q
apt-get install -y -q --no-install-recommends ca-certificates curl gnupg rsync git openssh-client

step "Icecast"
# On refuse la configuration interactive du paquet : c'est Flux qui génère la configuration
echo "icecast2 icecast2/icecast-setup boolean false" | debconf-set-selections
apt-get install -y -q --no-install-recommends icecast2
# Le service fourni par Debian occuperait le port 8000 : Flux lance Icecast lui-même
systemctl disable --now icecast2 >/dev/null 2>&1 || true
icecast2 -v || true

step "Node.js (22.13 minimum)"
need_node=1
if command -v node >/dev/null 2>&1; then
  v=$(node -p 'process.versions.node')
  major=${v%%.*}
  minor=$(echo "$v" | cut -d. -f2)
  if [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 13 ]; }; then need_node=0; fi
fi
if [ "$need_node" -eq 1 ]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -y -q nodejs
fi
node -v

step "Utilisateur ${APP_USER}"
# Icecast refuse de tourner en root : tout tourne sous un utilisateur dédié
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

step "Application dans ${APP_DIR}"
install -d "$APP_DIR"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  # data/ (réglages, statistiques) n'est jamais écrasé lors d'une mise à jour
  rsync -a --delete --exclude node_modules --exclude data --exclude .git --exclude .npm "$SRC_DIR"/ "$APP_DIR"/
fi
# Version installée (hash du commit) : sert à détecter les mises à jour
if git -C "$SRC_DIR" rev-parse HEAD >/dev/null 2>&1; then
  git -C "$SRC_DIR" rev-parse HEAD > "$APP_DIR/VERSION"
fi
install -d "$APP_DIR/data/update"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
cd "$APP_DIR"
runuser -u "$APP_USER" -- env HOME="$APP_DIR" npm ci --omit=dev --no-audit --no-fund

step "Service systemd"
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
cat > /etc/systemd/system/flux.service <<EOF
[Unit]
Description=Flux - dashboard Icecast
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=FLUX_HOST=0.0.0.0
Environment=FLUX_PORT=${DASHBOARD_PORT}
Environment=FLUX_TZ=${TZ_STATION}
Environment=FLUX_PUBLIC_HOST=${IP:-localhost}
ExecStart=$(command -v node) server/index.js
Restart=always
RestartSec=3
# Icecast est lancé par le dashboard : il continue de diffuser pendant un redémarrage ou une mise à jour du dashboard
KillMode=process
LimitNOFILE=65536
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
step "Mises à jour depuis GitHub"
install -d /etc/flux
if git -C "$SRC_DIR" rev-parse HEAD >/dev/null 2>&1; then REPO_DIR="$SRC_DIR"; else REPO_DIR=/opt/flux-src; fi
cat > /etc/flux/update.env <<EOF
APP_DIR=${APP_DIR}
APP_USER=${APP_USER}
REPO_DIR=${REPO_DIR}
REPO_URL=${REPO_URL}
BRANCH=${BRANCH}
EOF
# Le dashboard (utilisateur flux) dépose une demande ; systemd lance alors la mise à jour en root
cat > /etc/systemd/system/flux-update.path <<EOF
[Unit]
Description=Demandes de mise à jour du dashboard Flux

[Path]
PathExists=${APP_DIR}/data/update/request

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/flux-update.service <<EOF
[Unit]
Description=Mise à jour de Flux depuis GitHub

[Service]
Type=oneshot
ExecStart=/bin/bash ${APP_DIR}/scripts/update.sh run
EOF
cat > /etc/systemd/system/flux-update-check.service <<EOF
[Unit]
Description=Vérification des mises à jour de Flux

[Service]
Type=oneshot
ExecStart=/bin/bash ${APP_DIR}/scripts/update.sh check
EOF
cat > /etc/systemd/system/flux-update-check.timer <<EOF
[Unit]
Description=Vérification des mises à jour de Flux toutes les 6 heures

[Timer]
OnBootSec=10min
OnUnitActiveSec=6h
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable flux flux-update.path flux-update-check.timer >/dev/null 2>&1
systemctl start flux-update.path flux-update-check.timer
systemctl restart flux
# Première vérification (crée aussi la clé de déploiement affichée dans le dashboard)
[ -n "${FLUX_UPDATING:-}" ] || systemctl start --no-block flux-update-check.service

sleep 3
if systemctl is-active --quiet flux; then
  step "C'est prêt !"
  echo "  Dashboard : http://${IP:-IP-du-conteneur}:${DASHBOARD_PORT}"
  echo "  Icecast   : http://${IP:-IP-du-conteneur}:8000"
  echo
  echo "  Ouvrez le dashboard pour choisir votre mot de passe."
  echo "  Journaux : journalctl -u flux -f"
  echo "  Mises à jour : page Serveur du dashboard (ou : bash ${APP_DIR}/scripts/update.sh update)"
else
  echo "Le service ne démarre pas, voici les derniers messages :" >&2
  journalctl -u flux -n 40 --no-pager >&2
  exit 1
fi
