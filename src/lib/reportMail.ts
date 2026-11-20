// Appels de la fonction d'envoi des rapports par e-mail (Edge Function send-monthly-reports, Brevo)
import { supabase } from './supabase';
import type { ReportKind } from './monthlyReports';

export const SEND_FUNCTION = 'send-monthly-reports';
/** Adresse de la fonction, enregistrée dans report_settings pour l'appel mensuel par pg_cron */
export const sendFunctionUrl = () => `${String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '')}/functions/v1/${SEND_FUNCTION}`;
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
  const { data, error } = await supabase.functions.invoke(SEND_FUNCTION, { body });
  if (error) {
    // message d'erreur renvoyé par la fonction (JSON { error })
    const ctx = (error as { context?: Response }).context;
    const msg = ctx && typeof ctx.json === 'function' ? await ctx.json().then((j: { error?: string }) => j.error).catch(() => null) : null;
    throw new Error(msg || "La fonction d'envoi ne répond pas : vérifiez qu'elle est déployée.");
  }
  return data as { ok: boolean; month: string; dryRun: boolean; results: SendResult[] };
}

/** Résumé lisible des résultats d'un envoi */
export function describeResults(r: { dryRun: boolean; results: SendResult[] }) {
  const label: Record<ReportKind, string> = { pilotes: 'pilotes', admin: 'administrateur', unfpa: 'UNFPA' };
  return r.results.map((x) => `Rapport ${label[x.kind]}${x.port ? ` · ${x.port}` : ''} : ${SEND_STATUS[x.status]}${x.status === 'envoye' || x.status === 'simule' ? ` (${x.recipients} destinataire(s))` : ''}${x.error ? ` · ${x.error}` : ''}`);
}
