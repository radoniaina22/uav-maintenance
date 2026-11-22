// Restauration d'une sauvegarde dans la base LOCALE : `npm run db:restore -- backups/<fichier>.dump`
// Les données actuelles de la base locale (schémas public et auth) sont remplacées : une sauvegarde est faite avant.
// (Restaurer en production se fait volontairement à la main : voir le README, section « Sauvegardes et restauration ».)
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline/promises';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error('Usage : npm run db:restore -- backups/<fichier>.dump');
  process.exit(1);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(`Remplacer les données de la base LOCALE par « ${basename(file)} » ? (oui/non) `);
rl.close();
if (answer.trim().toLowerCase() !== 'oui') { console.log('Annulé.'); process.exit(0); }

execSync('node scripts/db-backup.mjs', { stdio: 'inherit' }); // filet de sécurité
const container = 'supabase_db_uav_maintenance';
execSync(`docker cp "${file}" ${container}:/tmp/restore.dump`, { stdio: 'inherit' });
// compte d'administration du conteneur local (propriétaire des tables internes d'authentification)
// vide les tables des schémas sauvegardés, puis recharge les données (structure = migrations actuelles)
const truncate = `do $$ declare t text; begin
  select string_agg(format('%I.%I', schemaname, tablename), ', ') into t from pg_tables where schemaname in ('public', 'auth') and not (schemaname = 'auth' and tablename = 'schema_migrations');
  execute 'truncate table ' || t || ' restart identity cascade';
end $$;`;
execSync(`docker exec -i ${container} psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q`, { input: truncate, stdio: ['pipe', 'inherit', 'inherit'] });
execSync(`docker exec ${container} pg_restore -U supabase_admin -d postgres --data-only --no-owner --no-privileges --disable-triggers --exit-on-error /tmp/restore.dump`, { stdio: 'inherit' });
execSync(`docker exec ${container} rm /tmp/restore.dump`);
console.log('✓ Restauration terminée.');
