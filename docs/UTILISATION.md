# Guide d'utilisation de RadioSMP Studio

## Les pages

| Page | À quoi elle sert |
|---|---|
| **Tableau de bord** | Auditeurs en direct, courbe de la dernière heure, vos flux, chiffres des 24 dernières heures (comparés à la veille), top pays, activité récente |
| **Flux** | Créer, modifier, supprimer les points de montage ; mots de passe de diffusion ; infos de connexion ; changer le titre ; couper une source |
| **Auditeurs** | Qui écoute en ce moment : ville, appareil, lecteur, durée ; déconnecter un auditeur ; déplacer tous les auditeurs d'un flux vers un autre |
| **Statistiques** | Toutes les stats sur la période choisie (1 h à 1 an, ou dates précises), par flux ou tous flux confondus |
| **Rapport d'audience** | Le rapport complet, mis en page, à exporter en PDF |
| **AutoDJ** | Diffusion automatique 24 h/24 : titre en cours, à suivre, passer un titre, réglages, grille horaire |
| **Playlists** | Créer des playlists de musique ou de jingles, en ordre ou en aléatoire |
| **Bibliothèque** | Envoyer vos musiques (glisser-déposer), les écouter, les ranger dans des playlists |
| **Personnalisation** | Nom, logos, couleurs, police et thème du dashboard |
| **Titres diffusés** | Ce qui passe à l'antenne, l'historique des titres et les plus diffusés, avec les auditeurs gagnés ou perdus pendant chaque titre |
| **Journal** | Connexions et coupures des sources, pannes, changements de configuration, logs d'Icecast |
| **Serveur** | Démarrer / arrêter Icecast, réglages (nom d'hôte, port, mots de passe, limites, fuseau horaire), géolocalisation, mot de passe du dashboard |

## Créer un point de montage

1. **Flux** → **Nouveau point de montage**.
2. Renseigne le chemin (`/live`, `/rap`, `/hits.mp3`…), le nom affiché, la description et le genre.
3. **Accès diffusion** : un mot de passe est généré automatiquement si tu laisses le champ vide.
4. Optionnel :
   - **Auditeurs max.** pour limiter un flux ;
   - **Flux de secours** : si l'animateur coupe, les auditeurs basculent sur ce flux au lieu d'être déconnectés,
     puis reviennent automatiquement quand il se reconnecte ;
   - **Relais** : pour rediffuser un flux qui existe déjà ailleurs (ex. un flux AzuraCast).
5. **Créer**, puis **Appliquer maintenant** dans le bandeau (Icecast redémarre en quelques secondes).

**Supprimer un flux** : bouton 🗑 sur la carte du flux (ou **Modifier** → **Supprimer**). Un encodeur encore connecté est
déconnecté, et les flux qui l'utilisaient comme secours n'en ont plus. Coche **Effacer aussi ses statistiques** pour
supprimer son historique ; sinon, il reste dans les stats et apparaît dans **Anciens flux** en bas de la page **Flux**,
d'où tu peux l'effacer plus tard. Termine par **Appliquer maintenant**.

## Donner l'accès à un animateur

Chaque point de montage a **son propre mot de passe** : un animateur ne peut diffuser que sur le flux dont il a les identifiants.

1. **Flux** → **Connexion** sur le flux concerné.
2. Envoie-lui le bloc *Pour votre logiciel de diffusion* : type **Icecast 2**, adresse, port, point de montage, utilisateur, mot de passe.
3. Pour lui retirer l'accès : bouton ↻ à côté du mot de passe sur la carte du flux, puis **Appliquer maintenant**.

### Exemple : BUTT (Broadcast Using This Tool)

*Settings* → *Main* → *Server* → *Add* :

| Champ BUTT | Valeur |
|---|---|
| Type | Icecast |
| Address | ton nom d'hôte public (ex. `stream.radiosmp.fr`) ou l'IP du conteneur |
| Port | `8000` |
| Password | le mot de passe du flux |
| Icecast mountpoint | `/live` (le chemin du flux) |
| Icecast user | `source` (ou l'utilisateur indiqué) |

Dans *Stream*, choisis MP3 ou AAC, 128 ou 192 kbps. Pour que le titre s'affiche, active *Update song name* dans *Settings* → *Stream*.

### Exemple : Mixxx

*Préférences* → *Diffusion en direct* : Type **Icecast 2**, hôte, port `8000`, point de montage, login `source`, mot de passe du flux.

## L'AutoDJ (diffusion automatique)

1. **Bibliothèque** : glisse tes fichiers (MP3, AAC/M4A, OGG, Opus, FLAC, WAV) dans la zone d'envoi.
   Titre et artiste sont lus dans les tags du fichier, sinon dans son nom (« Artiste - Titre.mp3 »). Modifiables ensuite (✎).
2. **Playlists** : crée une playlist « Musique » (ex. *Hits*), choisis *Aléatoire* ou *Dans l'ordre*, puis **Ajouter des titres**.
   Pour les jingles, crée une playlist de type « Jingles ».
3. **AutoDJ** :
   - **Configurer** (bandeau du haut), puis **Appliquer maintenant** : crée le flux `/autodj` et en fait le **secours de `/live`**.
     Les auditeurs de `/live` entendent l'AutoDJ ; quand un animateur se connecte sur `/live`, il prend l'antenne
     automatiquement, et l'AutoDJ reprend dès qu'il coupe ;
   - **Réglages** : playlist par défaut, playlist de jingles et fréquence (« un jingle tous les N titres »), format et débit ;
   - **Démarrer l'AutoDJ**. Il redémarre tout seul avec le dashboard.
4. **Grille horaire** : ajoute des créneaux (jours + heures → playlist), par exemple *Hits* du lundi au vendredi de 7h à 10h,
   *Chill* le week-end. En dehors des créneaux, la playlist par défaut tourne.

Pendant la diffusion :
- **Passer** saute au titre suivant ;
- dans la Bibliothèque, le bouton « jouer ensuite » place un titre en tête de la file (*Demande*) ;
- les titres joués apparaissent dans **Titres diffusés** et dans les statistiques comme ceux d'un animateur.

### Les points cue

Chaque titre a trois repères, visibles dans la colonne **Cue** de la Bibliothèque et des Playlists :
- **IN** (cue in) : là où le titre commence, ce qui saute le silence du début ;
- **MIX** (enchaînement) : là où le titre suivant démarre, par-dessus la fin de celui-ci ;
- **OUT** (cue out) : là où le titre s'arrête, ce qui coupe le silence de la fin.

**Automatique** : chaque titre envoyé est analysé. Les silences sont coupés, et si la fin du titre est un fondu ou une
résonance, le point MIX est placé là où le son baisse : le titre suivant commence pendant ce fondu. Un titre qui finit
net s'enchaîne sans chevauchement. Pour analyser les titres déjà présents, utilise le bouton **Points cue automatiques**
de la Bibliothèque.

**À la main** : bouton ⏦ d'un titre. Glisse les repères sur la forme d'onde, ou tape les valeurs en secondes.
- Clique sur l'onde pour écouter à cet endroit ; le bouton ↓ place un repère à la position de lecture.
- **Écouter l'entrée** et **Écouter l'enchaînement** servent à vérifier ses réglages.
- Fondus d'entrée et de sortie possibles, en secondes.
- Un titre réglé à la main passe en « manuel » : l'analyse automatique n'y touche plus. **Détection automatique**
  remet les valeurs calculées.

Ça marche pareil pour les jingles, par exemple un jingle qui démarre sur la fin d'une musique. Pour que les titres
s'enchaînent sans se chevaucher, décoche **Enchaînements aux points cue** dans les réglages de l'AutoDJ : les silences
restent coupés. **Passer** fait un fondu de 1,5 s sur le titre en cours.

Conseil : règle l'AutoDJ dans le **même format et le même débit** que tes animateurs (ex. MP3 320 kbps) pour que le passage
de l'un à l'autre soit propre pour les auditeurs.

## Le buffer de démarrage

Dans **Flux** → **Modifier**, chaque point de montage a un **Buffer de démarrage** :
- **Faible latence** (buffer 0) : les auditeurs sont au plus près du direct (jeux, appels à l'antenne) ; le lecteur met 1 à 3 s à démarrer ;
- **Démarrage instantané** : le son part dès le clic sur Play, avec quelques secondes de décalage sur le direct.

## Les statistiques

- **Auditeurs uniques** : adresses IP différentes sur la période.
- **Connexions totales** : chaque fois qu'un lecteur se connecte (une même personne peut se connecter plusieurs fois).
- **Temps d'écoute** : cumul de toutes les écoutes (« 659h12 » = 659 heures et 12 minutes).
- **Pays touchés** : nombre de pays d'où vient au moins un auditeur.
- **Pic simultané** : le plus grand nombre de personnes connectées en même temps.
- **Fidélité** : part des auditeurs déjà venus avant la période.
- Les flèches ▲ ▼ comparent à la période précédente de même durée (ex. les 30 jours d'avant).
- Les encadrés **À retenir** résument le point important de chaque graphique.

Les stats sont enregistrées dès le premier lancement : plus le dashboard tourne, plus elles sont riches.
Pour les pays, les villes et la carte, installe la base **villes + pays** (page Serveur).

## Exporter le rapport en PDF

1. **Rapport d'audience** → choisis la période (7 jours, 30 jours, 3 mois, 1 an, mois précédent).
2. **Exporter en PDF** → dans la fenêtre d'impression, choisis *Enregistrer au format PDF*.
   Le rapport passe automatiquement en couleurs claires pour l'impression (format A4 paysage).

## Exporter les données brutes

**Statistiques** → **Historique des sessions** → **Exporter en CSV** (ouvrable dans Excel ou LibreOffice) :
une ligne par connexion avec début, fin, durée, flux, IP, pays, ville, appareil, lecteur.
