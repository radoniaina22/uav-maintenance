import { rmSync } from 'node:fs';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { ENV, FIXTURE_FILE, USERS } from './env';
import { cleanE2E } from './global-setup';

/**
 * Supprime tout le jeu de test : données créées par les tests, référentiels E2E et comptes de test.
 * La base de travail retrouve exactement son état d'avant les tests.
 * (E2E_KEEP_DATA=1 pour conserver les données et les inspecter.)
 */
export default async function globalTeardown() {
  if (process.env.E2E_KEEP_DATA) return;
  const sql = postgres(ENV.DB_URL, { max: 1, onnotice: () => {} });
  const admin = createClient(ENV.API_URL, ENV.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  try {
    await cleanE2E(sql);
    const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const ids = (data?.users ?? []).filter((u) => (Object.values(USERS) as string[]).includes(u.email ?? '')).map((u) => u.id);
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      if (ids.length) await tx`delete from profiles where user_id = any(${ids})`;
      await tx`delete from health_facilities where name = 'E2E CSB Nord'`;
      await tx`delete from pilots where full_name in ('E2E Pilote Nord', 'E2E Copilote Nord', 'E2E Pilote Sud')`;
      await tx`delete from drones where code in ('E2E1', 'E2E2')`;
      await tx`delete from drone_ports where name in ('E2E Nord', 'E2E Sud')`;
    });
    for (const id of ids) await admin.auth.admin.deleteUser(id);
    rmSync(FIXTURE_FILE, { force: true });
  } finally {
    await sql.end();
  }
}
