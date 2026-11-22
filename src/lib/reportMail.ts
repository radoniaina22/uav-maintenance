// Appels de la fonction d'envoi des rapports par e-mail (Edge Function send-monthly-reports, Brevo)
import { supabase } from './supabase';
import type { ReportKind } from './monthlyReports';

export const SEND_FUNCTION = 'send-monthly-reports';
/** Adresse d'une fonction d'envoi, enregistrée en base pour les appels par pg_cron */
export const functionUrl = (name: string) => `${String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '')}/functions/v1/${name}`;
export const sendFunctionUrl = () => functionUrl(SEND_FUNCTION);
/** Adresse publique de l'application (liens et logo des e-mails) ; pas d'adresse locale */
export const publicAppUrl = () => {
  const { origin, pathname, hostname } = window.location;
  return /^(localhost|127\.|0\.0\.0\.0)/.test(hostname) ? null : `${origin}${pathname.replace(/index\.html$/, '')}`.replace(/\/+$/, '');
};

export interface SendResult {
  kind: ReportKind; port: string | null; recipients: number;
  status: 'envoye' | 'erreur' | 'simule' | 'deja_envoye' | 'sans_destinataire'; error?: string;
}

export const SEND_STATUS: Record<SendResult['status'], string> = {
  envoye: 'envoyé', erreur: 'erreur', simule: 'simulé (aucune clé Brevo)', deja_envoye: 'déjà envoyé', sans_destinataire: 'aucun destinataire',
};

export async function invokeSend(body: { mode: 'monthly' | 'send'; kind?: ReportKind; month?: string; port?: string | null; test?: boolean; force?: boolean }) {
  return invokeFunction<{ ok: boolean; month: string; dryRun: boolean; results: SendResult[] }>(SEND_FUNCTION, body);
}

/** Appel d'une fonction d'envoi avec un message d'erreur lisible */
export async function invokeFunction<T>(name: string, body: unknown): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body: body as Record<string, unknown> });
  if (error) {
    // réponse de la fonction : message JSON { error }, sinon code HTTP et début du texte reçu
    const ctx = (error as { context?: unknown }).context;
    if (ctx instanceof Response) {
      const text = await ctx.text().catch(() => '');
      let msg: string | null = null;
      try { msg = (JSON.parse(text) as { error?: string }).error ?? null; } catch { /* réponse non JSON */ }
      throw new Error(msg ?? `La fonction d'envoi a répondu ${ctx.status}${text ? ` : ${text.slice(0, 200)}` : ''}`);
    }
    // aucune réponse : réseau, blocage CORS, fonction absente
    const detail = ctx instanceof Error ? ctx.message : error.message;
    throw new Error(`La fonction d'envoi est injoignable (${detail}). Vérifiez la connexion et que la fonction « ${name} » est déployée.`);
  }
  return data as T;
}

/** Résumé lisible des résultats d'un envoi */
export function describeResults(r: { dryRun: boolean; results: SendResult[] }) {
  const label: Record<ReportKind, string> = { pilotes: 'pilotes', admin: 'administrateur', unfpa: 'UNFPA' };
  return r.results.map((x) => `Rapport ${label[x.kind]}${x.port ? ` · ${x.port}` : ''} : ${SEND_STATUS[x.status]}${x.status === 'envoye' || x.status === 'simule' ? ` (${x.recipients} destinataire(s))` : ''}${x.error ? ` · ${x.error}` : ''}`);
}
