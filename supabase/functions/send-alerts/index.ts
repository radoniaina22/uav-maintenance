// Alertes par e-mail (Brevo).
//
// Appels (POST JSON), par pg_cron (en-tête x-cron-secret) ou par un administrateur connecté :
//  * { mode: 'immediat' }     alertes immédiates jamais envoyées (pg_cron toutes les 5 min, seulement s'il y en a)
//  * { mode: 'quotidien' }    récapitulatif du jour : nouvelles alertes et rappels (07:00)
//  * { mode: 'hebdomadaire' } bilan de la semaine + alertes hebdomadaires (lundi 07:15)
//  * { mode: 'meteo' }        prévision du lendemain (Open-Meteo) pour chaque drone port, puis envoi (18:00)
//  * { mode: 'test' }         administrateur : aperçu de toutes ses alertes en cours et du bilan, à lui seul, rien n'est marqué envoyé
// Un e-mail par destinataire et par envoi. Les alertes envoyées sont marquées (alerts_mark_notified) : pas de doublon.
//
// Secrets : BREVO_API_KEY (sans clé, ou avec MAIL_DRY_RUN=1 : rien n'est envoyé, statut « simule »), REPORT_SENDER (facultatif).
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { AlertItem, AlertMode, PortSummary, renderAlertEmail } from '../_shared/alertEmail.ts';

const SENDER = Deno.env.get('REPORT_SENDER') ?? 'auth@qbox-logistic.org';
const SENDER_NAME = 'UAV Maintenance · Alertes';
const BREVO_KEY = (Deno.env.get('BREVO_API_KEY') ?? '').trim().replace(/^["']|["']$/g, '').trim();
const DRY_RUN = !BREVO_KEY || Deno.env.get('MAIL_DRY_RUN') === '1';
const MODES: AlertMode[] = ['immediat', 'quotidien', 'hebdomadaire', 'meteo', 'test'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const unwrap = <T>(r: { data: T | null; error: { message: string } | null }): T => { if (r.error) throw new Error(r.error.message); return r.data as T; };

type Recipient = { email: string; name: string };
type OutboxRow = AlertItem & { user_id: string; email: string; full_name: string; drone_port_id: string | null };
type Settings = { enabled: boolean; app_url: string | null; visit_warn_hours: number; wind_max_ms: number; gust_max_ms: number; rain_prob_max: number };
type Result = { recipient: string; alerts: number; status: 'envoye' | 'erreur' | 'simule'; error?: string };

async function brevoSend(to: Recipient, subject: string, html: string, text: string) {
  if (DRY_RUN) return { status: 'simule' as const, messageId: null };
  if (BREVO_KEY.startsWith('xsmtpsib-')) throw new Error('BREVO_API_KEY contient une clé SMTP (xsmtpsib-…) : il faut une clé API Brevo (xkeysib-…)');
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender: { email: SENDER, name: SENDER_NAME }, to: [{ email: to.email, name: to.name }], subject, htmlContent: html, textContent: text }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error(`Brevo refuse l'envoi (${body?.message ?? 'non autorisé'}) : vérifiez BREVO_API_KEY et le blocage des adresses IP`);
  if (!res.ok) throw new Error(`Brevo ${res.status} : ${body?.message ?? res.statusText}`);
  return { status: 'envoye' as const, messageId: (body?.messageId as string) ?? null };
}

/** Prévision du lendemain (06 h – 18 h, heure de Madagascar) pour chaque drone port actif ayant des coordonnées */
async function checkWeather(db: SupabaseClient, s: Settings) {
  const ports = unwrap(await db.from('drone_ports').select('id, name, latitude, longitude').eq('active', true)) as
    { id: string; name: string; latitude: number | null; longitude: number | null }[];
  const tomorrow = new Date(Date.now() + 3 * 3600_000 + 86400_000).toISOString().slice(0, 10);
  const out: { port: string; level: string | null; error?: string }[] = [];
  for (const p of ports) {
    if (p.latitude == null || p.longitude == null) continue;
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}`
        + '&hourly=wind_speed_10m,wind_gusts_10m,precipitation_probability&wind_speed_unit=ms&timezone=Indian%2FAntananarivo&forecast_days=3';
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
      const h = (await res.json()).hourly as { time: string[]; wind_speed_10m: number[]; wind_gusts_10m: number[]; precipitation_probability: number[] };
      const idx = h.time.map((t, i) => ({ t, i })).filter(({ t }) => t.startsWith(tomorrow) && +t.slice(11, 13) >= 6 && +t.slice(11, 13) < 18).map(({ i }) => i);
      if (!idx.length) continue;
      const wind = idx.map((i) => h.wind_speed_10m[i] ?? 0), gust = idx.map((i) => h.wind_gusts_10m[i] ?? 0), rain = idx.map((i) => h.precipitation_probability[i] ?? 0);
      const badWind = idx.filter((_, k) => wind[k] > s.wind_max_ms || gust[k] > s.gust_max_ms).map((i) => h.time[i].slice(11, 13));
      const badRain = idx.filter((_, k) => rain[k] >= s.rain_prob_max).map((i) => h.time[i].slice(11, 13));
      const level = badWind.length ? 'danger' : badRain.length ? 'warn' : null;
      const span = (hrs: string[]) => (hrs.length === idx.length ? 'toute la journée' : `${hrs.length} h sur 12 (${hrs[0]} h – ${+hrs[hrs.length - 1] + 1} h)`);
      const detail = [
        `Vent max ${Math.max(...wind).toFixed(1)} m/s (limite ${s.wind_max_ms}), rafales ${Math.max(...gust).toFixed(1)} m/s (limite ${s.gust_max_ms}), pluie jusqu'à ${Math.max(...rain)} %`,
        badWind.length ? `au-delà des limites de vent : ${span(badWind)}` : null,
        badRain.length ? `pluie probable : ${span(badRain)}` : null,
      ].filter(Boolean).join(' · ');
      const [y, m, d] = tomorrow.split('-');
      unwrap(await db.rpc('alerts_set_weather', {
        p_port: p.id, p_date: tomorrow, p_level: level,
        p_title: `${badWind.length ? 'Vent fort' : 'Pluie probable'} demain ${d}/${m}/${y} · ${p.name}`, p_detail: detail,
      }));
      out.push({ port: p.name, level });
    } catch (e) {
      out.push({ port: p.name, level: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

async function run(db: SupabaseClient, mode: AlertMode, s: Settings, trigger: 'cron' | 'manuel' | 'test', me: { id: string; email: string } | null) {
  const weather = mode === 'meteo' ? await checkWeather(db, s) : undefined;
  unwrap(await db.rpc('alerts_refresh'));
  const test = mode === 'test';
  const rows = unwrap(await db.rpc('alerts_outbox', { p_mode: test ? 'tout' : mode, p_only_user: test ? me!.id : null })) as OutboxRow[];

  // un destinataire = ses alertes (+ le bilan de ses drone ports en hebdomadaire / test)
  const people = new Map<string, { name: string; userId: string; alerts: AlertItem[]; ports: Set<string> | 'all' | null }>();
  for (const r of rows) {
    const p = people.get(r.email) ?? { name: r.full_name, userId: r.user_id, alerts: [], ports: null };
    p.alerts.push(r);
    people.set(r.email, p);
  }
  let summary: PortSummary[] = [];
  if (mode === 'hebdomadaire' || test) {
    summary = unwrap(await db.rpc('alerts_weekly_summary')) as PortSummary[];
    const digest = unwrap(await db.rpc('alerts_digest_recipients', { p_only_user: test ? me!.id : null })) as
      { user_id: string; email: string; full_name: string; is_admin: boolean; drone_port_id: string | null }[];
    for (const d of digest) {
      const p = people.get(d.email) ?? { name: d.full_name, userId: d.user_id, alerts: [], ports: null };
      p.ports = d.is_admin ? 'all' : new Set(d.drone_port_id ? [d.drone_port_id] : []);
      people.set(d.email, p);
    }
  }
  if (test && !people.size && me) people.set(me.email, { name: me.email, userId: me.id, alerts: [], ports: null });

  const results: Result[] = [];
  const sent = new Set<string>();
  for (const [email, p] of people) {
    const ports = p.ports === 'all' ? summary : p.ports ? summary.filter((x) => (p.ports as Set<string>).has(x.port_id)) : [];
    if (!p.alerts.length && !ports.length) continue;
    const mail = renderAlertEmail({ mode, name: p.name, alerts: p.alerts, summary: ports, appUrl: s.app_url, visitWarnHours: s.visit_warn_hours });
    let status: Result['status'] = 'erreur', messageId: string | null = null, error: string | null = null;
    try {
      ({ status, messageId } = await brevoSend({ email, name: p.name }, mail.subject, mail.html, mail.text));
      if (!test) for (const a of p.alerts) sent.add(a.event_id);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    unwrap(await db.from('alert_dispatches').insert({
      mode, trigger, recipient: email, alert_count: p.alerts.length, status, error, message_id: messageId, subject: mail.subject, created_by: me?.id ?? null,
    }));
    results.push({ recipient: email, alerts: p.alerts.length, status, ...(error ? { error } : {}) });
  }
  if (sent.size) unwrap(await db.rpc('alerts_mark_notified', { p_ids: [...sent] }));
  return { mode, dryRun: DRY_RUN, results, ...(weather ? { weather } : {}) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée' }, 405);
  try {
    return await handle(req);
  } catch (e) {
    console.error('send-alerts', e);
    return json({ error: `Erreur de la fonction d'alerte : ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return json({ error: 'Configuration de la fonction incomplète (SUPABASE_URL / clé de service)' }, 500);
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  let body: { mode?: AlertMode };
  try { body = await req.json(); } catch { return json({ error: 'Corps JSON invalide' }, 400); }
  const mode = body.mode;
  if (!mode || !MODES.includes(mode)) return json({ error: 'Mode inconnu' }, 400);

  // authentification : secret pg_cron, ou administrateur connecté
  let me: { id: string; email: string } | null = null, fromCron = false;
  const cronSecret = req.headers.get('x-cron-secret');
  if (cronSecret) {
    fromCron = unwrap(await db.rpc('mr_cron_secret_ok', { p_secret: cronSecret })) === true;
    if (!fromCron) return json({ error: 'Secret invalide' }, 401);
    if (mode === 'test') return json({ error: 'Mode réservé à un administrateur' }, 400);
  } else {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u } = token ? await db.auth.getUser(token) : { data: null };
    if (!u?.user) return json({ error: 'Connexion requise' }, 401);
    const prof = unwrap(await db.from('profiles').select('role').eq('user_id', u.user.id).maybeSingle()) as { role: string } | null;
    if (prof?.role !== 'admin') return json({ error: 'Réservé aux administrateurs' }, 403);
    me = { id: u.user.id, email: u.user.email ?? '' };
  }

  const s = unwrap(await db.from('alert_settings').select('enabled, app_url, visit_warn_hours, wind_max_ms, gust_max_ms, rain_prob_max').single()) as Settings;
  if (fromCron && !s.enabled) return json({ ok: true, skipped: 'Alertes désactivées' });
  const trigger = fromCron ? 'cron' : mode === 'test' ? 'test' : 'manuel';
  if (fromCron) {
    // réponse immédiate à pg_cron, envoi poursuivi en arrière-plan
    // @ts-ignore EdgeRuntime est fourni par Supabase
    EdgeRuntime.waitUntil(run(db, mode, s, trigger, me).catch((e: unknown) => console.error('Alertes', e)));
    return json({ ok: true, started: true, mode, dryRun: DRY_RUN }, 202);
  }
  return json({ ok: true, ...(await run(db, mode, s, trigger, me)) });
}
