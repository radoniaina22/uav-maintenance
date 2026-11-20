// Envoi des rapports mensuels par e-mail (Brevo).
//
// Appels (POST JSON) :
//  * { mode: 'monthly', month? }                       pg_cron (en-tête x-cron-secret) ou administrateur :
//      rapports pilotes (un par drone port) + rapport administrateur du mois écoulé ; ignore ce qui est déjà parti
//  * { mode: 'send', kind, month, port?, test?, force? }  administrateur :
//      kind = 'unfpa' -> rapport validé, à la liste des destinataires UNFPA (appelé après la validation)
//      test = true    -> uniquement à l'administrateur qui demande (objet préfixé [TEST])
//
// Secrets : BREVO_API_KEY (obligatoire pour un envoi réel), REPORT_SENDER (facultatif, défaut ci-dessous).
// Sans BREVO_API_KEY, ou avec MAIL_DRY_RUN=1, rien n'est envoyé : statut « simule » dans le journal.
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY sont fournis par Supabase (la clé anon n'est pas utilisée).
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { MailKind, renderReportEmail } from '../_shared/reportEmail.ts';

const SENDER = Deno.env.get('REPORT_SENDER') ?? 'auth@qbox-logistic.org';
const SENDER_NAME = 'UAV Maintenance · UNFPA Madagascar';
// espaces, retours à la ligne ou guillemets autour de la valeur saisie : ignorés
const BREVO_KEY = (Deno.env.get('BREVO_API_KEY') ?? '').trim().replace(/^["']|["']$/g, '').trim();
const DRY_RUN = !BREVO_KEY || Deno.env.get('MAIL_DRY_RUN') === '1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

type Recipient = { email: string; name: string };
type Trigger = 'cron' | 'manuel' | 'validation' | 'test';
type Result = { kind: MailKind; port: string | null; status: 'envoye' | 'erreur' | 'simule' | 'deja_envoye' | 'sans_destinataire'; recipients: number; error?: string };

/** Mois écoulé (heure de Madagascar) au format AAAA-MM-01 */
function previousMonth() {
  const now = new Date(Date.now() + 3 * 3600_000); // UTC+3
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 10);
}
const monthStart = (m: string) => `${m.slice(0, 7)}-01`;
const toBase64 = (s: string) => { const b = new TextEncoder().encode(s); let bin = ''; for (const x of b) bin += String.fromCharCode(x); return btoa(bin); };
const unwrap = <T>(r: { data: T | null; error: { message: string } | null }): T => { if (r.error) throw new Error(r.error.message); return r.data as T; };

async function brevoSend(to: Recipient[], subject: string, html: string, text: string, csv: { name: string; content: string }) {
  if (DRY_RUN) return { status: 'simule' as const, messageId: null };
  if (BREVO_KEY.startsWith('xsmtpsib-')) {
    throw new Error('BREVO_API_KEY contient une clé SMTP (xsmtpsib-…) : il faut une clé API Brevo (xkeysib-…), menu « SMTP & API » → onglet « API Keys »');
  }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: SENDER, name: SENDER_NAME },
      to: to.map((r) => ({ email: r.email, name: r.name })),
      subject, htmlContent: html, textContent: text,
      attachment: [{ name: csv.name, content: toBase64(csv.content) }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const m = String(body?.message ?? '');
    if (/IP address/i.test(m)) {
      // les fonctions Supabase n'ont pas d'adresse IP fixe : impossible de les autoriser une par une
      throw new Error('Brevo bloque les adresses IP inconnues : désactivez ce blocage dans Brevo (Sécurité → Adresses IP autorisées), les serveurs d\'envoi n\'ayant pas d\'adresse fixe');
    }
    throw new Error(`Brevo refuse la clé API (${m || 'non autorisée'}) : vérifiez BREVO_API_KEY (clé API xkeysib-…, active dans Brevo)`);
  }
  if (!res.ok) throw new Error(`Brevo ${res.status} : ${body?.message ?? res.statusText}`);
  return { status: 'envoye' as const, messageId: (body?.messageId as string) ?? null };
}

class Dispatcher {
  constructor(private db: SupabaseClient, private appUrl: string | null, private userId: string | null) {}

  /** Envoie un rapport et l'inscrit au journal */
  async deliver(o: { kind: MailKind; month: string; port: { id: string; name: string } | null; to: Recipient[]; trigger: Trigger;
    report: unknown; comment?: string | null; validatedBy?: string | null; validatedAt?: string | null; unfpaPending?: boolean; force?: boolean }): Promise<Result> {
    const portId = o.port?.id ?? null;
    const base: Pick<Result, 'kind' | 'port' | 'recipients'> = { kind: o.kind, port: o.port?.name ?? null, recipients: o.to.length };
    if (!o.to.length) return { ...base, status: 'sans_destinataire' };
    if (o.trigger === 'cron' && !o.force) {
      let q = this.db.from('report_dispatches').select('id').eq('kind', o.kind).eq('month', o.month).eq('status', 'envoye').in('trigger', ['cron', 'manuel']);
      q = portId ? q.eq('drone_port_id', portId) : q.is('drone_port_id', null);
      if ((unwrap(await q.limit(1)) as unknown[]).length) return { ...base, status: 'deja_envoye' };
    }
    const mail = renderReportEmail({ kind: o.kind, report: o.report, comment: o.comment, validatedBy: o.validatedBy, validatedAt: o.validatedAt,
      appUrl: this.appUrl, test: o.trigger === 'test', unfpaPending: o.unfpaPending });
    let status: 'envoye' | 'erreur' | 'simule' = 'erreur', messageId: string | null = null, error: string | null = null;
    try {
      ({ status, messageId } = await brevoSend(o.to, mail.subject, mail.html, mail.text, mail.csv));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    unwrap(await this.db.from('report_dispatches').insert({
      kind: o.kind, month: o.month, drone_port_id: portId, trigger: o.trigger, recipients: o.to.map((r) => r.email),
      status, error, message_id: messageId, subject: mail.subject, created_by: this.userId,
    }));
    return { ...base, status, ...(error ? { error } : {}) };
  }

  async autoRecipients() {
    return unwrap(await this.db.rpc('report_auto_recipients')) as { report: string; drone_port_id: string | null; drone_port_name: string | null; full_name: string; email: string }[];
  }

  async unfpaPending(month: string) {
    const row = unwrap(await this.db.from('monthly_reports').select('status').eq('kind', 'unfpa').eq('month', month).maybeSingle()) as { status: string } | null;
    return row?.status !== 'valide';
  }

  /** Rapports pilotes (un par drone port) et rapport administrateur */
  async monthly(month: string, trigger: Trigger, force: boolean, only?: { kind: 'pilotes' | 'admin'; port?: string | null }, testTo?: Recipient) {
    const auto = await this.autoRecipients();
    const results: Result[] = [];
    if (!only || only.kind === 'pilotes') {
      const ports = new Map<string, { name: string; to: Recipient[] }>();
      for (const r of auto) if (r.report === 'pilotes' && r.drone_port_id) {
        const p = ports.get(r.drone_port_id) ?? { name: r.drone_port_name ?? '?', to: [] };
        p.to.push({ email: r.email, name: r.full_name });
        ports.set(r.drone_port_id, p);
      }
      if (only?.port && !ports.has(only.port)) {
        const dp = unwrap(await this.db.from('drone_ports').select('name').eq('id', only.port).single()) as { name: string };
        ports.set(only.port, { name: dp.name, to: [] });
      }
      for (const [id, p] of ports) {
        if (only?.port && id !== only.port) continue;
        const report = unwrap(await this.db.rpc('monthly_tech_report', { p_month: month, p_port: id }));
        results.push(await this.deliver({ kind: 'pilotes', month, port: { id, name: p.name }, to: testTo ? [testTo] : p.to, trigger, report, force }));
      }
    }
    if (!only || only.kind === 'admin') {
      const to = auto.filter((r) => r.report === 'admin').map((r) => ({ email: r.email, name: r.full_name }));
      const report = unwrap(await this.db.rpc('monthly_admin_report', { p_month: month }));
      results.push(await this.deliver({ kind: 'admin', month, port: null, to: testTo ? [testTo] : to, trigger, report, force, unfpaPending: await this.unfpaPending(month) }));
    }
    return results;
  }

  /** Rapport UNFPA validé -> liste des destinataires UNFPA (ou l'administrateur seul en test, même non validé) */
  async unfpa(month: string, trigger: Trigger, testTo?: Recipient) {
    const row = unwrap(await this.db.from('monthly_reports').select('*').eq('kind', 'unfpa').eq('month', month).maybeSingle()) as
      { status: string; snapshot: unknown; comment: string | null; validated_by_name: string | null; validated_at: string | null } | null;
    let report = row?.status === 'valide' ? row.snapshot : null;
    if (!report) {
      if (!testTo) throw new Error('Le rapport UNFPA de ce mois n\'est pas validé : validez-le avant de l\'envoyer.');
      report = unwrap(await this.db.rpc('monthly_delivery_report', { p_month: month }));
    }
    const to = testTo ? [testTo] : (unwrap(await this.db.from('unfpa_recipients').select('email, full_name').eq('active', true)) as { email: string; full_name: string }[])
      .map((r) => ({ email: r.email, name: r.full_name }));
    return [await this.deliver({ kind: 'unfpa', month, port: null, to, trigger, report, comment: row?.comment,
      validatedBy: row?.status === 'valide' ? row.validated_by_name : null, validatedAt: row?.status === 'valide' ? row.validated_at : null })];
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée' }, 405);
  try {
    return await handle(req);
  } catch (e) {
    // toute erreur imprévue est renvoyée en JSON (sinon l'application n'affiche qu'un message générique)
    console.error('send-monthly-reports', e);
    return json({ error: `Erreur de la fonction d'envoi : ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return json({ error: 'Configuration de la fonction incomplète (SUPABASE_URL / clé de service)' }, 500);
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  let body: { mode?: string; month?: string; kind?: MailKind; port?: string | null; test?: boolean; force?: boolean };
  try { body = await req.json(); } catch { return json({ error: 'Corps JSON invalide' }, 400); }

  // ---- authentification : secret pg_cron, ou administrateur connecté
  let userId: string | null = null, me: Recipient | null = null, fromCron = false;
  const cronSecret = req.headers.get('x-cron-secret');
  if (cronSecret) {
    fromCron = unwrap(await db.rpc('mr_cron_secret_ok', { p_secret: cronSecret })) === true;
    if (!fromCron) return json({ error: 'Secret invalide' }, 401);
  } else {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u } = token ? await db.auth.getUser(token) : { data: null };
    if (!u?.user) return json({ error: 'Connexion requise' }, 401);
    // rôle lu avec la clé de service (pas besoin de la clé anon, absente avec les nouvelles clés API)
    const prof = unwrap(await db.from('profiles').select('role').eq('user_id', u.user.id).maybeSingle()) as { role: string } | null;
    if (prof?.role !== 'admin') return json({ error: 'Réservé aux administrateurs' }, 403);
    userId = u.user.id;
    me = { email: u.user.email ?? '', name: u.user.email ?? 'Administrateur' };
  }

  const settings = unwrap(await db.from('report_settings').select('auto_send, app_url').single()) as { auto_send: boolean; app_url: string | null };
  const d = new Dispatcher(db, settings.app_url, userId);
  const month = body.month ? monthStart(body.month) : previousMonth();

  try {
    if (body.mode === 'monthly') {
      if (fromCron && !settings.auto_send) return json({ ok: true, skipped: 'Envoi automatique désactivé' });
      const run = d.monthly(month, fromCron ? 'cron' : 'manuel', !!body.force);
      if (fromCron) {
        // réponse immédiate à pg_cron, envoi poursuivi en arrière-plan
        // @ts-ignore EdgeRuntime est fourni par Supabase
        EdgeRuntime.waitUntil(run.catch((e: unknown) => console.error('Envoi mensuel', e)));
        return json({ ok: true, started: true, month, dryRun: DRY_RUN }, 202);
      }
      return json({ ok: true, month, dryRun: DRY_RUN, results: await run });
    }
    if (body.mode === 'send' && !fromCron) {
      const testTo = body.test ? me! : undefined;
      if (body.kind === 'unfpa') return json({ ok: true, month, dryRun: DRY_RUN, results: await d.unfpa(month, body.test ? 'test' : 'validation', testTo) });
      if (body.kind === 'pilotes' || body.kind === 'admin') {
        return json({ ok: true, month, dryRun: DRY_RUN,
          results: await d.monthly(month, body.test ? 'test' : 'manuel', true, { kind: body.kind, port: body.port ?? null }, testTo) });
      }
    }
    return json({ error: 'Requête inconnue' }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
