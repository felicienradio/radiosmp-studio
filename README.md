# Flux : dashboard de gestion Icecast

Flux est un tableau de bord web pour piloter un serveur **Icecast** et suivre l'audience d'une webradio avec de **vraies statistiques** :
chaque auditeur, chaque session et chaque titre diffusé sont enregistrés dans une base locale.

![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.13-339933) ![Icecast](https://img.shields.io/badge/icecast-2.4%20%2F%202.5-0b5394)

## Fonctionnalités

**Statistiques (relevées toutes les 5 s, conservées 1 an par défaut)**
- Auditeurs en direct, courbe de la dernière heure, record d'auditeurs simultanés
- Pic, moyenne d'auditeurs simultanés, auditeurs uniques, sessions
- Heures d'écoute cumulées et durée moyenne d'écoute par session
- Fidélité (part des auditeurs déjà venus avant la période)
- Carte de chaleur jour × heure : quand vous écoute-t-on ?
- Répartition par lecteur (VLC, navigateurs, Alexa, Sonos, apps mobiles…), système et pays
- Distribution des durées d'écoute, tableau jour par jour, comparatif par flux
- Historique de toutes les sessions avec export CSV
- Historique des titres diffusés avec, pour chaque titre, les auditeurs gagnés ou perdus

**Gestion**
- Démarrage, arrêt et redémarrage d'Icecast depuis le dashboard, redémarrage automatique en cas de plantage
- Création et modification des points de montage : nom, description, genre, limite d'auditeurs,
  mot de passe dédié, flux de secours, relais d'un autre serveur, visibilité
- Infos de connexion prêtes à copier pour l'encodeur (BUTT, Mixxx, RadioBOSS, VestaLive, OBS…)
  et pour les auditeurs (lien direct, M3U, XSPF, code du lecteur à intégrer)
- Changement du titre en cours, coupure d'une source
- Liste des auditeurs en direct, déconnexion d'un auditeur, déplacement des auditeurs d'un flux à un autre
- Réglages du serveur : nom d'hôte, port, mots de passe, limites
- Journal des événements (connexions/déconnexions de sources, pannes, records) et logs Icecast
- Écoute des flux directement dans le dashboard
- Géolocalisation par pays (base DB-IP Lite installée en un clic, aucune IP envoyée à l'extérieur)
- Mode « serveur externe » pour suivre un Icecast installé ailleurs (VPS…)

## Installation (Windows)

1. Installer [Node.js](https://nodejs.org) 22.13 ou plus récent.
2. Installer Icecast (si ce n'est pas déjà fait) :
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\install-icecast.ps1
   ```
3. Lancer le dashboard en double-cliquant sur `start.cmd`, ou :
   ```bash
   npm install
   npm start
   ```
4. Ouvrir <http://127.0.0.1:3000> et choisir le mot de passe du dashboard.

Le dashboard démarre Icecast tout seul avec une configuration qu'il génère dans `data/icecast/icecast.xml`.
Les mots de passe Icecast (source, admin, relais) sont générés aléatoirement au premier lancement :
retrouvez-les sur la page **Serveur**.

Sous Linux ou macOS, installez Icecast avec le gestionnaire de paquets (`apt install icecast2`, `brew install icecast`) ;
le chemin de l'exécutable se règle sur la page Serveur.

## Diffuser

Sur la page **Flux**, cliquez sur **Connexion** pour obtenir les réglages à saisir dans votre logiciel de diffusion
(type de serveur **Icecast 2**, adresse, port 8000, point de montage, utilisateur `source`, mot de passe).

Pour vérifier que tout fonctionne sans logiciel de diffusion (nécessite [ffmpeg](https://ffmpeg.org)) :

```bash
npm run test-source
```

Cela diffuse un signal de test sur `/live` et change le titre toutes les 30 secondes.

## Rendre la radio accessible depuis Internet

1. Sur la page **Serveur**, mettez votre nom de domaine ou votre IP publique dans **Nom d'hôte public**.
2. Autorisez le port d'Icecast (8000 par défaut) dans le pare-feu Windows.
3. Redirigez ce port vers ce PC dans votre box internet.

Le dashboard, lui, n'écoute que sur `127.0.0.1` (ce PC uniquement). Pour y accéder depuis un autre appareil,
passez `dashboard.host` à `0.0.0.0` dans `data/settings.json`, de préférence derrière un reverse proxy en HTTPS.

## Lancer au démarrage de Windows

Créez un raccourci vers `start.cmd` dans le dossier de démarrage (`Win + R`, puis `shell:startup`).
Icecast continue de tourner si le dashboard est fermé, et le dashboard en reprend le contrôle à son prochain lancement.

## Comment sont calculées les statistiques

- Le dashboard interroge l'interface d'administration d'Icecast (`/admin/stats` et `/admin/listclients`)
  toutes les 5 secondes (réglable).
- L'audience est enregistrée minute par minute (moyenne et maximum), par flux.
- Chaque connexion d'auditeur devient une **session** (IP, lecteur, pays, début, fin). Les connexions de moins de 5 secondes
  (sondes de lecteurs, prévisualisations) sont exclues des comptages de sessions mais comptent dans les heures d'écoute.
- **Auditeurs uniques** = adresses IP distinctes sur la période.
- **Heures d'écoute** = somme des durées d'écoute de tous les auditeurs sur la période.
- Les données sont dans `data/flux.db` (SQLite).

## Structure

```
server/
  index.js          serveur web et API
  collector.js      relevé des statistiques
  stats.js          calcul des statistiques
  icecast/          pilotage du processus, génération de la config, client de l'API admin
public/             interface (HTML/CSS/JS sans étape de build, Chart.js)
scripts/            installation d'Icecast, diffusion de test
data/               créé au premier lancement (non versionné)
```

## Licence

MIT. Données de géolocalisation : [DB-IP](https://db-ip.com), licence CC BY 4.0.
