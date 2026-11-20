// Sauvegarde manuelle de la base : `npm run db:backup` (base locale) ou `npm run db:backup -- "<chaîne de connexion>"`
// Écrit backups/uav-maintenance_<date>.dump (format pg_dump « custom »), restaurable avec `npm run db:restore -- <fichier>`.
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const remote = process.argv[2];
const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Indian/Antananarivo' }).slice(0, 16).replace(' ', '_').replace(':', '');
mkdirSync('backups', { recursive: true });
const file = `uav-maintenance_${remote ? 'production' : 'local'}_${stamp}.dump`;
const out = resolve('backups');

if (remote) {
  // base distante : pg_dump 17 dans un conteneur (aucune installation de PostgreSQL nécessaire)
  execFileSync('docker', ['run', '--rm', '-v', `${out}:/out`, 'postgres:17', 'pg_dump', remote,
    '--format=custom', '--no-owner', '--no-privileges', '--schema=public', '--schema=auth', '--exclude-table-data=auth.schema_migrations', `--file=/out/${file}`], { stdio: 'inherit' });
} else {
  const container = 'supabase_db_uav_maintenance';
  execSync(`docker exec ${container} pg_dump -U postgres --format=custom --no-owner --no-privileges --schema=public --schema=auth --exclude-table-data=auth.schema_migrations --file=/tmp/${file}`, { stdio: 'inherit' });
  execSync(`docker cp ${container}:/tmp/${file} "${out}/${file}"`, { stdio: 'inherit' });
  execSync(`docker exec ${container} rm /tmp/${file}`);
}
console.log(`✓ Sauvegarde : backups/${file} (${Math.round(statSync(`${out}/${file}`).size / 1024)} Ko)`);
