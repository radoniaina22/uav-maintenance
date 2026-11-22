import { writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { ENV, FIXTURE_FILE, PASSWORD, USERS } from './env';
import type { Fixture } from './env';

/** Supprime toutes les données créées par les tests sur les drones E2E (triggers désactivés) */
export async function cleanE2E(sql: postgres.Sql) {
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    const drones = await tx`select id from drones where code in ('E2E1', 'E2E2')`;
    const ids = drones.map((d) => d.id as string);
    if (ids.length) {
      await tx`delete from work_order_links where work_order_id in (select id from work_orders where drone_id = any(${ids}))`;
      await tx`delete from work_orders where drone_id = any(${ids})`;
      await tx`delete from crm_signatures where flight_id in (select id from flights where drone_id = any(${ids}))`;
      await tx`delete from flight_plan_estimates where flight_id in (select id from flights where drone_id = any(${ids}))`;
      await tx`delete from flight_windpath_records where flight_id in (select id from flights where drone_id = any(${ids}))`;
      await tx`delete from technical_reports where flight_id in (select id from flights where drone_id = any(${ids}))`;
      await tx`delete from logbook_entries where flight_id in (select id from flights where drone_id = any(${ids}))`;
      await tx`delete from flight_pilots where flight_id in (select id from flights where drone_id = any(${ids}))`;
      await tx`delete from flights where drone_id = any(${ids})`;
      await tx`delete from maintenance_visits where drone_id = any(${ids})`;
    }
    // batteries et packs créés par les tests sur les drone ports E2E
    await tx`delete from battery_capacity_tests where battery_id in (select b.id from batteries b join drone_ports p on p.id = b.drone_port_id where p.name in ('E2E Nord', 'E2E Sud'))`;
    await tx`delete from battery_transfers where battery_id in (select b.id from batteries b join drone_ports p on p.id = b.drone_port_id where p.name in ('E2E Nord', 'E2E Sud'))`;
    await tx`delete from batteries where drone_port_id in (select id from drone_ports where name in ('E2E Nord', 'E2E Sud'))`;
    await tx`delete from battery_packs where drone_port_id in (select id from drone_ports where name in ('E2E Nord', 'E2E Sud'))`;
    await tx`delete from flight_plans where drone_port_id in (select id from drone_ports where name in ('E2E Nord', 'E2E Sud'))`;
    await tx`delete from live_flights where drone_port_id in (select id from drone_ports where name in ('E2E Nord', 'E2E Sud'))`;
    // rapports mensuels validés par les tests (mois de 2001, jamais utilisés par de vraies données)
    await tx`delete from monthly_reports where month < '2002-01-01'`;
    await tx`delete from unfpa_recipients where email like '%@e2e.test'`;
    await tx`delete from report_dispatches where month < '2002-01-01'
               or exists (select 1 from unnest(recipients) r where r like '%@test.local' or r like '%@e2e.test')`;
    // alertes calculées sur les drone ports E2E ou pour les comptes de test (les FK en cascade ne jouent pas ici)
    await tx`delete from alert_events where drone_port_id in (select id from drone_ports where name in ('E2E Nord', 'E2E Sud'))
               or target_user in (select id from auth.users where email like 'e2e-%@test.local')
               or (kind = 'inscription' and key in (select id::text from auth.users where email like 'e2e-%@test.local'))`;
    await tx`delete from alert_optouts where user_id in (select id from auth.users where email like 'e2e-%@test.local')`;
    await tx`delete from alert_dispatches where recipient like '%@test.local'`;
    await tx`delete from audit_log where actor like 'E2E %' or actor like 'e2e-%' or label in ('E2E1', 'E2E2', 'E2E Nord', 'E2E Sud', 'E2E CSB Nord')`;
  });
}

export default async function globalSetup() {
  if (!ENV.API_URL || !ENV.SERVICE_ROLE_KEY) throw new Error('Supabase local introuvable : lancez « npm run db:start »');
  const admin = createClient(ENV.API_URL, ENV.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const sql = postgres(ENV.DB_URL, { max: 1, onnotice: () => {} });
  try {
    // ---- comptes (API d'administration Supabase)
    const { data: list, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
    if (error) throw error;
    const userIds: Record<string, string> = {};
    for (const [k, email] of Object.entries(USERS)) {
      let u = list.users.find((x) => x.email === email);
      if (!u) {
        const r = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
        if (r.error) throw r.error;
        u = r.data.user!;
      } else {
        await admin.auth.admin.updateUserById(u.id, { password: PASSWORD });
      }
      userIds[k] = u.id;
    }

    await cleanE2E(sql);

    // ---- référentiels isolés (triggers désactivés : pas de bruit dans le journal d'audit)
    const fx = await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const port = async (name: string, code: string, lat: number, lon: number) => (await tx`
        insert into drone_ports (name, code, latitude, longitude, active) values (${name}, ${code}, ${lat}, ${lon}, true)
        on conflict (name) do update set active = true, code = excluded.code returning id`)[0].id as string;
      const nord = await port('E2E Nord', 'E2N', -18.9, 47.5);
      const sud = await port('E2E Sud', 'E2S', -21.4, 47.1);
      const pilot = async (name: string, portId: string, lead = false) => {
        const ex = await tx`select id from pilots where full_name = ${name}`;
        if (ex.length) { await tx`update pilots set drone_port_id = ${portId}, active = true, maintenance_lead = ${lead} where id = ${ex[0].id}`; return ex[0].id as string; }
        return (await tx`insert into pilots (full_name, drone_port_id, active, maintenance_lead) values (${name}, ${portId}, true, ${lead}) returning id`)[0].id as string;
      };
      // « E2E Pilote Nord » est responsable maintenance ; le copilote et le pilote Sud ne le sont pas
      const pNord = await pilot('E2E Pilote Nord', nord, true), pNord2 = await pilot('E2E Copilote Nord', nord), pSud = await pilot('E2E Pilote Sud', sud);
      const prof = async (uid: string, role: string, pilotId: string | null) => {
        await tx`insert into profiles (user_id, role, pilot_id) values (${uid}, ${role}, ${pilotId})
                 on conflict (user_id) do update set role = excluded.role, pilot_id = excluded.pilot_id`;
      };
      await prof(userIds.admin, 'admin', null);
      await prof(userIds.nord, 'pilote', pNord);
      await prof(userIds.nord2, 'pilote', pNord2);
      await prof(userIds.sud, 'pilote', pSud);
      const drone = async (code: string, portId: string) => (await tx`
        insert into drones (code, model, drone_port_id, status, visit_interval_hours) values (${code}, 'Tango 4', ${portId}, 'operationnel', 250)
        on conflict (code) do update set drone_port_id = excluded.drone_port_id, status = 'operationnel' returning id`)[0].id as string;
      const dNord = await drone('E2E1', nord), dSud = await drone('E2E2', sud);
      const ex = await tx`select id from health_facilities where name = 'E2E CSB Nord'`;
      const csb = ex.length ? ex[0].id as string
        : (await tx`insert into health_facilities (name, category, drone_port_id, distance_km, latitude, longitude, active)
                    values ('E2E CSB Nord', 'CSB2', ${nord}, 12.5, -18.8, 47.45, true) returning id`)[0].id as string;
      const f: Fixture = { ports: { nord, sud }, drones: { nord: dNord, sud: dSud }, pilots: { nord: pNord, nord2: pNord2, sud: pSud }, csb };
      return f;
    });
    writeFileSync(FIXTURE_FILE, JSON.stringify(fx, null, 2));
  } finally {
    await sql.end();
  }
}
