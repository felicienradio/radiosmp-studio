# Installer RadioSMP Studio sur Proxmox (conteneur LXC)

Ce guide crée un conteneur LXC Debian sur Proxmox, puis y installe Icecast et le dashboard.
Comptez environ 10 minutes. Toutes les commandes sont à copier-coller.

> Les commandes marquées **[Proxmox]** se lancent dans le shell de l'hôte Proxmox
> (interface web → nœud → *Shell*, ou `ssh root@IP-DE-PROXMOX`).
> Celles marquées **[Conteneur]** se lancent dans le conteneur (`pct enter NUMÉRO` depuis l'hôte).

---

## Méthode rapide (tout en une fois)

Depuis ton PC Windows, dans le dossier du projet, fabrique l'archive et envoie-la sur l'hôte Proxmox :

```bash
git archive -o flux.tar.gz HEAD
```
```bash
scp flux.tar.gz scripts/proxmox-create-ct.sh root@IP-DE-PROXMOX:/root/
```

**[Proxmox]** Crée le conteneur et installe tout :

```bash
ARCHIVE=/root/flux.tar.gz bash /root/proxmox-create-ct.sh
```

Le script demande le mot de passe root du conteneur, puis affiche l'adresse du dashboard
(`http://IP-DU-CONTENEUR:3000`). Passe directement à l'[étape 4](#étape-4--premier-lancement).

Pour une **IP fixe** (recommandé pour une radio) :

```bash
IP=192.168.100.50/24 GW=192.168.100.1 ARCHIVE=/root/flux.tar.gz bash /root/proxmox-create-ct.sh
```

Autres réglages possibles devant la commande : `CTID=150` (numéro du conteneur), `STORAGE=local-zfs`,
`BRIDGE=vmbr1`, `DISK=16` (Go), `MEMORY=2048` (Mo), `CORES=2`, `DEBIAN=12`,
`SSH_KEY=/root/.ssh/authorized_keys` (pour se connecter en SSH au conteneur avec ta clé).

---

## Méthode détaillée (pas à pas)

### Étape 1 : créer le conteneur

**[Proxmox]** Télécharge le modèle Debian 13 :

```bash
pveam update
```
```bash
pveam available --section system | grep debian-13
```
```bash
pveam download local debian-13-standard_13.1-2_amd64.tar.zst
```

(remplace le nom du fichier par celui affiché par la commande précédente)

**[Proxmox]** Crée le conteneur (ici numéro 150, IP fixe 192.168.100.50 : adapte à ton réseau) :

```bash
pct create 150 local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst --hostname radiosmp-studio --cores 2 --memory 1024 --swap 512 --rootfs local-lvm:8 --net0 name=eth0,bridge=vmbr0,ip=192.168.100.50/24,gw=192.168.100.1 --unprivileged 1 --features nesting=1 --onboot 1 --timezone Europe/Paris --password 'MOT-DE-PASSE-ROOT'
```

Remplace `MOT-DE-PASSE-ROOT` par le mot de passe root voulu pour le conteneur.

Pour une IP automatique, remplace `ip=192.168.100.50/24,gw=192.168.100.1` par `ip=dhcp`.

**[Proxmox]** Démarre-le et entre dedans :

```bash
pct start 150
```
```bash
pct enter 150
```

### Étape 2 : récupérer le projet dans le conteneur

Le dépôt GitHub est **privé** : le conteneur a besoin d'une clé pour le lire. On utilise une *deploy key*
(clé en lecture seule, valable uniquement pour ce dépôt).

**[Conteneur]** Installe git et crée la clé :

```bash
apt-get update && apt-get install -y git curl ca-certificates
```
```bash
ssh-keygen -t ed25519 -N "" -C radiosmp-studio -f /root/.ssh/radiosmp_deploy
```
```bash
cat /root/.ssh/radiosmp_deploy.pub
```

Ajoute cette clé publique sur GitHub : dépôt **radiosmp-studio** → *Settings* → *Deploy keys* → *Add deploy key*
(laisse *Allow write access* décoché). Ou, depuis ton PC Windows avec GitHub CLI :

```bash
gh repo deploy-key add cle.pub --repo felicienradio/radiosmp-studio --title "conteneur radiosmp-studio"
```

(après avoir collé le contenu affiché dans un fichier `cle.pub`)

**[Conteneur]** Dis à git d'utiliser cette clé, puis clone le dépôt :

```bash
printf 'Host github.com\n  IdentityFile /root/.ssh/radiosmp_deploy\n  IdentitiesOnly yes\n' >> /root/.ssh/config
```
```bash
ssh-keyscan github.com >> /root/.ssh/known_hosts
```
```bash
git clone git@github.com:felicienradio/radiosmp-studio.git /root/radiosmp-studio
```

> Sans GitHub : envoie l'archive depuis ton PC (`git archive -o flux.tar.gz HEAD` puis
> `scp flux.tar.gz root@IP-DE-PROXMOX:/root/`), puis **[Proxmox]** `pct push 150 /root/flux.tar.gz /root/flux.tar.gz`
> et **[Conteneur]** `mkdir -p /root/radiosmp-studio && tar -xzf /root/flux.tar.gz -C /root/radiosmp-studio`.

### Étape 3 : installer

**[Conteneur]**

```bash
bash /root/radiosmp-studio/scripts/install-lxc.sh
```

Le script :
- installe Icecast (paquet Debian 2.4.4) et désactive son service par défaut (c'est le dashboard qui le lance) ;
- installe Node.js 22 ;
- crée l'utilisateur `flux` (Icecast refuse de tourner en root) ;
- copie l'application dans `/opt/flux` et crée le service `flux`, lancé au démarrage du conteneur.

À la fin, il affiche l'adresse du dashboard.

### Étape 4 : premier lancement

1. Ouvre `http://IP-DU-CONTENEUR:3000` et **choisis le mot de passe** du dashboard.
2. Page **Serveur** :
   - **Nom d'hôte public** : ton nom de domaine (ex. `stream.radiosmp.fr`) ou ton IP publique ;
   - **Géolocalisation** → **Base villes + pays** (60 Mo) pour la carte du monde et le top pays ;
   - **Enregistrer**.
3. Page **Flux** : crée tes points de montage (`/live`, `/rap`…). Chacun a son mot de passe de diffusion.
4. Clique sur **Appliquer maintenant** dans le bandeau pour redémarrer Icecast avec la nouvelle configuration.
5. Sur chaque flux, **Connexion** affiche les réglages à donner à l'animateur.

Voir aussi le [guide d'utilisation](UTILISATION.md).

---

## Ouvrir la radio sur Internet

1. Sur ta box / ton routeur, redirige le **port 8000** (TCP) vers l'IP du conteneur : c'est le port d'écoute d'Icecast.
2. Si le pare-feu Proxmox est activé sur le conteneur, autorise les ports 8000 (tout le monde) et 3000 (réseau local seulement).
   Le plus simple est l'interface web : conteneur → *Firewall* → *Add*. En ligne de commande, si le fichier `150.fw` n'existe pas encore :

**[Proxmox]**
```bash
cat >> /etc/pve/firewall/150.fw <<'EOF'
[RULES]
IN ACCEPT -p tcp -dport 8000 -log nolog
IN ACCEPT -p tcp -dport 3000 -source 192.168.100.0/24 -log nolog
EOF
```

3. Le dashboard (port 3000) ne doit **pas** être ouvert directement sur Internet. Pour y accéder de l'extérieur,
   passe par un reverse proxy en HTTPS (Nginx Proxy Manager, Caddy, Traefik) ou un VPN (WireGuard, Tailscale).

Exemple Caddy (sur la machine qui fait reverse proxy) :

```
studio.radiosmp.fr {
    reverse_proxy 192.168.100.50:3000
}
stream.radiosmp.fr {
    reverse_proxy 192.168.100.50:8000
}
```

---

## Mettre à jour

**[Conteneur]**

```bash
cd /root/radiosmp-studio && git pull && bash scripts/install-lxc.sh
```

Les réglages, mots de passe et statistiques (`/opt/flux/data`) sont conservés. Icecast continue de diffuser
pendant la mise à jour du dashboard.

---

## Commandes utiles

**[Conteneur]**

| Action | Commande |
|---|---|
| État du dashboard | `systemctl status flux` |
| Journaux en direct | `journalctl -u flux -f` |
| Redémarrer le dashboard | `systemctl restart flux` |
| Logs Icecast | `tail -f /opt/flux/data/icecast/log/error.log` |
| Config Icecast générée | `cat /opt/flux/data/icecast/icecast.xml` |
| Signal de test sur /live | `apt-get install -y ffmpeg && cd /opt/flux && runuser -u flux -- npm run test-source -- /live` |
| Mot de passe du dashboard oublié | `systemctl stop flux && runuser -u flux -- node -e "const f='/opt/flux/data/settings.json',s=require(f);s.dashboard.passwordHash=null;require('fs').writeFileSync(f,JSON.stringify(s,null,2))" && systemctl start flux` puis rouvrir le dashboard |

**[Proxmox]**

| Action | Commande |
|---|---|
| Sauvegarde du conteneur | `vzdump 150 --mode snapshot --compress zstd` |
| Entrer dans le conteneur | `pct enter 150` |
| Redémarrer le conteneur | `pct reboot 150` |

---

## Dépannage

**Le dashboard ne répond pas** : `systemctl status flux` puis `journalctl -u flux -n 50`.

**« Le port 8000 est déjà utilisé »** : le service Icecast de Debian tourne encore.
```bash
systemctl disable --now icecast2 && systemctl restart flux
```

**Icecast s'arrête au démarrage** : regarde la fin de `/opt/flux/data/icecast/log/error.log`
(souvent un port déjà pris ou une erreur dans un point de montage relais).

**Les heures des stats sont décalées** : page Serveur → **Fuseau horaire des statistiques** = `Europe/Paris`.

**Pas de pays ni de carte** : page Serveur → **Base villes + pays**. Les auditeurs en réseau local apparaissent
comme « Réseau local ».

---

## Désinstaller

**[Conteneur]**
```bash
systemctl disable --now flux && rm -rf /opt/flux /etc/systemd/system/flux.service && userdel flux
```

Ou supprime simplement le conteneur **[Proxmox]** : `pct stop 150 && pct destroy 150`.
