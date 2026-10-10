# Installer RadioSMP Studio sur Proxmox (conteneur LXC)

Ce guide crée un conteneur LXC Debian sur Proxmox, puis y installe Icecast et le dashboard.
Comptez environ 10 minutes. Toutes les commandes sont à copier-coller.

> Les commandes marquées **[Proxmox]** se lancent dans le shell de l'hôte Proxmox
> (interface web → nœud → *Shell*, ou `ssh root@IP-DE-PROXMOX`).
> Celles marquées **[Conteneur]** se lancent dans le conteneur (`pct enter NUMÉRO` depuis l'hôte).

---

## Méthode rapide : une seule commande

**[Proxmox]** Crée le conteneur Debian 13 et installe tout depuis GitHub :

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/felicienradio/radiosmp-studio/main/scripts/proxmox-create-ct.sh)
```

Avec une **IP fixe** (recommandé pour une radio, adapte à ton réseau) :

```bash
IP=192.168.100.50/24 GW=192.168.100.1 bash <(curl -fsSL https://raw.githubusercontent.com/felicienradio/radiosmp-studio/main/scripts/proxmox-create-ct.sh)
```

Le script demande le mot de passe root du conteneur, puis affiche l'adresse du dashboard
(`http://IP-DU-CONTENEUR:3000`). Passe ensuite au [premier lancement](#premier-lancement).

Autres réglages possibles devant la commande : `CTID=150` (numéro du conteneur), `STORAGE=local-zfs`,
`BRIDGE=vmbr1`, `DISK=16` (Go), `MEMORY=2048` (Mo), `CORES=2`, `DEBIAN=12`,
`SSH_KEY=/root/.ssh/authorized_keys` (pour te connecter en SSH au conteneur avec ta clé),
`NO_INSTALL=1` (crée seulement le conteneur).

---

## Installer dans un conteneur existant

**[Conteneur]** Debian 12 ou 13, en root :

```bash
apt-get update && apt-get install -y curl
```
```bash
curl -fsSL https://raw.githubusercontent.com/felicienradio/radiosmp-studio/main/scripts/install-lxc.sh | bash
```

Le script :
- récupère le projet depuis GitHub (dans `/opt/flux-src`) ;
- installe Icecast (paquet Debian 2.4.4) et désactive son service par défaut (c'est le dashboard qui le lance) ;
- installe Node.js 22 ;
- crée l'utilisateur `flux` (Icecast refuse de tourner en root) ;
- installe l'application dans `/opt/flux`, crée le service `flux` lancé au démarrage du conteneur,
  et les services de mise à jour automatique.

**Déjà installé avec une ancienne version ?** La même commande met à jour en conservant tes réglages,
mots de passe et statistiques. C'est aussi ce qui active les mises à jour depuis le dashboard.

### Créer le conteneur à la main (sans le script)

**[Proxmox]**

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

```bash
pct create 150 local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst --hostname radiosmp-studio --cores 2 --memory 1024 --swap 512 --rootfs local-lvm:8 --net0 name=eth0,bridge=vmbr0,ip=192.168.100.50/24,gw=192.168.100.1 --unprivileged 1 --features nesting=1 --onboot 1 --timezone Europe/Paris --password 'MOT-DE-PASSE-ROOT'
```

Remplace `MOT-DE-PASSE-ROOT` ; pour une IP automatique, remplace `ip=…,gw=…` par `ip=dhcp`.

```bash
pct start 150 && pct enter 150
```

Puis suis [Installer dans un conteneur existant](#installer-dans-un-conteneur-existant).

---

## Premier lancement

1. Ouvre `http://IP-DU-CONTENEUR:3000` et **crée le compte administrateur** (pseudo + mot de passe). Les autres comptes
   (animateurs, lecture seule) se créent ensuite sur la page **Utilisateurs**.
2. Page **Serveur** :
   - **Nom d'hôte public** : ton nom de domaine (ex. `icecast.radiosmp.fr`) ou ton IP publique ;
   - **Adresse publique des flux (HTTPS)** : ex. `https://icecast.radiosmp.fr` (voir [Flux en HTTPS](#flux-en-https)) ;
   - **Géolocalisation** → **Base villes + pays** (60 Mo) pour la carte du monde et le top pays ;
   - **Enregistrer**.
3. Page **Flux** : crée tes points de montage (`/live`, `/rap`…). Chacun a son mot de passe de diffusion.
4. Clique sur **Appliquer maintenant** dans le bandeau pour redémarrer Icecast avec la nouvelle configuration.
5. Sur chaque flux, **Connexion** affiche les réglages à donner à l'animateur.

Voir aussi le [guide d'utilisation](UTILISATION.md).

---

## Ouvrir la radio sur Internet

1. Sur ta box / ton routeur, redirige le port d'Icecast (**8000** par défaut, TCP) vers l'IP du conteneur :
   c'est par là que se connectent les animateurs (encodeurs) et les anciens lecteurs en HTTP.
2. Si le pare-feu Proxmox est activé sur le conteneur, autorise ce port (tout le monde) et le port 3000
   (réseau local / reverse proxy seulement) : conteneur → *Firewall* → *Add*.
3. N'ouvre pas le port 3000 directement sur Internet : passe par un reverse proxy en HTTPS (ci-dessous).

### Flux en HTTPS

Le dashboard **relaie lui-même les flux** : derrière ton reverse proxy HTTPS, `https://ton-domaine/live` donne
directement le flux, sans certificat à configurer dans Icecast. Les statistiques gardent l'IP réelle de chaque auditeur.

1. Fais pointer ton domaine vers le dashboard (port 3000). Exemple Caddy :

```
icecast.radiosmp.fr {
    reverse_proxy 192.168.100.50:3000 {
        flush_interval -1
    }
}
```

`flush_interval -1` envoie l'audio sans le mettre en tampon. Avec Nginx : `proxy_buffering off;` dans le bloc `location`.

2. Dashboard → **Serveur** → **Adresse publique des flux (HTTPS)** : `https://icecast.radiosmp.fr` → **Enregistrer**.

Les liens à partager deviennent :
- flux : `https://icecast.radiosmp.fr/live`
- playlist : `https://icecast.radiosmp.fr/live.m3u`
- dashboard : `https://icecast.radiosmp.fr/` (protégé par ton mot de passe)

### Démarrage rapide du son

À la connexion, Icecast envoie d'un coup quelques secondes d'audio (« burst ») pour que le lecteur démarre aussitôt.
Le réglage est de 192 Ko (environ 5 s à 320 kbps, 12 s à 128 kbps) : **Serveur** → **Limites** → **Burst**.

---

## Mettre à jour

### Depuis le dashboard (recommandé)

**Serveur** → **Mises à jour** → **Vérifier**, puis **Mettre à jour**. Le dashboard télécharge la dernière version
sur GitHub, l'installe et redémarre (environ une minute). Icecast et les flux continuent de diffuser.
Une vérification automatique a lieu toutes les heures. Quand une nouvelle version est disponible, un bandeau et une pastille sur « Serveur » apparaissent, et le navigateur peut aussi afficher une notification (bouton « Recevoir aussi une notification » sur la page Serveur).

### En ligne de commande

**[Conteneur]**

```bash
bash /opt/flux/scripts/update.sh update
```

Vérifier seulement : `bash /opt/flux/scripts/update.sh check`. Journal : `cat /opt/flux/data/update/update.log`.

Les réglages, mots de passe et statistiques (`/opt/flux/data`) sont toujours conservés.

---

## Commandes utiles

**[Conteneur]**

| Action | Commande |
|---|---|
| État du dashboard | `systemctl status flux` |
| Journaux en direct | `journalctl -u flux -f` |
| Redémarrer le dashboard | `systemctl restart flux` |
| Journal des mises à jour | `journalctl -u flux-update -n 50` |
| Logs Icecast | `tail -f /opt/flux/data/icecast/log/error.log` |
| Config Icecast générée | `cat /opt/flux/data/icecast/icecast.xml` |
| Signal de test sur /live | `apt-get install -y ffmpeg && cd /opt/flux && runuser -u flux -- npm run test-source -- /live` |
| Mot de passe du dashboard oublié | `cd /opt/flux && runuser -u flux -- node scripts/reset-admin.js admin NouveauMotDePasse` : remet le mot de passe du compte `admin` (ou crée ce compte administrateur s'il n'existe pas), sans redémarrer |

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

**`https://…/live` affiche le dashboard au lieu du flux** : le point de montage n'existe pas ou n'est pas en direct
(vérifie la page Flux), ou la version installée est antérieure au relais HTTPS (mets à jour).

**Les heures des stats sont décalées** : page Serveur → **Fuseau horaire des statistiques** = `Europe/Paris`.

**Pas de pays ni de carte** : page Serveur → **Base villes + pays**. Les auditeurs en réseau local apparaissent
comme « Réseau local ».

---

## Désinstaller

**[Conteneur]**
```bash
systemctl disable --now flux flux-update.path flux-update-check.timer && rm -rf /opt/flux /opt/flux-src /etc/flux /etc/systemd/system/flux*.service /etc/systemd/system/flux*.path /etc/systemd/system/flux*.timer && userdel flux
```

Ou supprime simplement le conteneur **[Proxmox]** : `pct stop 150 && pct destroy 150`.
