// Alertes par e-mail : types et appel de la fonction send-alerts
import { functionUrl, invokeFunction, publicAppUrl } from './reportMail';

export const ALERT_FUNCTION = 'send-alerts';
export const alertFunctionUrl = () => functionUrl(ALERT_FUNCTION);
export { publicAppUrl };

export type AlertLevel = 'info' | 'warn' | 'danger';
export type AlertCategory = 'maintenance' | 'securite' | 'suivi';
export type AlertMode = 'immediat' | 'quotidien' | 'hebdomadaire' | 'meteo';
export type AlertAudience = 'port' | 'responsables' | 'admin' | 'personnel';

export interface AlertKind {
  code: string; category: AlertCategory; label: string; description: string;
  mode: AlertMode; audience: AlertAudience; remind_days: number | null; enabled: boolean; sort: number;
}

export interface AlertEvent {
  id: string; kind: string; key: string; drone_port_id: string | null; target_user: string | null; level: AlertLevel;
  title: string; detail: string | null; link: string | null; first_seen_at: string; last_seen_at: string;
  resolved_at: string | null; notified_at: string | null; notify_count: number;
}

export interface AlertSettings {
  enabled: boolean; functions_url: string | null; app_url: string | null;
  visit_warn_hours: number; part_warn_pct: number; battery_cycle_pct: number; battery_health_warn: number; battery_health_danger: number;
  cell_critical_v: number; cells: number; report_open_days: number; crm_hours: number; work_order_days: number; quarantine_days: number;
  pilot_inactive_days: number; live_overdue_min: number; live_stale_min: number; wind_max_ms: number; gust_max_ms: number; rain_prob_max: number;
  updated_at: string;
}

export interface AlertDispatch {
  id: string; mode: AlertMode | 'test'; trigger: 'cron' | 'manuel' | 'test'; recipient: string; alert_count: number;
  status: 'envoye' | 'erreur' | 'simule'; error: string | null; subject: string | null; created_at: string;
}

export const CATEGORY_LABEL: Record<AlertCategory, string> = { securite: 'Sécurité des vols', maintenance: 'Maintenance', suivi: 'Suivi administratif' };
export const CATEGORY_ORDER: AlertCategory[] = ['securite', 'maintenance', 'suivi'];
export const LEVEL_LABEL: Record<AlertLevel, string> = { danger: 'Urgent', warn: 'À prévoir', info: 'Info' };
export const MODE_LABEL: Record<AlertMode | 'test', string> = {
  immediat: 'Immédiat', quotidien: 'Récapitulatif quotidien (07 h)', hebdomadaire: 'Hebdomadaire (lundi 07 h)', meteo: 'La veille à 18 h', test: 'Aperçu de test',
};
export const AUDIENCE_LABEL: Record<AlertAudience, string> = {
  port: 'Pilotes du drone port + administrateurs', responsables: 'Responsables maintenance du drone port + administrateurs',
  admin: 'Administrateurs', personnel: 'Le pilote concerné',
};

/** Seuils modifiables, regroupés par thème : libellé, explication, unité, pas de saisie, valeur par défaut (migration) */
export interface ThresholdField { key: keyof AlertSettings; label: string; hint: string; unit: string; def: number }
export interface ThresholdGroup { title: string; icon: 'wrench' | 'alert' | 'wind' | 'book'; fields: ThresholdField[] }

export const THRESHOLD_GROUPS: ThresholdGroup[] = [
  {
    title: 'Maintenance', icon: 'wrench', fields: [
      { key: 'visit_warn_hours', label: 'Visite 250 h à prévoir', hint: 'Heures de vol restantes avant l\'échéance', unit: 'h', def: 25 },
      { key: 'part_warn_pct', label: 'Pièce proche du potentiel', hint: 'Part du potentiel déjà consommée', unit: '%', def: 90 },
      { key: 'battery_cycle_pct', label: 'Batterie : cycles', hint: 'Part des cycles maximum atteinte', unit: '%', def: 90 },
      { key: 'battery_health_warn', label: 'Batterie : capacité faible', hint: 'Capacité mesurée sous ce pourcentage de la nominale', unit: '%', def: 85 },
      { key: 'battery_health_danger', label: 'Batterie : capacité critique', hint: 'En dessous, l\'alerte devient urgente', unit: '%', def: 75 },
      { key: 'quarantine_days', label: 'Quarantaine sans décision', hint: 'Délai avant de rappeler de trancher (stock ou rebut)', unit: 'jours', def: 30 },
    ],
  },
  {
    title: 'Sécurité des vols', icon: 'alert', fields: [
      { key: 'cell_critical_v', label: 'Décharge critique', hint: 'Tension d\'arrivée par cellule (pack 12S)', unit: 'V/cell.', def: 3.3 },
      { key: 'live_overdue_min', label: 'Drone en retard', hint: 'Dépassement de l\'heure d\'atterrissage prévue', unit: 'min', def: 15 },
      { key: 'live_stale_min', label: 'Position perdue', hint: 'Temps sans position reçue pendant un vol suivi', unit: 'min', def: 10 },
      { key: 'report_open_days', label: 'Rapport non clôturé', hint: 'Ancienneté d\'un rapport technique encore ouvert', unit: 'jours', def: 7 },
    ],
  },
  {
    title: 'Météo du lendemain', icon: 'wind', fields: [
      { key: 'wind_max_ms', label: 'Vent moyen', hint: 'Au-delà, la journée est signalée défavorable', unit: 'm/s', def: 12 },
      { key: 'gust_max_ms', label: 'Rafales', hint: 'Au-delà, la journée est signalée défavorable', unit: 'm/s', def: 15 },
      { key: 'rain_prob_max', label: 'Pluie', hint: 'Probabilité de pluie à partir de laquelle on prévient', unit: '%', def: 60 },
    ],
  },
  {
    title: 'Suivi administratif', icon: 'book', fields: [
      { key: 'crm_hours', label: 'CRM à signer', hint: 'Délai après la clôture du vol', unit: 'heures', def: 48 },
      { key: 'work_order_days', label: 'Ordre de travail en attente', hint: 'Délai depuis l\'ouverture sans signature', unit: 'jours', def: 7 },
      { key: 'pilot_inactive_days', label: 'Pilote inactif', hint: 'Durée sans vol (maintien des compétences)', unit: 'jours', def: 30 },
    ],
  },
];
export const THRESHOLD_FIELDS: ThresholdField[] = THRESHOLD_GROUPS.flatMap((g) => g.fields);

export interface AlertRunResult {
  ok: boolean; mode: string; dryRun: boolean;
  results: { recipient: string; alerts: number; status: 'envoye' | 'erreur' | 'simule'; error?: string }[];
  weather?: { port: string; level: string | null; error?: string }[];
}

export const invokeAlerts = (mode: AlertMode | 'test') => invokeFunction<AlertRunResult>(ALERT_FUNCTION, { mode });

export function describeAlertRun(r: AlertRunResult) {
  const st = { envoye: 'envoyé', simule: 'simulé (aucune clé Brevo)', erreur: 'erreur' } as const;
  const lines = r.results.map((x) => `${x.recipient} : ${st[x.status]} (${x.alerts} alerte(s))${x.error ? ` · ${x.error}` : ''}`);
  for (const w of r.weather ?? []) {
    lines.unshift(`Météo ${w.port} : ${w.error ? `erreur (${w.error})` : w.level === 'danger' ? 'vent au-delà des limites demain' : w.level === 'warn' ? 'pluie probable demain' : 'rien à signaler'}`);
  }
  return lines.length ? lines : ['Aucun e-mail à envoyer : pas de nouvelle alerte pour ce mode.'];
}
