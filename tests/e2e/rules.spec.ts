import { expect, test } from '@playwright/test';
import { as, expectError, fixture, ok } from './env';
import type { Fixture } from './env';

/**
 * Règles métier vérifiées directement contre la base (API Supabase, avec les comptes de test) :
 * droits par drone port, cycle de vie d'un vol et de son CRM, rapports, ordres de travail, journal d'audit.
 */
test.describe.configure({ mode: 'serial' });

let fx: Fixture;
test.beforeAll(() => { fx = fixture(); });
const today = new Date().toISOString().slice(0, 10);
const flightData = (drone: string, takeoff: string, landing: string) => ({
  drone_id: drone, destination_id: fx.csb, flight_date: today, takeoff_time: takeoff, landing_time: landing, drop_time: null,
  flight_type: 'livraison', organization: 'UNFPA', distance_km: 12.5, payload_kg: 2, observation: 'Test automatique',
});

let flightId = '';
let reportId = '';
let woId = '';

test.describe('Droits par drone port', () => {
  test('un pilote ne voit que son drone port', async () => {
    const nord = await as('nord');
    const drones = await ok(nord.from('drones').select('code').in('code', ['E2E1', 'E2E2']));
    expect(drones.map((d) => d.code)).toEqual(['E2E1']);
  });

  test('un pilote ne peut pas saisir un vol sur un drone d\'un autre drone port', async () => {
    const nord = await as('nord');
    await expectError(nord.rpc('save_flight', { p_id: null, p_data: flightData(fx.drones.sud, '08:00', '08:30'), p_pilot_ids: [fx.pilots.nord] }));
  });

  test('les fonctions d\'administration sont refusées aux pilotes', async () => {
    const nord = await as('nord');
    expect(await expectError(nord.rpc('admin_list_users'))).toMatch(/administrateur/i);
    expect(await ok(nord.from('audit_log').select('id').limit(1))).toHaveLength(0);
  });
});

test.describe('Vol et CRM', () => {
  test('un pilote saisit et clôture un vol de son drone port', async () => {
    const nord = await as('nord');
    flightId = await ok(nord.rpc('save_flight', { p_id: null, p_data: flightData(fx.drones.nord, '07:00', '07:40'), p_pilot_ids: [fx.pilots.nord, fx.pilots.nord2] })) as string;
    expect(flightId).toBeTruthy();
    await ok(nord.rpc('close_flight', { p_id: flightId }));
    const f = await ok(nord.from('flights').select('status').eq('id', flightId).single());
    expect(f.status).toBe('cloture');
  });

  test('chaque membre d\'équipage signe son propre visa, et seulement le sien', async () => {
    const nord = await as('nord'), nord2 = await as('nord2'), sud = await as('sud');
    await ok(nord.rpc('sign_crm', { p_flight: flightId, p_kind: 'pilote' }));
    await expectError(nord2.rpc('sign_crm', { p_flight: flightId, p_kind: 'pilote' }));
    await expectError(sud.rpc('sign_crm', { p_flight: flightId, p_kind: 'copilote' }));
    await ok(nord2.rpc('sign_crm', { p_flight: flightId, p_kind: 'copilote' }));
    expect(await ok(nord.from('crm_signatures').select('kind').eq('flight_id', flightId))).toHaveLength(2);
  });

  test('la réouverture par un administrateur annule les visas', async () => {
    const admin = await as('admin');
    await ok(admin.rpc('reopen_flight', { p_id: flightId }));
    expect(await ok(admin.from('crm_signatures').select('kind').eq('flight_id', flightId))).toHaveLength(0);
    await ok(admin.rpc('close_flight', { p_id: flightId }));
  });
});

test.describe('Pilote en formation', () => {
  test('3e membre facultatif : heures à part dans son carnet, pas de visa CRM', async () => {
    const nord = await as('nord'), nord2 = await as('nord2');
    // le pilote en formation doit être différent du pilote
    await expectError(nord.rpc('save_flight', { p_id: null, p_data: flightData(fx.drones.nord, '09:00', '09:30'), p_pilot_ids: [fx.pilots.nord], p_trainee_id: fx.pilots.nord }));
    const id = await ok(nord.rpc('save_flight', {
      p_id: null, p_data: flightData(fx.drones.nord, '09:00', '09:30'), p_pilot_ids: [fx.pilots.nord], p_trainee_id: fx.pilots.nord2,
    })) as string;
    const crew = await ok(nord.from('flight_pilots').select('pilot_id, role').eq('flight_id', id).order('role'));
    expect(crew).toEqual([{ pilot_id: fx.pilots.nord, role: 'pilote' }, { pilot_id: fx.pilots.nord2, role: 'stagiaire' }]);
    const v = await ok(nord.from('v_flights').select('pilot_names, trainee_name').eq('id', id).single());
    expect(v).toEqual({ pilot_names: 'E2E Pilote Nord', trainee_name: 'E2E Copilote Nord' });
    // un seul pilote en formation par vol
    await expectError(nord.from('flight_pilots').insert({ flight_id: id, pilot_id: fx.pilots.sud, role: 'stagiaire' }));

    const before = await ok(nord2.from('v_pilot_stats').select('total_hours, trainee_hours').eq('id', fx.pilots.nord2).single());
    await ok(nord.rpc('close_flight', { p_id: id }));
    const after = await ok(nord2.from('v_pilot_stats').select('total_hours, trainee_hours, trainee_flight_count').eq('id', fx.pilots.nord2).single());
    expect(Number(after.total_hours)).toBe(Number(before.total_hours)); // hors total
    expect(Number(after.trainee_hours)).toBeCloseTo(Number(before.trainee_hours) + 0.5, 1);
    expect(after.trainee_flight_count).toBeGreaterThanOrEqual(1);
    const entry = await ok(nord2.from('v_logbook').select('role').eq('flight_id', id).single());
    expect(entry.role).toBe('stagiaire');
    // pas de visa CRM à signer pour le pilote en formation
    const tasks = await ok(nord2.rpc('my_crm_tasks')) as { flight_id: string }[];
    expect(tasks.some((t) => t.flight_id === id)).toBe(false);
  });
});

test.describe('Comptes rendus techniques', () => {
  test('la clôture exige une mesure corrective', async () => {
    const nord = await as('nord');
    const r = await ok(nord.from('technical_reports').insert({
      flight_id: flightId, report_type: 'technique', severity: 'mineur', component: 'GPS', description: 'Perte de fix (test automatique)', status: 'ouvert',
    }).select('id').single());
    reportId = r.id;
    await expectError(nord.from('technical_reports').update({ status: 'clos' }).eq('id', reportId));
    await ok(nord.from('technical_reports').update({ status: 'clos', corrective_action: 'Antenne resserrée, test au sol OK' }).eq('id', reportId));
    const after = await ok(nord.from('technical_reports').select('status, resolved_by_name').eq('id', reportId).single());
    expect(after.status).toBe('clos');
    expect(after.resolved_by_name).toBe('E2E Pilote Nord');
  });

  test('un rapport clôturé n\'est modifiable que par un administrateur', async () => {
    const nord = await as('nord'), admin = await as('admin');
    await expectError(nord.from('technical_reports').update({ description: 'modifié' }).eq('id', reportId));
    await ok(admin.from('technical_reports').update({ description: 'Perte de fix GPS (test automatique)' }).eq('id', reportId));
  });
});

test.describe('Ordres de travail', () => {
  test('ouverture : numéro OT et compteur du drone renseignés automatiquement', async () => {
    const nord = await as('nord');
    const wo = await ok(nord.from('work_orders').insert({ drone_id: fx.drones.nord, title: 'Contrôle GPS (test automatique)', kind: 'corrective' })
      .select('id, number, hours_at_opening, opened_by_name, drone_port_id').single());
    woId = wo.id;
    expect(wo.number).toMatch(/^OT-\d{4}-\d{4}$/);
    expect(Number(wo.hours_at_opening)).toBeGreaterThan(0);
    expect(wo.opened_by_name).toBe('E2E Pilote Nord');
    expect(wo.drone_port_id).toBe(fx.ports.nord);
  });

  test('un autre drone port ne voit pas l\'OT', async () => {
    const sud = await as('sud');
    expect(await ok(sud.from('work_orders').select('id').eq('id', woId))).toHaveLength(0);
  });

  test('seuls les éléments du même drone peuvent être rattachés', async () => {
    const nord = await as('nord'), sud = await as('sud');
    await ok(nord.from('work_order_links').insert({ work_order_id: woId, kind: 'rapport', ref_id: reportId }));
    const v = await ok(sud.from('maintenance_visits').insert({ drone_id: fx.drones.sud, visit_type: 'autre', visit_date: today, hours_at_visit: 0, notes: 'Test automatique' }).select('id').single());
    await expectError(nord.from('work_order_links').insert({ work_order_id: woId, kind: 'visite', ref_id: v.id }));
  });

  test('la clôture passe obligatoirement par la signature, après les travaux', async () => {
    const nord = await as('nord');
    await expectError(nord.from('work_orders').update({ status: 'cloture' }).eq('id', woId));
    await expectError(nord.rpc('sign_work_order', { p_id: woId }));
    await ok(nord.from('work_orders').update({ status: 'termine' }).eq('id', woId));
    expect(await expectError(nord.rpc('sign_work_order', { p_id: woId }))).toMatch(/travaux/i);
    await ok(nord.from('work_orders').update({ work_done: 'Antenne GPS remplacée, essai au sol OK' }).eq('id', woId));
    // un pilote du même drone port sans la qualification « responsable maintenance » ne peut pas signer
    const nord2 = await as('nord2');
    expect(await expectError(nord2.rpc('sign_work_order', { p_id: woId }))).toMatch(/responsable maintenance/i);
    await ok(nord.rpc('sign_work_order', { p_id: woId }));
    const wo = await ok(nord.from('work_orders').select('status, signed_by_name').eq('id', woId).single());
    expect(wo).toEqual({ status: 'cloture', signed_by_name: 'E2E Pilote Nord' });
  });

  test('un OT clôturé est verrouillé, sauf pour un administrateur', async () => {
    const nord = await as('nord'), admin = await as('admin');
    await expectError(nord.from('work_orders').update({ title: 'modifié' }).eq('id', woId));
    await expectError(nord.rpc('reopen_work_order', { p_id: woId }));
    await ok(admin.rpc('reopen_work_order', { p_id: woId }));
    const wo = await ok(admin.from('work_orders').select('status, signed_by').eq('id', woId).single());
    expect(wo).toEqual({ status: 'termine', signed_by: null });
  });
});

test.describe('Journal d\'audit', () => {
  test('chaque modification est tracée avec son auteur et le détail des champs', async () => {
    const admin = await as('admin');
    const rows = await ok(admin.from('audit_log').select('action, actor, changes').eq('table_name', 'work_orders').eq('record_id', woId).order('id'));
    expect(rows[0].action).toBe('INSERT');
    const toFinished = rows.find((r) => r.changes?.status?.new === 'termine');
    expect(toFinished?.actor).toBe('E2E Pilote Nord');
    expect(toFinished?.changes.status.old).toBe('ouvert');
  });

  test('le journal ne peut pas être modifié, même par un administrateur', async () => {
    const admin = await as('admin');
    await expectError(admin.from('audit_log').insert({ table_name: 'x', action: 'INSERT' }));
    const del = await admin.from('audit_log').delete().eq('record_id', woId).select('id');
    expect(del.data ?? []).toHaveLength(0);
  });
});

test.describe('Rapports mensuels', () => {
  const month = `${today.slice(0, 7)}-01`;

  test('un pilote obtient le rapport technique de son seul drone port', async () => {
    const nord = await as('nord');
    const r = await ok(nord.rpc('monthly_tech_report', { p_month: month, p_port: null })) as {
      drone_port: { id: string }; fleet: { code: string }[]; flights: { flight_id: string; drone_code: string }[];
    };
    expect(r.drone_port.id).toBe(fx.ports.nord);
    // liste des vols du mois : le vol saisi plus haut, et aucun vol d'un autre drone port
    expect(r.flights.map((f) => f.flight_id)).toContain(flightId);
    expect(r.flights.every((f) => f.drone_code !== 'E2E2')).toBe(true);
    const codes = r.fleet.map((d) => d.code);
    expect(codes).toContain('E2E1');
    expect(codes).not.toContain('E2E2');
    expect(await expectError(nord.rpc('monthly_tech_report', { p_month: month, p_port: fx.ports.sud }))).toMatch(/votre drone port/i);
  });

  test('les rapports administrateur et UNFPA sont refusés aux pilotes', async () => {
    const nord = await as('nord');
    expect(await expectError(nord.rpc('monthly_admin_report', { p_month: month }))).toMatch(/administrateurs/i);
    expect(await expectError(nord.rpc('monthly_delivery_report', { p_month: month }))).toMatch(/administrateurs/i);
    // les fonctions internes de calcul ne sont pas exposées
    await expectError(nord.rpc('mr_fleet', { p_from: month, p_to: month, p_port: null }));
  });

  test('le rapport UNFPA compte le vol livré vers le CSB de test', async () => {
    const admin = await as('admin');
    const r = await ok(admin.rpc('monthly_delivery_report', { p_month: month })) as {
      kpis: { deliveries: number; kg: number }; by_csb: { id: string; deliveries: number; kg: number }[];
    };
    expect(r.kpis.deliveries).toBeGreaterThanOrEqual(1);
    const csb = r.by_csb.find((c) => c.id === fx.csb);
    expect(csb?.deliveries).toBeGreaterThanOrEqual(1);
    expect(Number(csb?.kg)).toBeGreaterThanOrEqual(2);
  });

  test('le rapport administrateur couvre les deux drone ports de test', async () => {
    const admin = await as('admin');
    const r = await ok(admin.rpc('monthly_admin_report', { p_month: month })) as { by_port: { id: string }[]; attention: unknown[]; csb: { csb: { id: string }[] } };
    const ids = r.by_port.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([fx.ports.nord, fx.ports.sud]));
    expect(Array.isArray(r.attention)).toBe(true);
    expect(r.csb.csb.map((c) => c.id)).toContain(fx.csb);
  });
});

test.describe('Validation du rapport UNFPA', () => {
  const past = '2001-01-01'; // mois de test (nettoyé par cleanE2E)

  test('réservée aux administrateurs', async () => {
    const nord = await as('nord');
    await expectError(nord.rpc('validate_monthly_report', { p_kind: 'unfpa', p_month: past }));
    await expectError(nord.rpc('save_monthly_report_comment', { p_kind: 'unfpa', p_month: past, p_comment: 'x' }));
    expect(await ok(nord.from('monthly_reports').select('id'))).toHaveLength(0);
  });

  test('impossible tant que le mois n\'est pas terminé', async () => {
    const admin = await as('admin');
    expect(await expectError(admin.rpc('validate_monthly_report', { p_kind: 'unfpa', p_month: `${today.slice(0, 7)}-01` }))).toMatch(/pas terminé/i);
  });

  test('la validation fige les chiffres et verrouille le commentaire ; la réouverture les libère', async () => {
    const admin = await as('admin');
    await ok(admin.rpc('save_monthly_report_comment', { p_kind: 'unfpa', p_month: past, p_comment: 'Faits marquants (test)' }));
    const v = await ok(admin.rpc('validate_monthly_report', { p_kind: 'unfpa', p_month: '2001-01-15' })) as {
      status: string; comment: string; month: string; snapshot: { kind: string; period: { month: string } }; validated_by_name: string;
    };
    expect(v.status).toBe('valide');
    expect(v.month).toBe(past);
    expect(v.comment).toBe('Faits marquants (test)');
    expect(v.snapshot.kind).toBe('unfpa');
    expect(v.snapshot.period.month).toBe('2001-01');
    expect(v.validated_by_name).toBeTruthy();
    expect(await expectError(admin.rpc('save_monthly_report_comment', { p_kind: 'unfpa', p_month: past, p_comment: 'modif' }))).toMatch(/rouvrez/i);
    expect(await expectError(admin.rpc('validate_monthly_report', { p_kind: 'unfpa', p_month: past }))).toMatch(/déjà validé/i);
    // pas d'écriture directe dans la table, même pour un administrateur
    await expectError(admin.from('monthly_reports').update({ comment: 'direct' }).eq('month', past).select('id').single());
    const r = await ok(admin.rpc('reopen_monthly_report', { p_kind: 'unfpa', p_month: past })) as { status: string; snapshot: unknown; comment: string };
    expect(r.status).toBe('brouillon');
    expect(r.snapshot).toBeNull();
    expect(r.comment).toBe('Faits marquants (test)');
  });
});

test.describe('Destinataires des rapports', () => {
  test('liste UNFPA : réservée aux administrateurs', async () => {
    const nord = await as('nord');
    await expectError(nord.from('unfpa_recipients').insert({ email: 'pirate@e2e.test', full_name: 'Pirate' }).select('id').single());
    expect(await ok(nord.from('unfpa_recipients').select('id'))).toHaveLength(0);
    expect(await expectError(nord.rpc('report_auto_recipients'))).toMatch(/administrateurs/i);
  });

  test('adresse normalisée, doublon et adresse invalide refusés', async () => {
    const admin = await as('admin');
    const r = await ok(admin.from('unfpa_recipients').insert({ email: '  Chef.Programme@E2E.test ', full_name: ' Chef programme ' }).select('email, full_name, active').single());
    expect(r).toEqual({ email: 'chef.programme@e2e.test', full_name: 'Chef programme', active: true });
    await expectError(admin.from('unfpa_recipients').insert({ email: 'CHEF.programme@e2e.test', full_name: 'Doublon' }).select('id').single());
    await expectError(admin.from('unfpa_recipients').insert({ email: 'pas-une-adresse', full_name: 'Invalide' }).select('id').single());
  });

  test('destinataires automatiques : pilotes par drone port et administrateurs', async () => {
    const admin = await as('admin');
    const rows = await ok(admin.rpc('report_auto_recipients')) as { report: string; drone_port_id: string | null; email: string }[];
    const nord = rows.filter((r) => r.report === 'pilotes' && r.drone_port_id === fx.ports.nord).map((r) => r.email);
    expect(nord).toContain('e2e-nord@test.local');
    expect(nord).not.toContain('e2e-sud@test.local');
    expect(rows.filter((r) => r.report === 'admin').map((r) => r.email)).toContain('e2e-admin@test.local');
  });
});

test.describe('Envoi des rapports par e-mail', () => {
  test('réglages et journal réservés aux administrateurs', async () => {
    const nord = await as('nord');
    expect(await ok(nord.from('report_settings').select('auto_send'))).toHaveLength(0);
    expect(await ok(nord.from('report_dispatches').select('id'))).toHaveLength(0);
    expect(await expectError(nord.rpc('set_report_settings', { p_auto_send: true, p_functions_url: 'http://x' }))).toMatch(/administrateurs/i);
    await expectError(nord.rpc('mr_dispatch_cron'));
    await expectError(nord.rpc('mr_cron_secret_ok', { p_secret: 'x' }));
  });

  test('l\'envoi automatique est désactivé par défaut et exige l\'adresse de la fonction', async () => {
    const admin = await as('admin');
    const s = await ok(admin.from('report_settings').select('auto_send').single());
    expect(s.auto_send).toBe(false);
    expect(await expectError(admin.rpc('set_report_settings', { p_auto_send: true, p_functions_url: '' }))).toMatch(/adresse/i);
    // personne ne peut écrire directement dans le journal ni les réglages
    await expectError(admin.from('report_dispatches').insert({ kind: 'admin', month: '2001-01-01', trigger: 'test', status: 'envoye' }).select('id').single());
    await expectError(admin.from('report_settings').update({ auto_send: true }).eq('id', true).select('id').single());
  });
});

test.describe('Batteries', () => {
  test('le numéro de série est facultatif (batterie seule et pack)', async () => {
    const admin = await as('admin');
    const b1 = await ok(admin.from('batteries').insert({ drone_port_id: fx.ports.nord, model: 'Tattu 12S', capacity_mah: 30000, status: 'stock' }).select('id, serial_number').single());
    expect(b1.serial_number).toBeNull();
    // une chaîne vide est refusée par la base (l'application envoie « null » quand le champ est vide)
    await expectError(admin.from('batteries').insert({ drone_port_id: fx.ports.nord, capacity_mah: 30000, status: 'stock', serial_number: '  ' }));
    const pack = await ok(admin.from('battery_packs').insert({ pack_number: 9901, drone_port_id: fx.ports.nord, status: 'en_service' }).select('id').single());
    await ok(admin.from('batteries').insert([
      { pack_id: pack.id, position: 'A', capacity_mah: 30000, status: 'en_service' },
      { pack_id: pack.id, position: 'B', capacity_mah: 30000, status: 'en_service' },
    ]));
    const members = await ok(admin.from('v_battery_status').select('code, serial_number').eq('pack_id', pack.id).order('position'));
    expect(members).toEqual([{ code: '9901A', serial_number: null }, { code: '9901B', serial_number: null }]);
  });

  test('un numéro de série saisi reste unique', async () => {
    const admin = await as('admin');
    await ok(admin.from('batteries').insert({ drone_port_id: fx.ports.nord, capacity_mah: 30000, status: 'stock', serial_number: 'E2E-SN-001' }));
    await expectError(admin.from('batteries').insert({ drone_port_id: fx.ports.nord, capacity_mah: 30000, status: 'stock', serial_number: 'E2E-SN-001' }));
  });
});

test.describe('Vols en cours partagés (trafic)', () => {
  const live = (drone: string, port: string) => ({
    drone_id: drone, drone_port_id: port, status: 'vol', lat: -18.85, lon: 47.62, altitude_m: 150, heading_deg: 51,
    ground_speed_ms: 19.4, phase: 'croisière', next_label: 'pt 3', delay_s: 0, drone_code: 'FAUX', pilot_name: 'Usurpateur',
    route: [[-18.91, 47.53, 0], [-18.78, 47.71, 150]], drop_index: 1,
  });

  test('un pilote partage son vol : visible par son drone port, pas par les autres', async () => {
    const nord = await as('nord'), nord2 = await as('nord2'), sud = await as('sud'), admin = await as('admin');
    const me = (await nord.auth.getUser()).data.user!.id;
    const row = await ok(nord.from('live_flights').upsert(live(fx.drones.nord, fx.ports.nord), { onConflict: 'user_id' })
      .select('user_id, drone_code, pilot_name').single());
    // code du drone et nom du pilote imposés par la base
    expect(row).toEqual({ user_id: me, drone_code: 'E2E1', pilot_name: 'E2E Pilote Nord' });
    expect(await ok(nord2.from('live_flights').select('drone_code').eq('user_id', me))).toEqual([{ drone_code: 'E2E1' }]);
    expect(await ok(sud.from('live_flights').select('drone_code').eq('user_id', me))).toHaveLength(0);
    expect(await ok(admin.from('live_flights').select('drone_code').eq('user_id', me))).toHaveLength(1);
  });

  test('on ne partage pas un drone d\'un autre drone port, ni le vol d\'un autre pilote', async () => {
    const nord = await as('nord'), nord2 = await as('nord2'), sud = await as('sud');
    const me = (await nord.auth.getUser()).data.user!.id;
    // drone du Sud déclaré au Nord : refusé par la base
    expect(await expectError(nord.from('live_flights').upsert(live(fx.drones.sud, fx.ports.nord), { onConflict: 'user_id' }))).toMatch(/appartient pas/i);
    // drone port d'un autre pilote : refusé
    await expectError(sud.from('live_flights').upsert(live(fx.drones.nord, fx.ports.nord), { onConflict: 'user_id' }));
    // le copilote ne peut ni modifier ni supprimer la ligne du pilote
    expect(await ok(nord2.from('live_flights').update({ lat: 0 }).eq('user_id', me).select('user_id'))).toHaveLength(0);
    expect(await ok(nord2.from('live_flights').delete().eq('user_id', me).select('user_id'))).toHaveLength(0);
    expect(await ok(nord.from('live_flights').select('lat').eq('user_id', me).single())).toEqual({ lat: -18.85 });
    // fin de mission : le pilote retire sa ligne
    await ok(nord.from('live_flights').delete().eq('user_id', me));
    expect(await ok(nord2.from('live_flights').select('user_id').eq('user_id', me))).toHaveLength(0);
  });
});
