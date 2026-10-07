#!/usr/bin/env bash
# À lancer sur l'HÔTE Proxmox (shell root) : crée le conteneur LXC Debian de RadioSMP Studio.
#
# Exemples (le conteneur est créé puis RadioSMP Studio y est installé depuis GitHub) :
#   bash <(curl -fsSL https://raw.githubusercontent.com/felicienradio/radiosmp-studio/main/scripts/proxmox-create-ct.sh)
#   IP=192.168.100.50/24 GW=192.168.100.1 bash proxmox-create-ct.sh
#   NO_INSTALL=1 bash proxmox-create-ct.sh                      # crée seulement le conteneur
#   ARCHIVE=/root/flux.tar.gz bash proxmox-create-ct.sh         # installe depuis une archive locale
#
# Variables : CTID, CT_HOSTNAME, STORAGE, TEMPLATE_STORAGE, BRIDGE, IP, GW, DISK (Go), CORES,
#             MEMORY (Mo), DEBIAN (12 ou 13), SSH_KEY (fichier de clé publique), ARCHIVE, NO_INSTALL
set -euo pipefail

CTID=${CTID:-$(pvesh get /cluster/nextid)}
CT_HOSTNAME=${CT_HOSTNAME:-radiosmp-studio}
STORAGE=${STORAGE:-local-lvm}
TEMPLATE_STORAGE=${TEMPLATE_STORAGE:-local}
BRIDGE=${BRIDGE:-vmbr0}
IP=${IP:-dhcp}
GW=${GW:-}
DISK=${DISK:-8}
CORES=${CORES:-2}
MEMORY=${MEMORY:-1024}
DEBIAN=${DEBIAN:-13}
SSH_KEY=${SSH_KEY:-}
ARCHIVE=${ARCHIVE:-}
INSTALL_URL=${INSTALL_URL:-https://raw.githubusercontent.com/felicienradio/radiosmp-studio/main/scripts/install-lxc.sh}

step() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }

command -v pct >/dev/null || { echo "Ce script se lance sur l'hôte Proxmox (commande pct introuvable)." >&2; exit 1; }
if pct status "$CTID" >/dev/null 2>&1; then
  echo "Le conteneur $CTID existe déjà. Choisissez un autre numéro : CTID=123 bash $0" >&2
  exit 1
fi

step "Modèle Debian ${DEBIAN}"
pveam update >/dev/null
TEMPLATE=$(pveam available --section system | awk '{print $2}' | grep "^debian-${DEBIAN}-standard" | sort -V | tail -1)
[ -n "$TEMPLATE" ] || { echo "Aucun modèle debian-${DEBIAN}-standard trouvé." >&2; exit 1; }
if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE"; then
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi
echo "Modèle : $TEMPLATE"

step "Création du conteneur ${CTID} (${CT_HOSTNAME})"
NET="name=eth0,bridge=${BRIDGE},ip=${IP}"
[ -n "$GW" ] && NET="${NET},gw=${GW}"
read -r -s -p "Mot de passe root du conteneur : " CT_PASSWORD
echo
EXTRA=()
[ -n "$SSH_KEY" ] && EXTRA+=(--ssh-public-keys "$SSH_KEY")
pct create "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
  --hostname "$CT_HOSTNAME" \
  --cores "$CORES" --memory "$MEMORY" --swap 512 \
  --rootfs "${STORAGE}:${DISK}" \
  --net0 "$NET" \
  --unprivileged 1 --features nesting=1 \
  --onboot 1 --timezone Europe/Paris \
  --password "$CT_PASSWORD" \
  "${EXTRA[@]}"
unset CT_PASSWORD

step "Démarrage"
pct start "$CTID"
for _ in $(seq 1 30); do
  CT_IP=$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}') || true
  [ -n "${CT_IP:-}" ] && break
  sleep 2
done
pct exec "$CTID" -- bash -c "apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q git curl ca-certificates"

if [ -n "$ARCHIVE" ]; then
  step "Installation de RadioSMP Studio depuis ${ARCHIVE}"
  pct push "$CTID" "$ARCHIVE" /root/flux.tar.gz
  pct exec "$CTID" -- bash -c "mkdir -p /root/radiosmp-studio && tar -xzf /root/flux.tar.gz -C /root/radiosmp-studio && bash /root/radiosmp-studio/scripts/install-lxc.sh"
elif [ -z "${NO_INSTALL:-}" ]; then
  step "Installation de RadioSMP Studio depuis GitHub"
  pct exec "$CTID" -- bash -c "curl -fsSL ${INSTALL_URL} | bash"
fi

step "Conteneur prêt"
echo "  Numéro : ${CTID}"
echo "  Adresse IP : ${CT_IP:-inconnue (voir pct exec ${CTID} -- hostname -I)}"
echo "  Entrer dans le conteneur : pct enter ${CTID}"
if [ -n "${NO_INSTALL:-}" ] && [ -z "$ARCHIVE" ]; then
  echo "  Installation : pct enter ${CTID}, puis curl -fsSL ${INSTALL_URL} | bash"
else
  echo "  Dashboard : http://${CT_IP:-IP}:3000"
fi
