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

8. **Sauvegardes automatiques** : voir [Sauvegardes et restauration](#sauvegardes-et-restauration).

### 2. GitHub Pages

1. Poussez le code sur un dépôt GitHub (branche `main`).
2. **Settings → Secrets and variables → Actions**, ajoutez :
   - `VITE_SUPABASE_URL` : `https://<ref>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` : clé *anon* / *publishable* (Project Settings → API)
3. **Settings → Pages → Source** : *GitHub Actions*.
4. Chaque push sur `main` déclenche le build et le déploiement (`.github/workflows/deploy.yml`).

> La clé *anon* est publique par nature (elle est embarquée dans le site). La sécurité repose sur la RLS : sans connexion, aucune donnée n'est lisible. Ne mettez **jamais** la clé *service_role* dans le front.

## Sauvegardes et restauration

### Ce qui est sauvegardé

Le workflow `.github/workflows/backup.yml` exporte la base de production avec `pg_dump` :

- **sauvegardé** : schémas `public` (toutes les données de l'application) et `auth` (comptes de connexion, mots de passe chiffrés) ;
- **non sauvegardé** (à refaire à la main sur un nouveau projet, voir l'étape D3) : réglages du tableau de bord Supabase
  (Auth, SMTP, modèles d'email), fonction Edge `send-monthly-reports` et ses secrets, secret Vault de l'envoi automatique.
  Le code (dont la structure de la base = `supabase/migrations/`) est dans Git.

Fréquence : **chaque nuit vers 02:00** (heure de Madagascar). GitHub peut retarder une exécution planifiée de plusieurs heures.
Chaque sauvegarde est **chiffrée (GPG, AES-256)** puis conservée **30 jours** dans GitHub.

> **Le dépôt est public** : toute personne connectée à GitHub peut télécharger les fichiers de sauvegarde.
> Ils sont illisibles sans la phrase secrète, d'où l'importance d'une phrase longue et aléatoire (étape A1).
> Les journaux d'exécution sont publics aussi, mais les secrets y sont masqués (`***`).

### A. Mettre en place la sauvegarde automatique (une seule fois)

**A1. Générer la phrase secrète de chiffrement.** Dans votre terminal (pas dans un chat, pas dans un fichier du projet) :

```powershell
# PowerShell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```
```bash
# Git Bash
openssl rand -base64 32
```

Vous pouvez aussi utiliser le générateur d'un gestionnaire de mots de passe (au moins 32 caractères).
**Enregistrez-la immédiatement dans un gestionnaire de mots de passe** (et idéalement une copie papier en lieu sûr) :
**sans elle, aucune sauvegarde ne peut être restaurée**, et personne ne peut la retrouver.

**A2. Récupérer la chaîne de connexion « Session pooler ».**
Supabase → le projet → bouton **Connect** → méthode **Session pooler**. Elle a cette forme :

```
postgresql://postgres.<ref-du-projet>:<MOT-DE-PASSE>@aws-1-eu-west-1.pooler.supabase.com:5432/postgres
```

- Remplacez `[YOUR-PASSWORD]` par le mot de passe de la base, **sans les crochets**.
  Mot de passe oublié : *Project Settings → Database → Reset database password*.
  Choisissez-le avec uniquement des lettres et des chiffres : `@ # / % :` cassent la chaîne.
- ⚠️ **N'utilisez pas** la chaîne « Direct connection » (`db.<ref>.supabase.co`) : elle n'est joignable qu'en IPv6,
  et GitHub Actions n'a pas d'IPv6 (erreur `Network is unreachable`).
- Vérifiez : l'utilisateur est `postgres.<ref>` (avec le point), l'hôte se termine par `pooler.supabase.com`, le port est `5432`.
- Astuce : si le projet a été lié avec la CLI (`npx supabase link`), la chaîne (sans mot de passe) est dans `supabase/.temp/pooler-url`.

**A3. Créer les deux secrets dans GitHub.**
Dépôt → **Settings → Secrets and variables → Actions** → onglet *Secrets* → bouton vert **New repository secret** :

| Name (exactement) | Secret |
|---|---|
| `SUPABASE_DB_URL` | la chaîne de l'étape A2 |
| `BACKUP_PASSPHRASE` | la phrase de l'étape A1 |

- Utilisez **New repository secret**, et ne modifiez **pas** `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (le ✏️ d'un secret
  existant le remplace). Un mauvais remplacement mettrait le mot de passe de la base **dans le site public** au prochain déploiement.
- Créez des *repository secrets*, pas des secrets de l'environnement `github-pages` (le workflow ne les verrait pas).
- À la fin, la liste doit contenir **4 secrets**. En ligne de commande : `gh secret list`, et `gh secret set <NOM>` pour saisir
  une valeur sans l'afficher.

**A4. Tester.** Onglet **Actions** → **Sauvegarde de la base** → **Run workflow**. Au bout d'environ 1 minute, l'exécution doit être verte ✅
et proposer en bas de page un fichier **sauvegarde-AAAA-MM-JJ_HHMM**.

| Message d'erreur | Cause |
|---|---|
| `Secrets SUPABASE_DB_URL et BACKUP_PASSPHRASE requis` | secret absent ou mal nommé (étape A3) |
| `Network is unreachable` | chaîne « Direct connection » au lieu de « Session pooler » (A2) |
| `password authentication failed` | mauvais mot de passe, ou crochets `[ ]` laissés dans la chaîne |
| `Tenant or user not found` | utilisateur `postgres` au lieu de `postgres.<ref>`, ou mauvaise région dans l'hôte |

**A5. Surveiller.**
- GitHub envoie un email au propriétaire du dépôt quand une exécution échoue : ne l'ignorez pas.
- ⚠️ Sur un dépôt public, GitHub **désactive les workflows planifiés après 60 jours sans activité** (aucun commit).
  En période calme, vérifiez une fois par mois que l'onglet *Actions* montre des sauvegardes récentes ; sinon, réactivez le workflow
  (*Enable workflow*) ou faites un commit.
- Les sauvegardes disparaissent après 30 jours : **téléchargez-en une par mois** (étape C1) et rangez-la hors de GitHub
  (disque externe, drive de l'organisation). Elle reste chiffrée, ce stockage est donc sans risque.

### B. Sauvegarde manuelle (avant une opération risquée)

Il faut Docker Desktop démarré.

```bash
npm run db:backup                                   # base locale
npm run db:backup -- "<chaîne Session pooler>"      # production
```

Le fichier `backups/uav-maintenance_<local|production>_<date>.dump` n'est **pas chiffré**. Le dossier `backups/` est exclu de Git :
ne le partagez pas et supprimez-le quand il ne sert plus.

### C. Récupérer et déchiffrer une sauvegarde

**C1. Télécharger.** Onglet **Actions** → **Sauvegarde de la base** → cliquez sur l'exécution du jour voulu → en bas, cliquez sur
**sauvegarde-AAAA-MM-JJ_HHMM**. Vous obtenez un `.zip`. Dézippez-le dans un **dossier de travail vide hors du projet**, par exemple
`C:\restauration`. Il contient `uav-maintenance_<date>.dump.gpg`.

En ligne de commande :
```bash
gh run list --workflow backup.yml                    # repérez l'ID de l'exécution
gh run download <ID> --dir /c/restauration
```

**C2. Déchiffrer.** Les commandes suivantes sont à lancer dans **Git Bash** (fourni avec Git for Windows, qui contient `gpg`).
Docker Desktop doit être démarré.

```bash
cd /c/restauration                                   # ou le dossier où se trouve le .gpg
gpg --pinentry-mode loopback -o sauvegarde.dump -d uav-maintenance_<date>.dump.gpg   # demande la phrase BACKUP_PASSPHRASE
```

`sauvegarde.dump` contient **toutes les données en clair** : ne le laissez pas traîner (étape D4).

### D. Restaurer

Pour tester une sauvegarde sans risque, commencez par **D1**. En cas d'incident, deux cas se présentent :

| Situation | Procédure |
|---|---|
| Données supprimées ou abîmées par erreur, le projet Supabase fonctionne | **D2** : restaurer dans le même projet |
| Projet Supabase perdu, supprimé ou inutilisable | **D3** : restaurer dans un nouveau projet |

Dans les deux cas, la restauration **remplace toutes les données** (vols, pièces, comptes…) par celles de la sauvegarde :
tout ce qui a été saisi après la sauvegarde est perdu. Elle s'exécute en **une seule transaction** : en cas d'erreur, **rien n'est
modifié**.

#### D1. Vérifier une sauvegarde en local (sans risque)

```bash
npm run db:start
npm run db:restore -- C:/restauration/sauvegarde.dump
```

Écrivez le chemin au format Windows (`C:/…`), même dans Git Bash.

La base locale est d'abord sauvegardée dans `backups/`, puis remplacée. Ouvrez ensuite http://localhost:5173 et contrôlez les
derniers vols. Les comptes sont ceux de la production : connectez-vous avec votre mot de passe habituel.
`npm run db:reset` remet ensuite une base locale vide.

#### D2. Restaurer dans le projet de production existant

1. **Prévenez les utilisateurs** de ne plus rien saisir pendant l'opération (environ 10 minutes).
2. **Sauvegardez l'état actuel**, même abîmé (étape B), pour pouvoir revenir en arrière :
   `npm run db:backup -- "<chaîne Session pooler>"`.
3. **Vérifiez que la structure de la base est à jour** : `npx supabase migration list` doit montrer les mêmes migrations en
   *Local* et *Remote* (sinon `npm run db:push`).
4. **Préparez et lancez la restauration** (étapes communes ci-dessous).
5. **Contrôlez** dans l'application (connexion, derniers vols, drones, pièces), puis prévenez les utilisateurs.

#### D3. Restaurer dans un nouveau projet Supabase

1. **Créez le projet** sur https://supabase.com/dashboard, de préférence dans la même région (*West EU (Ireland)*,
   `eu-west-1`). Notez le mot de passe de la base.
2. **Créez la structure** depuis le dossier du projet :
   ```bash
   npx supabase link --project-ref <nouveau-ref>
   npm run db:push
   ```
3. **Lancez la restauration** (étapes communes ci-dessous) avec la chaîne *Session pooler* du **nouveau** projet.
4. **Reconfigurez le nouveau projet** comme à la section [Supabase Cloud](#1-supabase-cloud) : *Authentication → URL Configuration*,
   SMTP, modèle d'email de confirmation.
5. **Basculez le site** : dans GitHub, mettez à jour (✏️) `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (nouvelles valeurs,
   *Project Settings → API*) et `SUPABASE_DB_URL`. Puis *Actions → Déploiement GitHub Pages → Run workflow* pour republier le site.
6. **Envoi des rapports mensuels** : déployez la fonction (`npx supabase functions deploy send-monthly-reports`) et redéfinissez
   ses secrets (`npx supabase secrets set BREVO_API_KEY=… REPORT_SENDER=…`). Les réglages restaurés pointent encore vers l'ancien
   projet : sur le site republié, page *Rapports mensuels* → *Envoi des e-mails*, **désactivez puis réactivez** l'envoi automatique
   (s'il était activé) pour enregistrer la nouvelle adresse.
7. **Contrôlez**. Les utilisateurs gardent leur mot de passe, mais doivent se reconnecter une fois.

#### Étapes communes de restauration (D2 et D3)

Dans Git Bash, dans le dossier qui contient `sauvegarde.dump` (étape C2) :

```bash
export MSYS_NO_PATHCONV=1            # évite que Git Bash modifie les chemins passés à Docker
W="$(pwd -W)"

# 1. Extraire les données de la sauvegarde en SQL
docker run --rm -v "$W:/w" postgres:17 pg_restore --data-only --no-owner --no-privileges -f /w/donnees.sql /w/sauvegarde.dump

# 2. Script qui vide les tables avant le rechargement
cat > vider.sql <<'EOF'
do $$ declare t text; begin
  select string_agg(format('%I.%I', schemaname, tablename), ', ') into t
  from pg_tables
  where schemaname in ('public', 'auth') and not (schemaname = 'auth' and tablename = 'schema_migrations');
  execute 'truncate table ' || t || ' cascade';
end $$;
EOF

# 3. Chaîne Session pooler du projet CIBLE (saisie masquée, rien dans l'historique)
read -rsp "Chaîne de connexion : " DB; echo

# 4. Restauration en une seule transaction (vider, désactiver les déclencheurs le temps du chargement, recharger)
docker run --rm -v "$W:/w" postgres:17 psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -q \
  -f /w/vider.sql -c "set session_replication_role = replica" -f /w/donnees.sql > /dev/null && echo "✓ Restauration terminée"
```

- Le chargement **désactive les déclencheurs** (`session_replication_role = replica`) : les données reviennent telles quelles,
  sans recalcul, sans nouvelle entrée dans le journal d'audit et sans invalidation des visas. Ils se réactivent seuls à la fin.
- Les compteurs automatiques (identifiants, codes de pièces) sont remis à la valeur de la sauvegarde.
- `ERROR: column "…" does not exist` (ou `relation … does not exist`) : la sauvegarde date d'avant une migration qui a supprimé
  ou renommé une colonne. Rien n'a été modifié. Restaurez avec la structure de l'époque (code du dépôt à la date de la
  sauvegarde) et faites-vous aider par un développeur.
- `permission denied` : rien n'a été modifié. Vérifiez que la chaîne utilise bien l'utilisateur `postgres.<ref>`.

#### D4. Nettoyer

```bash
rm -f sauvegarde.dump donnees.sql vider.sql; unset DB
```

Gardez le `.gpg` si besoin : il est chiffré. Supprimez aussi les `backups/*.dump` devenus inutiles.

> Cette procédure a été validée sur la base locale avec le rôle `postgres`, qui a les mêmes droits restreints qu'en ligne.
> **Faites un exercice tous les 6 mois** : restaurez la dernière sauvegarde en local (D1) pour vérifier que la phrase secrète
> et la procédure fonctionnent toujours.

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
