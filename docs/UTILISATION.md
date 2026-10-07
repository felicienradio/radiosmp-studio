# Guide d'utilisation de RadioSMP Studio

## Les pages

| Page | À quoi elle sert |
|---|---|
| **Tableau de bord** | Auditeurs en direct, courbe de la dernière heure, vos flux, chiffres des 24 dernières heures (comparés à la veille), top pays, activité récente |
| **Flux** | Créer, modifier, supprimer les points de montage ; mots de passe de diffusion ; infos de connexion ; changer le titre ; couper une source |
| **Auditeurs** | Qui écoute en ce moment : ville, appareil, lecteur, durée ; déconnecter un auditeur ; déplacer tous les auditeurs d'un flux vers un autre |
| **Statistiques** | Toutes les stats sur la période choisie (1 h à 1 an, ou dates précises), par flux ou tous flux confondus |
| **Rapport d'audience** | Le rapport complet, mis en page, à exporter en PDF |
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
