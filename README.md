# UAV Maintenance

Application web de gestion technique des drones VTOL fixed wing **Tango 4** (MAL1, MAL2, MAL3) utilisés pour les livraisons de médicaments par largage vers les formations sanitaires (CSB) – UNFPA.

- **Front** : React + TypeScript + Vite, site statique hébergé sur **GitHub Pages**
- **Base de données & authentification** : **Supabase** (PostgreSQL + RLS). Aucun autre serveur.

## Fonctionnalités

| Module | Contenu |
|---|---|
| **Vols** | Type (**Livraison** / **Vol de contrôle**, CSB facultatif pour un contrôle), organisation (**UNFPA**, **MINSAN**, **Autres** à préciser), distance (reprise du CSB, modifiable), tensions de départ / d'arrivée (format `48,25 V`, estimation par cellule 12S), heures de décollage / largage / atterrissage (durée calculée, y compris au passage de minuit), poids du colis, vent moyen (m/s) et direction moyenne (°, provenance), pack de batteries, consommation (mAh et % du pack), batteries x2, 1 à 2 pilotes, destination CSB, observation simple |
| **Pièces & stock** | 24 types de pièces (catégories / sous-catégories, code à 3 lettres), codage automatique (`MOV0001`…), potentiel en heures par type ou par pièce avec alertes (≥ 90 %, dépassé). Vue visuelle du Tango 4 (10 zones cliquables) pour monter, démonter, remplacer ou mettre en quarantaine. Heures de chaque pièce = heures antérieures + vols du drone pendant ses périodes de montage. Stock par drone port avec seuils minimum, transferts, décision après quarantaine (stock / rebut), historique complet |
| **QR codes pièces** | QR généré automatiquement pour chaque code pièce (`MOV0001`…) : affiché sur la fiche pièce (téléchargement PNG / SVG), planche d'étiquettes imprimable (3 formats, exemplaires, n° de série) depuis l'inventaire (sélection ou filtre) ou juste après une entrée en stock. **Scanner** (caméra du téléphone / PC, ou douchette USB) pour ouvrir directement la fiche d'une pièce |
| **Consommation** | Analyse par période, drone port, CSB et/ou drone : mAh moyens, médiane et 90e centile (prévision de mission par CSB), mAh/km, mAh/min, Wh/km, part du pack utilisée, tension cellule en fin de vol, distance max. estimée (réserve 20 %), comparaison du drone avec le reste de la flotte. Nuage de points avec tendance (vent, charge, distance, altitude, durée), effet du vent, évolution, répartitions par CSB et par drone, vols anormaux (> 20 % au-dessus de la médiane du CSB), export CSV |
| **Tableau de bord** | **À faire** (actions en attente selon le rôle, avec lien direct : drones indisponibles, visites, pièces, batteries, CRM à signer, rapports, vols à clôturer, stock) · **Tendances 30 jours** avec courbes et écart vs 30 jours précédents · **Disponibilité de la flotte** (Prêt / Avec réserve / Indisponible et raisons : statut, visite 250 h, pièces, rapports, packs de batteries) · **Météo de vol** Open-Meteo par drone port (vent, rafales, pluie, verdict favorable / limite / défavorable, 12 h) · **Carte des livraisons** 30 jours (Leaflet / OpenStreetMap) · **Prévisions de maintenance** (visite, cycles, potentiel des pièces au rythme des 30 derniers jours) · **Fil d'activité** · **Mon activité** (pilote) ou **comparaison des drone ports** (administrateur). Seuils météo dans `src/lib/dashboard.ts` |
| **Historique technique du drone** | Bouton **🛠 Historique technique** sur la fiche drone : chronologie par mois des montages, démontages (avec les heures volées sur le drone pendant le montage) et mises en quarantaine de pièces, des comptes rendus techniques / incidents, des mesures correctives (qui a clôturé) et des visites. Filtres Pièces / Rapports & mesures / Visites, année, recherche ; export CSV et impression. Fonction SQL `drone_history` |
| **Classement** | Deux onglets, filtres communs (carrière ou période, drone port). **Pilotes** : podium et classement par heures de vol (carnet), barre commandant de bord / copilote / heures antérieures, part en CdB, prochain palier. **Drones** : classement par **heures de vol** ou **nombre de vols** (tous les vols, comme le potentiel), barre livraisons / QRF / contrôles, distance, charge livrée, dernier vol, visite 250 h restante. Pilotes : leur drone port ; administrateur : tous ou un drone port. Fonctions SQL `pilot_ranking`, `drone_ranking` |
| **CRM (compte rendu matériel)** | Feuille A4 imprimable par vol (bouton « ⎙ CRM » sur un vol clôturé) : aéronef, données du vol, équipage, QRF, potentiel cellule **après le vol** (heures avant/après, dernière et prochaine visite, potentiel restant), énergie (cycles batteries après le vol, consommation, tensions), comptes rendus techniques et incidents (**RAS** si aucun), heures des pièces montées, observations, visas pilote / responsable de maintenance. Calcul à date via la fonction SQL `crm_flight` : un CRM réimprimé plus tard reste identique. Filigrane « PROVISOIRE » si le vol n'est pas clôturé |
| **Visas électroniques & notifications** | Sur le CRM d'un vol clôturé, bouton **Signer** : visa du **commandant de bord**, du **copilote** (s'il y en a un) et, uniquement si le vol a des comptes rendus techniques / incidents, visa **« Mesures correctives et clôture des comptes rendus »**. Ce dernier peut être signé par n'importe quel pilote du drone port (pas forcément de l'équipage), une fois tous les rapports clôturés ; la clôture d'un rapport exige une mesure corrective et enregistre qui l'a clôturé. Le nom complet s'affiche en signature manuscrite avec la date et l'heure. Avertissement avant d'imprimer un CRM incomplet. Annulation par le signataire ou un administrateur ; réouvrir un vol annule ses visas, modifier un rapport annule le visa « mesures correctives ». Cloche de notifications : visas à signer et comptes rendus à traiter, envoyés **uniquement aux pilotes du drone port du vol** ; l'**administrateur** reçoit le suivi des comptes rendus techniques / incidents de **tous les drone ports** jusqu'au visa « mesures correctives » (60 derniers jours). Fonctions SQL `sign_crm`, `unsign_crm`, `my_crm_tasks` |
| **Rapports clôturés verrouillés** | Une fois un compte rendu technique ou incident clôturé, plus aucun pilote ne peut le modifier, le rouvrir ou le supprimer (y compris celui qui l'a clôturé) : seul un administrateur le peut. Règle appliquée par la base (déclencheur `trg_tr_lock_closed`) ; l'interface affiche « 🔒 Verrouillé » |
| **QRF** | Retour au drone port avant largage : cause (météo / technique / autre), conditions météo, heure du demi-tour, détails. Colis non livré, mais heures, cycles et carnet comptés. Bouton **Nouvelle tentative** (vol pré-rempli et relié au vol d'origine), filtre et taux de QRF au tableau de bord |
| **Statistiques** | Par drone port (ou tous) et par période (année en cours par défaut, comparaison avec l'année précédente) : livraisons, distance, heures, poids livré, CSB desservis, taux de QRF et de contrôles, « À retenir » (jour record, délai moyen jusqu'au largage, mAh/km, vent lors des QRF…), graphiques (fréquence journalière, activité mensuelle, jours de la semaine, heures de décollage, CSB, organisations, conditions QRF, drones, pilotes), comparaison des drone ports, tableau de données pour chaque graphique et export CSV |
| **Planification (WindPath)** | WindPath intégré (vent à l'altitude des waypoints, énergie Tango 4). Depuis un vol : « Préparer avec WindPath » envoie colis, capacité réelle du pack et tension ; « Reporter dans le vol » renvoie distance, vent, direction, altitude AMSL, heures, consommation et tensions (choix champ par champ, source réel / estimé indiquée) |
| **Rapports & incidents** | Par vol : type (report technique / incident), gravité, composant, description, mesures correctives, statut (ouvert / en cours / clos) |
| **Drones & visites** | Compteur horaire (heures initiales + vols), visite systématique toutes les **250 h** (intervalle modifiable), alerte à moins de 25 h, historique des visites |
| **Batteries** | Tattu 12S 30 000 / 33 000 mAh, organisées en **packs de 2** (identifiants `1A`/`1B`, `2A`/`2B`…). Cycles = cycles initiaux + 1 par vol, **max 500**, alerte à 90 %. **Relevés de capacité réelle** (historique + courbe, dernier relevé et état de santé affichés). **Transferts** de pack entre drone ports, historisés (date, motif) |
| **Pilotes / CSB** | Référentiels avec statistiques ; chaque CSB a une distance de vol (km) |
| **Localisation** | CSB et drone ports situés par **région** et **district** de Madagascar (référentiel officiel : 24 régions, 114 districts, tables `mg_regions` / `mg_districts`, modifiables par un admin ; la base vérifie que le district appartient à la région) |

| **Drone ports** | Bases d'exploitation. Drones, pilotes et batteries y sont affectés ; un CSB peut être réservé à un port ou commun à tous |
| **Carnet de vol** | Par pilote : à la **clôture** d'un vol, sa durée est inscrite au carnet de chaque pilote (fonction pilote / copilote, cumul d'heures, impression) |

### Rôles et périmètre

- **Pilote** : voit et saisit uniquement les données du drone port de sa fiche pilote (filtrage imposé par la base via RLS, pas seulement par l'interface).
- **Administrateur** : voit tous les drone ports (filtre dans le menu), gère les référentiels et les comptes, peut rouvrir un vol clôturé.
- Le **premier compte créé** devient administrateur ; les suivants sont pilotes. Un admin relie ensuite chaque compte à sa fiche pilote (menu *Utilisateurs*).

### Cycle de vie d'un vol

1. Saisie → statut **ouvert** (modifiable). Les heures drone et les cycles batteries sont comptés dès la saisie (sécurité maintenance).
2. **Clôture** → vol verrouillé, heures ajoutées au carnet de vol des pilotes. Les rapports techniques restent modifiables.
3. **Réouverture** (admin uniquement) → les heures sont retirées du carnet jusqu'à la prochaine clôture.

Les règles sont appliquées dans la base : 2 pilotes maximum (trigger), batteries distinctes, accès réservé aux utilisateurs authentifiés (RLS). Les calculs (heures, cycles, prochaine visite) sont faits dans des vues SQL, donc ils restent toujours à jour quand on modifie ou supprime un vol.

## Développement local

Prérequis : Node 20+, Docker.

```bash
npm install
npm run db:start      # démarre la stack Supabase dédiée (ports 57621-57629)
npm run dev           # http://localhost:5173
```

- Studio Supabase local : http://127.0.0.1:57623
- `npx supabase status` affiche l'URL et les clés locales (à mettre dans `.env`, voir `.env.example`)
- `npm run db:reset` recrée la base depuis les migrations (**efface les données locales**)

### Créer un utilisateur

- **Inscription libre** : lien « Créer un compte pilote » sur la page de connexion. Le compte a le rôle *Pilote*
  et reste sans accès jusqu'à sa validation par un administrateur (*Utilisateurs → Demandes d'inscription*).
- Ou par l'administrateur : Studio → **Authentication → Users → Add user** (cocher *Auto confirm*).

### Tests automatiques

```bash
npm run db:start          # la base locale doit tourner
npm run test:e2e          # 20 tests (règles métier + interface), ~1 min 30
npm run test:e2e:report   # rapport détaillé (captures en cas d'échec)
```

- Les tests créent un **jeu de données isolé** (drone ports « E2E Nord/Sud », drones E2E1/E2E2, comptes `e2e-*@test.local`)
  et le **suppriment entièrement** à la fin : la base de travail n'est pas modifiée.
  `E2E_KEEP_DATA=1 npm run test:e2e` conserve les données pour les inspecter.
- Ce qui est vérifié : droits par drone port, cycle vol → clôture → visas CRM → réouverture, clôture des comptes rendus,
  ordres de travail (rattachement, signature, verrou), journal d'audit, affichage de toutes les pages sans erreur.
- Sur GitHub, `.github/workflows/tests.yml` lance le typage, le build et ces tests à chaque envoi de code.

## Mise en production

### 1. Supabase Cloud

1. Créez un projet sur https://supabase.com (région la plus proche : *Europe* ou *Africa* si disponible).
2. **Appliquez les migrations** (structure complète de la base, référentiels de Madagascar et du Tango 4) :
   ```bash
   npx supabase login                         # ouvre le navigateur pour vous connecter
   npx supabase link --project-ref <ref>      # <ref> : Project Settings → General → Reference ID
   npx supabase db push                       # applique toutes les migrations de supabase/migrations/
   npx supabase migration list --linked       # vérifie : colonnes « Local » et « Remote » identiques
   ```
3. **Authentication → Sign In / Providers → Email** :
   - *Allow new users to sign up* : **activé** (formulaire « Créer un compte pilote » ; les comptes restent sans accès jusqu'à validation par un administrateur) ;
   - *Confirm email* : **activé**.
4. **Authentication → URL Configuration** :
   - *Site URL* = `https://<utilisateur>.github.io/<depot>/`
   - *Redirect URLs* : ajoutez la même adresse (lien de confirmation des emails).
5. **Emails (SMTP)** — indispensable : le service d'envoi intégré de Supabase est limité à quelques emails par heure et réservé aux tests.
   *Project Settings → Authentication → SMTP Settings* → *Enable custom SMTP* :
   | Champ | Exemple (Google Workspace) | Exemple (Brevo, gratuit 300 emails/jour) |
   |---|---|---|
   | Host | `smtp.gmail.com` | `smtp-relay.brevo.com` |
   | Port | `587` | `587` |
   | Username | adresse d'envoi | identifiant SMTP Brevo |
   | Password | mot de passe d'application Google | clé SMTP Brevo |
   | Sender email / name | `uav-maintenance@…` / `UAV Maintenance` | idem |
6. **Email en français** : *Authentication → Emails → Confirm signup* : sujet `UAV Maintenance · confirmez votre adresse email`,
   corps = contenu de `supabase/templates/confirmation.html`.
7. **Premier compte** : ouvrez le site et utilisez « Créer un compte pilote » : sur une base vide, ce premier compte devient automatiquement **administrateur**.
   Créez ensuite drone ports → drones → pilotes → CSB ; les pilotes s'inscrivent et vous validez leurs demandes (*Utilisateurs*).

### Sauvegardes

- **Automatique (production)** : `.github/workflows/backup.yml` exporte la base **chaque nuit à 02:00** (heure de Madagascar),
  la **chiffre** et la conserve **30 jours** dans GitHub (*Actions → Sauvegarde de la base → artifacts*). Secrets à créer :
  - `SUPABASE_DB_URL` : *Connect → Session pooler* (remplacez `[YOUR-PASSWORD]` par le mot de passe de la base) ;
  - `BACKUP_PASSPHRASE` : phrase secrète de chiffrement — **notez-la aussi ailleurs** : sans elle, aucune restauration possible.
  Lancez une première sauvegarde à la main (*Run workflow*) pour vérifier.
- **Manuelle** : `npm run db:backup` (base locale) ou `npm run db:backup -- "<SUPABASE_DB_URL>"` (production) → `backups/*.dump`.
- **Restaurer en local** : `npm run db:restore -- backups/<fichier>.dump` (une sauvegarde est faite avant ; confirmation demandée).
- **Restaurer en production** (incident grave uniquement) : déchiffrez avec
  `gpg -d uav-maintenance_<date>.dump.gpg > sauvegarde.dump`, puis demandez l'aide d'un développeur :
  la restauration remplace les données en ligne, elle se fait à la main, de préférence d'abord vers un projet Supabase de secours.
### 2. GitHub Pages

1. Poussez le code sur un dépôt GitHub (branche `main`).
2. **Settings → Secrets and variables → Actions**, ajoutez :
   - `VITE_SUPABASE_URL` : `https://<ref>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` : clé *anon* / *publishable* (Project Settings → API)
3. **Settings → Pages → Source** : *GitHub Actions*.
4. Chaque push sur `main` déclenche le build et le déploiement (`.github/workflows/deploy.yml`).

> La clé *anon* est publique par nature (elle est embarquée dans le site). La sécurité repose sur la RLS : sans connexion, aucune donnée n'est lisible. Ne mettez **jamais** la clé *service_role* dans le front.

## WindPath

WindPath est copié **sans modification** dans `public/windpath/` et affiché dans la page *Planification*.
La liaison avec l'application passe par `public/windpath-bridge.js`, injecté au chargement (même origine) :
il lit les résultats de WindPath et remplit ses champs, sans toucher à `script.js`.

Après une modification de WindPath (dossier voisin `../WindPath`) :

```bash
npm run sync:windpath   # recopie index.html, script.js et style.css dans public/windpath/
```

## Structure

```
supabase/migrations/   schéma SQL (tables, vues de calcul, RLS, fonction save_flight)
src/lib/               client Supabase, types, formatage et seuils d'alerte
src/components/        layout, composants UI, formulaire de rapport
src/pages/             tableau de bord, vols, rapports, drones, batteries, pilotes, CSB
```

Seuils d'alerte : `src/lib/format.ts` (`THRESHOLDS`).
