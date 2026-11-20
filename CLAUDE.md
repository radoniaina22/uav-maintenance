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
```

`.env` needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (values from `npx supabase status`).

## Architecture

### Database is the source of truth (`supabase/migrations/`)
- Computed values (drone hours, battery cycles, next 250 h visit, part hours, logbook) are **SQL views** (`v_flights`, `v_drone_status`, `v_battery_status`, `v_pack_status`, `v_parts`, `v_reports`, `v_logbook`, `v_work_orders`, …), never stored or computed in the front.
- Writes with business logic go through **RPC functions** (`save_flight`, `close_flight` / `reopen_flight`, `mount_part` / `unmount_part` / `replace_part`, `transfer_pack`, `sign_crm` / `unsign_crm`, `sign_work_order`, `admin_approve_signup`, …). Reports such as `crm_flight`, `drone_history`, `pilot_ranking`, `drone_ranking`, `activity_feed` and `my_crm_tasks` are also SQL functions.
- Invariants are enforced by triggers (max 2 pilots, closed technical reports locked except for admins, visa invalidation on reopen/edit, audit log, part codes like `MOV0001`).
- **Migrations are append-only and redefine objects in full.** `save_flight` and `v_flights` (and others) are redefined in many migrations: the *latest* migration that touches an object holds its current definition. To change one, add a new timestamped migration (`YYYYMMDDHHMMSS_name.sql`) that `drop view if exists` / `create or replace` the whole object, copied from its most recent version. Dropping a view can require recreating dependent views.
- **Always grant privileges explicitly** in each migration (`grant select, … on public.<table> to authenticated`). The cloud project has no default privileges for `anon` / `authenticated` (unlike the local stack, where tests pass anyway), so a table without explicit grants works locally but is "permission denied" online. `service_role` gets default privileges since `20261217000000_explicit_grants.sql`.
- Scoping: RLS helpers `is_admin()`, `my_pilot_id()`, `my_drone_port_id()`, `can_manage_port()`. Pilots only see their drone port's data **at the DB level**; admins see everything.

### Front (`src/`)
- `main.tsx` uses **HashRouter** and `vite.config.ts` uses `base: './'` (GitHub Pages without rewrites). Routes are in `App.tsx` with French paths (`vols`, `pieces`, `ordres-travail`…); every page is loaded via `lazyPage()` (auto-reloads once if a chunk is missing after a deploy). Admin-only routes are wrapped in `AdminOnly`.
- `lib/app.tsx` `AppProvider` / `useApp()`: session, profile, pilot, `isAdmin`, drone ports, Madagascar geography (`geo`), and `portFilter` (forced to the pilot's port; admin can choose, `''` = all, persisted in localStorage). Apply it to queries with `byPort(query, portFilter)`. Accounts without a port see a "pending validation" screen.
- Data access pattern: `useData(loader, deps)` hook + `supabase.from(...)` / `supabase.rpc(...)` wrapped in `unwrap()` (throws readable French errors; `PGRST116` = out of scope). Use `fetchAll()` for tables that can exceed the 1 000-row API limit.
- `lib/types.ts` holds hand-written row types (no generated types): update it when the schema changes.
- Thresholds: alerts in `lib/format.ts` (`THRESHOLDS`), flight weather in `lib/dashboard.ts`.

### WindPath (`public/windpath/`)
Third-party planner embedded **unmodified** (stays in English) in the Planning page. Integration happens only through `public/windpath-bridge.js` (injected same-origin) and `src/lib/windpath.ts` / `pages/Planning.tsx`. Never edit `public/windpath/*` directly; refresh it with `npm run sync:windpath`.

## Tests

`tests/e2e/` (Playwright, 1 worker, serial, `fr-FR`, timezone `Indian/Antananarivo`). `global-setup.ts` creates an isolated fixture (ports "E2E Nord/Sud", drones `E2E1`/`E2E2`, users `e2e-*@test.local`) through the service-role key and direct `postgres` access, writes `.fixture.json`; `global-teardown.ts` deletes it. `rules.spec.ts` checks DB rules through Supabase clients per user (`as('nord')`, `expectError`, `ok`), `ui.spec.ts` checks the pages. Keys come from env vars or `npx supabase status -o env`. Locally the installed Chrome is used. When adding tables linked to flights/drones, extend `cleanE2E()` so teardown still works.

## CI / deployment

`.github/workflows/`: `tests.yml` (build + E2E against a fresh local Supabase on every push), `deploy.yml` (GitHub Pages on `main`, secrets `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`), `backup.yml` (nightly encrypted `pg_dump`). Only the anon key may ever reach the front.

## Environment notes (Windows)

- Vite HMR can serve stale modules after several edits: restart the dev server before concluding a change does not work.
- The first `supabase migration up` / CLI call can hang: stop it, check `npx supabase --version`, retry once.
