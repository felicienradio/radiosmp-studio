# RadioSMP Studio (Flux) : dashboard de gestion Icecast

Tableau de bord web pour piloter un serveur **Icecast** et suivre l'audience de **RadioSMP** avec de **vraies statistiques** :
chaque auditeur, chaque connexion et chaque titre diffusé sont enregistrés dans une base locale.
Fonctionne dans un **conteneur LXC Debian** (Proxmox) comme sous Windows.

![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.13-339933) ![Icecast](https://img.shields.io/badge/icecast-2.4%20%2F%202.5-0b5394)

## Fonctionnalités

**Statistiques d'audience** (relevées toutes les 5 s, conservées 1 an par défaut, comparées à la période précédente)
- Auditeurs uniques, connexions totales, temps d'écoute (format « 659h12 »), pays touchés
- Pic et moyenne d'auditeurs simultanés, durée moyenne et médiane d'écoute, fidélité, nouveaux auditeurs
- Évolution jour par jour : auditeurs uniques, connexions, minutes d'écoute
- Distribution horaire et par jour de la semaine, carte de chaleur jour × heure
- **Carte du monde des écoutes** : pays colorés selon l'audience, une bulle par ville
- Top pays et top villes, supports d'écoute (smartphone, PC, tablette, enceinte connectée, TV, voiture…),
  lecteurs et applis, systèmes, durée des sessions, audience par flux
- Encadrés « À retenir » rédigés automatiquement (pic d'audience, créneau le plus écouté, 1er pays…)
- **Rapport d'audience** imprimable et exportable en PDF (7 jours, 30 jours, 3 mois, 1 an, mois précédent)
- Historique des sessions avec export CSV, historique des titres diffusés avec auditeurs gagnés ou perdus

**Gestion**
- Création et modification des points de montage, chacun avec **son propre mot de passe de diffusion**
  (généré automatiquement, régénérable en un clic) : un animateur ne peut diffuser que sur son flux
- Flux de secours, relais d'un autre serveur, limite d'auditeurs, visibilité
- Infos de connexion prêtes à copier pour l'encodeur (BUTT, Mixxx, RadioBOSS, VestaLive, OBS…)
  et pour les auditeurs (lien direct, M3U, XSPF, lecteur à intégrer)
- Démarrage, arrêt, redémarrage d'Icecast, redémarrage automatique en cas de plantage
- Auditeurs en direct (ville, appareil, lecteur), déconnexion, déplacement vers un autre flux
- Changement du titre en cours, coupure d'une source, journal des événements et logs Icecast

## Installation dans un conteneur LXC (Debian 12 / 13)

1. Créez un conteneur Debian 12 ou 13 (1 cœur, 512 Mo de RAM et 4 Go de disque suffisent pour démarrer).
2. Copiez le projet dans le conteneur. Depuis ce PC, dans le dossier du projet :
   ```bash
   git archive -o flux.tar.gz HEAD
   ```
   ```bash
   scp flux.tar.gz root@IP-DU-CONTENEUR:/root/
   ```
   Puis dans le conteneur :
   ```bash
   mkdir -p /root/flux && tar -xzf /root/flux.tar.gz -C /root/flux
   ```
3. Lancez l'installation, en root :
   ```bash
   bash /root/flux/scripts/install-lxc.sh
   ```
4. Ouvrez `http://IP-DU-CONTENEUR:3000` et choisissez le mot de passe du dashboard.

Le script installe Icecast (paquet Debian, version 2.4.4) et Node.js 22, crée l'utilisateur `flux`
(Icecast refuse de tourner en root), copie l'application dans `/opt/flux` et crée le service `flux`
qui démarre avec le conteneur. Le service Icecast de Debian est désactivé : c'est le dashboard qui lance Icecast
avec sa propre configuration.

- Journaux : `journalctl -u flux -f`
- Redémarrer le dashboard : `systemctl restart flux` (Icecast continue de diffuser pendant ce temps)
- **Mise à jour** : copiez la nouvelle version puis relancez le script ; les réglages et statistiques (`/opt/flux/data`) sont conservés.
- Options : `DASHBOARD_PORT=8080 TZ_STATION=Europe/Paris bash scripts/install-lxc.sh`

Pour que la radio soit écoutée depuis Internet, redirigez le port 8000 vers l'IP du conteneur sur votre box
et mettez votre nom de domaine dans **Nom d'hôte public** (page Serveur). Pour ouvrir le dashboard depuis Internet,
passez par un reverse proxy en HTTPS (Nginx Proxy Manager, Caddy…).

## Installation sous Windows

1. Installer [Node.js](https://nodejs.org) 22.13 ou plus récent.
2. Installer Icecast : `powershell -ExecutionPolicy Bypass -File scripts\install-icecast.ps1`
3. Double-cliquer sur `start.cmd` (ou `npm install` puis `npm start`) et ouvrir <http://127.0.0.1:3000>.

## Premiers pas

1. Page **Serveur** : nom d'hôte public, puis **Base villes + pays** dans « Géolocalisation » pour activer la carte du monde
   et le top pays (base DB-IP Lite gratuite, environ 60 Mo, les auditeurs déjà enregistrés sont localisés aussi).
2. Page **Flux** : créez vos points de montage. Chacun reçoit un mot de passe de diffusion ; cliquez sur **Connexion**
   pour obtenir les réglages à donner à l'animateur (type de serveur **Icecast 2**, adresse, port 8000, point de montage,
   utilisateur, mot de passe).
3. Appliquez la configuration avec le bandeau **Appliquer maintenant** (Icecast redémarre, les auditeurs sont coupés quelques secondes).

Pour vérifier que tout fonctionne sans logiciel de diffusion (nécessite ffmpeg) :

```bash
npm run test-source -- /live
```

## Comment sont calculées les statistiques

- Le dashboard interroge l'interface d'administration d'Icecast (`/admin/stats` et `/admin/listclients`) toutes les 5 secondes.
- **Connexions** : chaque connexion d'un lecteur au flux. **Auditeurs uniques** : adresses IP distinctes.
- **Temps d'écoute** : somme des durées d'écoute de tous les auditeurs sur la période.
- Les connexions de moins de 5 secondes (sondes de lecteurs, prévisualisations) comptent comme connexions,
  mais pas dans les durées moyennes ni dans la répartition des durées.
- Répartitions horaires et jours de la semaine : selon l'heure de début de la connexion, dans le fuseau de la station
  (Europe/Paris par défaut, réglable), même si le serveur est en UTC.
- **Fidélité** : part des auditeurs de la période déjà venus avant elle.
- Supports d'écoute, lecteurs et systèmes : déduits du user-agent des lecteurs.
- Les données sont dans `data/flux.db` (SQLite).

## Structure

```
server/
  index.js          serveur web et API
  collector.js      relevé des statistiques
  stats.js          calcul des statistiques et des « À retenir »
  time.js           calculs dans le fuseau horaire de la station
  geo.js            géolocalisation (DB-IP Lite)
  icecast/          pilotage du processus, génération de la config (2.4 et 2.5), client de l'API admin
public/             interface (HTML/CSS/JS sans étape de build, Chart.js, Leaflet)
scripts/            installation LXC et Windows, diffusion de test
data/               créé au premier lancement (non versionné)
```

## Licences

Code sous licence MIT. Géolocalisation : [IP Geolocation by DB-IP](https://db-ip.com) (CC BY 4.0).
Fond de carte : [Natural Earth](https://www.naturalearthdata.com) (domaine public) via world-atlas.
Drapeaux : flag-icons (MIT). Logo et identité visuelle : © RadioSMP.
