# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Web app for the technical management of Tango 4 VTOL drones (UNFPA medical deliveries in Madagascar). React 18 + TypeScript + Vite static site (GitHub Pages) with **Supabase as the only backend** (PostgreSQL + RLS + auth). There is no server of our own: all business rules live in SQL. The UI, code comments, commit-facing docs and README are in **French**; keep new UI text and comments in French.

## Commands

```bash
npm run db:start        # local Supabase stack (Docker), ports 57621-57629, Studio on :57623
npm run dev             # Vite on http://localhost:5173
npm run build           # tsc --noEmit + vite build (this is the only type check; no linter configured)
npm run db:reset        # rebuild local DB from migrations (wipes local data)
npm run db:push         # apply migrations to the linked cloud project
npm run test:e2e        # Playwright, requires db:start; starts/reuses the Vite dev server
npx playwright test tests/e2e/rules.spec.ts          # single file
npx playwright test -g "texte du test"               # single test by title
E2E_KEEP_DATA=1 npm run test:e2e                     # keep the E2E fixture data for inspection
npm run sync:windpath   # copy ../WindPath/{index.html,script.js,style.css} into public/windpath/
npm run db:backup / db:restore -- backups/<file>.dump
npx supabase db query --linked "select …"            # SQL on the cloud DB (Management API, no password needed)
npx supabase db query --linked -f <file>.sql         # run a SQL file online (wrap it in begin; … commit;)
npx supabase db dump --linked --data-only -f backups/<name>.sql   # cloud data backup before a data change
npx supabase db query --local "select …"             # or: docker exec supabase_db_uav_maintenance psql -U postgres -d postgres
```

One-off data imports (flights, parts, 250 h visits) follow the same path: a script generates a reviewable SQL file in `backups/` (git-ignored: the repo is public and the source files contain names), run it locally, check, then back up the cloud data and replay the same file with `db query --linked -f`. The SQL must refuse to run twice (guard at the top).

`.env` needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (values from `npx supabase status`).

## Architecture

### Database is the source of truth (`supabase/migrations/`)
- Computed values (drone hours, battery cycles, next 250 h visit, part hours, logbook) are **SQL views** (`v_flights`, `v_drone_status`, `v_battery_status`, `v_pack_status`, `v_parts`, `v_reports`, `v_logbook`, `v_work_orders`, …), never stored or computed in the front.
- Writes with business logic go through **RPC functions** (`save_flight`, `close_flight` / `reopen_flight`, `mount_part` / `unmount_part` / `replace_part`, `transfer_pack`, `sign_crm` / `unsign_crm`, `sign_work_order`, `admin_approve_signup`, …). Reports such as `crm_flight`, `drone_history`, `pilot_ranking`, `drone_ranking`, `activity_feed` and `my_crm_tasks` are also SQL functions.
- Invariants are enforced by triggers (max 2 pilots, closed technical reports locked except for admins, visa invalidation on reopen/edit, audit log, part codes like `MOV0001`).
- **Migrations are append-only and redefine objects in full.** `save_flight` and `v_flights` (and others) are redefined in many migrations: the *latest* migration that touches an object holds its current definition. To change one, add a new timestamped migration (`YYYYMMDDHHMMSS_name.sql`) that `drop view if exists` / `create or replace` the whole object, copied from its most recent version. Dropping a view can require recreating dependent views.
- **Always grant privileges explicitly** in each migration (`grant select, … on public.<table> to authenticated`). The cloud project has no default privileges for `anon` / `authenticated` (unlike the local stack, where tests pass anyway), so a table without explicit grants works locally but is "permission denied" online. `service_role` gets default privileges since `20261217000000_explicit_grants.sql`.
- Parts: code = 3-letter type + per-type counter (`parts_assign_code` trigger + `part_code_counters`, e.g. `MOV0001`); never set `code` by hand. Types with `part_types.multi = true` (`CNT`, `FLE`, `SOT`, `CMR`) have no slot: mounted with `slot = null` and a zone. Tango 4 VTOL position numbering used by the old register: 1 = front right (`AVD`), 2 = rear left (`ARG`), 3 = front left (`AVG`), 4 = rear right (`ARD`), 5 = horizontal.
- Parts imported from the old register (`scripts/import-old-parts.py`, done 2026-11-22 locally and online; it generates SQL from the Excel files in `backups/old-parts/`) keep their old code in `parts.legacy_code` (e.g. `MOV000038` → `MOV0001`, unique). Scan (`Scan.tsx` `loadPart`, `QrScanner.tsx` `findPartId`) and inventory search accept both codes; the detail page and labels show « ex-… ». Imported `part_events` have `imported = true` and `editor_name` (author without an account); `v_part_events.actor_name` = user name, else `editor_name` (also used by `drone_history`). Their hours come from flights (`initial_hours = 0`) when the part has a mounting history, else from the old register's hours.
- 250 h visits: `v_drone_status.next_visit_hours` = `hours_at_visit` of the latest `maintenance_visits` row with `visit_type = 'systematique'` (highest counter) + `drones.visit_interval_hours`; with no such visit, the next multiple of the interval. Only `systematique` visits move the due date (`corrective` / `autre` do not); an early visit simply restarts the count from its counter. `hours_at_visit` is the drone counter, not a nominal milestone. The old register's 250 h visits (5 rows, 2026-11-22, `backups/old-visits/import-visites-250h.sql`) were imported with the counter computed from flights **before** the flights of the visit day; MAL2.2 had none.
- Email alerts (`20261224000000_email_alerts.sql`, Edge Function `send-alerts`, page `#/alertes`):
  - `alerts_current()` computes every situation in SQL (one row per kind + key), `alerts_refresh()` syncs `alert_events` (new / updated / resolved when the situation disappears; moving to `danger` re-arms the send). Views filtered by `is_admin()` are read through `alerts_as_service()` (sets `request.jwt.claims` to service_role for the transaction), so pg_cron (no JWT) sees everything.
  - Catalogue `alert_kinds` (mode `immediat` / `quotidien` / `hebdomadaire` / `meteo`, audience `port` / `responsables` / `admin` / `personnel`, `remind_days`, `enabled`), thresholds in `alert_settings` (single row), per-user opt-outs `alert_optouts`, log `alert_dispatches`. `alerts_outbox(mode)` = alerts to send with their recipients (accounts via `alert_accounts()`), `alerts_mark_notified()` prevents repeats.
  - pg_cron: `alertes-immediates` every 5 min (`alerts_tick()` calls the function only if an immediate alert waits), `alertes-quotidiennes` 04:00 UTC, `alertes-hebdomadaires` Monday 04:15 UTC (weekly summary `alerts_weekly_summary()`), `alertes-meteo` 15:00 UTC (the function queries Open-Meteo and writes through `alerts_set_weather`). Same Vault secret as the monthly reports. Nothing is sent while `alert_settings.enabled` is false; enabling from the online site stores `functions_url` / `app_url` (links in the emails).
  - To add an alert: a row in `alert_kinds` + a `union all` branch in `alerts_current()` (redefine the whole function). If it needs a threshold: a column in `alert_settings` (+ its column `grant update`) and an entry in `THRESHOLD_GROUPS` (`src/lib/alerts.ts`) whose `def` must equal the column default. Use `fr_num()` for numbers in SQL texts (comma decimals). E2E fixture alerts are removed by `cleanE2E()`.
  - Front: `pages/Alerts.tsx` (active alerts and personal opt-outs for everyone; admin cards: sending, kinds, thresholds grouped by theme, log), `lib/alerts.ts` (types, labels, `invokeAlerts`). `lib/reportMail.ts` holds the shared `functionUrl(name)` / `invokeFunction(name, body)` used by both email functions.
  - Email HTML: `supabase/functions/_shared/alertEmail.ts` (no dependency, inline styles, links `appUrl/#/path`). Preview it by bundling with `npx esbuild … --format=esm`, rendering with data from `alerts_outbox('tout')` / `alerts_weekly_summary()` and screenshotting with Playwright.
  - Status (2026-11-22): migration, function and page are online, **sending disabled** (`alert_settings.enabled = false`) until an admin clicks « Activer les alertes » on the online site.
  - Test the function locally: `npx supabase functions serve send-alerts --no-verify-jwt --env-file <file with MAIL_DRY_RUN=1>` (the Edge runtime is disabled in `config.toml` for `db:start`; serving it also makes the UNFPA monthly-report E2E test pass locally). Deploy with `npx supabase functions deploy send-alerts --use-api`.
- Scoping: RLS helpers `is_admin()`, `my_pilot_id()`, `my_drone_port_id()`, `can_manage_port()`. Pilots only see their drone port's data **at the DB level**; admins see everything.
- WindPath-related tables: `flight_plans` (plan library per port/destination), `flight_plan_estimates` (estimate summary kept with a flight), `flight_windpath_records` (full mission jsonb kept with a flight, rendered as the WindPath report annexed to the CRM), `live_flights` (one row per user = their flight in progress, shared in **realtime** with their drone port; PK `user_id`, a trigger forces `drone_code` / `pilot_name` / `updated_at` and checks the drone belongs to the port; table is in the `supabase_realtime` publication).
- Realtime: subscribe with `supabase.channel(...).on('postgres_changes', …)` (see `lib/liveTraffic.ts`). RLS applies to subscribers; DELETE events are not filterable and only carry the primary key.

### Front (`src/`)
- `main.tsx` uses **HashRouter** and `vite.config.ts` uses `base: './'` (GitHub Pages without rewrites). Routes are in `App.tsx` with French paths (`vols`, `pieces`, `ordres-travail`…); every page is loaded via `lazyPage()` (auto-reloads once if a chunk is missing after a deploy). Admin-only routes are wrapped in `AdminOnly`.
- `lib/app.tsx` `AppProvider` / `useApp()`: session, profile, pilot, `isAdmin`, drone ports, Madagascar geography (`geo`), and `portFilter` (forced to the pilot's port; admin can choose, `''` = all, persisted in localStorage). Apply it to queries with `byPort(query, portFilter)`. Accounts without a port see a "pending validation" screen.
- Data access pattern: `useData(loader, deps)` hook + `supabase.from(...)` / `supabase.rpc(...)` wrapped in `unwrap()` (throws readable French errors; `PGRST116` = out of scope). Use `fetchAll()` for tables that can exceed the 1 000-row API limit.
- `lib/types.ts` holds hand-written row types (no generated types): update it when the schema changes.
- Thresholds: on-screen alerts in `lib/format.ts` (`THRESHOLDS`), flight weather in `lib/dashboard.ts` (`WEATHER_LIMITS`: wind 8 / 12 m/s, gusts 15 m/s; the bridge uses the same values). Email alert thresholds live in the DB (`alert_settings`, editable on `#/alertes`); their defaults match these constants (visit 25 h, battery 90 % / 85 % / 75 %, wind 12 / gusts 15 m/s): keep them consistent when changing one side.
- PDF / local archive (`lib/localArchive.ts`): sheets are captured with html2canvas + jsPDF (`elementToPdf`, `elementsToPdf`: each `.crm-sheet` starts a new page; `crmDocumentToPdf(root)` = CRM + WindPath report). Files go to `<chosen folder>/UAV Maintenance - CRM/Drone/Année/Mois/jj-mm-aaaa/Vol N (CSB)/` via the File System Access API (`lib/crmArchive.ts` builds the path), falling back to a download.
- Flight dossier: `pages/FlightCrm.tsx` renders the CRM and, if the flight has a `flight_windpath_records` row, `components/WindpathReport.tsx` inside a `.crm-doc` wrapper. After the **last visa** is signed, the combined PDF is saved automatically (if the browser needs a click to re-authorize the folder, a button is shown). `pages/CrmExport.tsx` batch-exports the same document off-screen.

### WindPath (`public/windpath/`)
Third-party planner (the user's own tool) embedded **unmodified** (its own UI stays in English) in an iframe of the Planning page. Never edit `public/windpath/*` directly; refresh it with `npm run sync:windpath`. All integration lives in:
- `public/windpath-bridge.js`: injected same-origin into the iframe, runs in WindPath's global scope. Text it adds is in French. It:
  - restyles WindPath (dark theme, left dashboard, battery panel, flight-tracking waypoint table, map) through an injected `<style>` (screen only; WindPath's own print CSS untouched) and DOM widgets;
  - **overrides WindPath globals** that `script.js` calls by name: `window.markerIcon`, wraps `window.renderMap` and `window.updateReferenceDronePosition`. Top-level `const`/`let` of WindPath (e.g. `state`, `elements`, `map`) are not `window` properties;
  - handles pilot entry: real mAh entry marks the point passed, point 0 has a « Décollage » button (sets takeoff time to now + marks it passed), points passed 15 s ago without entry get estimated values flagged `uavAuto` (sent as `estime`, never as real);
  - runs the mission voice (Web Speech API), basemap picker, live traffic display and the print interception (« Print / Save PDF » and Ctrl+P → the page prints `WindpathReport`).
- Messages (postMessage, origin-checked): page → bridge `prefill`, `request`, `loadPlan`, `exportPlan`, `clear`, `layout`, `traffic`; bridge → page `ready`, `prefilled`, `restored`, `status`, `result` (includes `estimate` and full `record`), `planLoaded`, `planFile`, `layout`, `live` (every 5 s), `landed`, `print`.
- `src/lib/windpath.ts` (types, transfer to the flight form), `src/lib/liveTraffic.ts` (share/receive `live_flights`), `src/pages/Planning.tsx` (bar: drone, destination, plans, verdict, layouts).
- Bridge code relies on WindPath internals: after `sync:windpath`, re-check the global function names above, the 13-column waypoint table order (wind = column 3, ETA = 4, est. leg / cumul mAh = 8 / 9) and the chart plot constants (left 42, right gap 18, bottom 142).
- Positions shown as "recalée" are the plan shifted by the delay measured at the last recorded pass, **not GPS**.

## Tests

`tests/e2e/` (Playwright, 1 worker, serial, `fr-FR`, timezone `Indian/Antananarivo`). `global-setup.ts` creates an isolated fixture (ports "E2E Nord/Sud", drones `E2E1`/`E2E2`, users `e2e-*@test.local`) through the service-role key and direct `postgres` access, writes `.fixture.json`; `global-teardown.ts` deletes it. `rules.spec.ts` checks DB rules through Supabase clients per user (`as('nord')`, `expectError`, `ok`), `ui.spec.ts` checks the pages. Keys come from env vars or `npx supabase status -o env`. Locally the installed Chrome is used. When adding tables linked to flights/drones/ports, extend `cleanE2E()` so teardown still works (it runs with `session_replication_role = replica`, so FK cascades do **not** fire: delete child rows explicitly).

Testing WindPath in a browser: open `/windpath/index.html` and inject `/windpath-bridge.js` (or go through `#/planification` logged in as an `e2e-*` user), load a mission with `postMessage({ source: 'uav', type: 'loadPlan', plan: { name, fileName, content } })` (QGC WPL 110 text), click `#analyzeButton` (needs internet: Open-Meteo) and wait for every `etaTimestamp`. Read WindPath state with `(0, eval)('state')`. Stub `speechSynthesis.speak` / `window.print` to capture voice and printing. Never click on the map to blur a field: it adds a waypoint. Temporary specs go in `tests/e2e/zz-*.spec.ts` and are deleted afterwards (they depend on the network).

## CI / deployment

`.github/workflows/`: `tests.yml` (build + E2E against a fresh local Supabase on every push), `deploy.yml` (GitHub Pages on `main`, secrets `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`), `backup.yml` (nightly encrypted `pg_dump`). Only the anon key may ever reach the front. After a push, check runs with `gh run list` / `gh run view <id> --log-failed`. Commits go directly on `main` (that is the deploy branch); new migrations must also be applied online with `npm run db:push`.

The repo is **public**: run logs and artifacts are visible to any GitHub user (secrets are masked, backups are GPG-encrypted). Never print a secret value in a workflow. Secret values cannot be read back. To check one, push a throwaway workflow on a temporary branch that only prints format checks / HTTP codes (pushing to a branch other than `main` does not deploy), then delete the branch and its runs.

### Backups (`backup.yml`)
- Repository secrets: `SUPABASE_DB_URL` = the **Session pooler** string (`postgres.<ref>@aws-1-eu-west-1.pooler.supabase.com:5432`; the CLI keeps it without password in `supabase/.temp/pooler-url`). The "Direct connection" host `db.<ref>.supabase.co` is IPv6-only, and GitHub runners fail with `Network is unreachable`. `BACKUP_PASSPHRASE` = GPG AES-256 passphrase. The four secrets are these two plus `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (a publishable `sb_publishable_…` key).
- Dump = `pg_dump --format=custom` of schemas `public` + `auth` (`auth.schema_migrations` data excluded), kept 30 days as an artifact. Not covered: dashboard settings (Auth/SMTP), Edge function secrets, the Vault secret (`monthly_reports_cron_secret`, used by both the monthly reports and the email alerts; recreated by migration `20261216000000` on a new project).
- Restore: the full step-by-step tutorial is in README « Sauvegardes et restauration ». Local = `npm run db:restore` (truncate + `pg_restore --data-only` as `supabase_admin`). Cloud = data-only SQL replayed with `psql --single-transaction` as `postgres` after `truncate … cascade` and `set session_replication_role = replica` (tested locally with the non-superuser `postgres` role, which matches the cloud rights). `postgres` may **not** use `truncate … restart identity` (not owner of the `auth` sequences) or `pg_restore --disable-triggers`. Sequences come back through the dump's `setval`.
- Restoring into a new project: also update `report_settings.functions_url` (re-toggle auto-send on *Rapports mensuels*) and `alert_settings.functions_url` (re-toggle « Activer les alertes » on *Alertes*), redeploy `send-monthly-reports` and `send-alerts` and their secrets (`BREVO_API_KEY`), and switch the GitHub secrets.
- When the schema changes in a way that breaks old dumps (dropped / renamed columns), say so in the README restore section.

## Environment notes (Windows)

- Vite HMR can serve stale modules after several edits: restart the dev server before concluding a change does not work.
- The first `supabase migration up` / CLI call can hang: stop it, check `npx supabase --version`, retry once.
- The local stack runs without the Edge runtime (`[edge_runtime] enabled = false`): without `supabase functions serve`, the E2E test « l'administrateur commente, valide puis rouvre le rapport UNFPA » times out locally (validation calls `send-monthly-reports`). It passes in CI; not a regression.
- Git Bash rewrites `/tmp/...` paths passed to `docker exec` / `docker cp`: prefix with `MSYS_NO_PATHCONV=1`. The DB container is `supabase_db_uav_maintenance` (other projects' `supabase_db_*` containers also run).
- No Excel library is installed: `.xlsx` files are read with Python stdlib (zip + XML), see `scripts/import-old-parts.py`.
