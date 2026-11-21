// Rapports mensuels : types des JSON renvoyés par les fonctions SQL
// (monthly_tech_report, monthly_admin_report, monthly_delivery_report) et utilitaires d'affichage / export.
// Tous les chiffres sont calculés en base : ce module ne fait que les présenter.

export type ReportKind = 'pilotes' | 'admin' | 'unfpa';

/** Adresse d'expédition des rapports (vérifiée dans Brevo) ; l'Edge Function d'envoi utilise la même */
export const REPORT_SENDER = 'auth@qbox-logistic.org';

export const REPORT_KINDS: { key: ReportKind; label: string; hint: string; adminOnly: boolean }[] = [
  { key: 'pilotes', label: 'Rapport technique pilotes', hint: 'Un rapport par drone port : flotte, batteries, pièces, incidents, OT, CRM', adminOnly: false },
  { key: 'admin', label: 'Rapport technique administrateur', hint: 'Consolidé tous drone ports, volet par CSB, points d\'attention', adminOnly: true },
  { key: 'unfpa', label: 'Rapport livraisons UNFPA', hint: 'Poids livré, CSB desservis par district, efficacité', adminOnly: true },
];

export const REPORT_RPC: Record<ReportKind, string> = {
  pilotes: 'monthly_tech_report',
  admin: 'monthly_admin_report',
  unfpa: 'monthly_delivery_report',
};

export interface Period { month: string; from: string; to: string; provisional: boolean; generated_at: string }

export interface FlightSummary {
  flights: number; deliveries: number; controls: number; qrf: number; minutes: number; km: number; kg: number;
  open_flights: number; drones_flown: number;
}

export interface OpenFlight { flight_id: string; flight_date: string; takeoff_time: string; drone_code: string; drone_port_name: string | null; destination_name: string | null }

export interface FleetRow {
  id: string; code: string; model: string; status: string; drone_port_name: string | null;
  flights: number; minutes: number; qrf: number; total_hours: number | null; next_visit_hours: number | null;
  hours_to_next_visit: number | null; last_visit_date: string | null; visits_in_month: number; reports_in_month: number;
  open_reports: number | null; open_work_orders: number;
}

export interface Batteries {
  packs: { id: string; pack_number: number; status: string; drone_port_name: string | null; flights_in_month: number; max_total_cycles: number | null; max_cycle_pct: number | null; min_health_pct: number | null }[];
  alerts: { id: string; code: string; drone_port_name: string | null; total_cycles: number; max_cycles: number; cycle_pct: number; health_pct: number | null; level: 'warn' | 'danger' }[];
  transfers: { date: string; battery: string; from_port: string | null; to_port: string | null; notes: string | null }[];
}

export interface Parts {
  counts: Record<string, number>;
  mounted_by_type: { type_name: string; n: number }[];
  events: { at: string; event_type: string; part_code: string; type_name: string; drone_code: string | null; slot: string | null; reason: string | null }[];
  stock_low: { drone_port_name: string; type_name: string; min_qty: number; in_stock: number }[];
  near_limit: { id: string; code: string; type_name: string; drone_code: string | null; slot_label: string | null; total_hours: number; max_hours: number; potential_pct: number }[];
}

export interface OpenReport {
  id: string; flight_id: string; flight_date: string; drone_code: string; destination_name: string | null; drone_port_name: string | null;
  report_type: 'technique' | 'incident'; severity: 'mineur' | 'majeur' | 'critique'; component: string | null; description: string; status: string; age_days: number;
}
export interface Reports {
  month_total: number; month_incidents: number; month_by_severity: Record<'mineur' | 'majeur' | 'critique', number>;
  closed_in_month: number; avg_resolution_days: number | null; components: { component: string; n: number }[];
  open_total: number; open: OpenReport[];
}

export interface WorkOrders {
  opened_in_month: number; closed_in_month: number; open_total: number; overdue: number;
  open: { id: string; number: string; title: string; drone_code: string; drone_port_name: string | null; kind: string; priority: string; status: string; due_date: string | null; opened_on: string; overdue: boolean }[];
}

export interface Crm {
  closed_flights: number; complete: number;
  incomplete: { flight_id: string; flight_date: string; takeoff_time: string; drone_code: string; drone_port_name: string | null; missing: string[] }[];
}

export interface Qrf {
  total: number; by_cause: Record<'meteo' | 'technique' | 'autre', number>; by_condition: Record<string, number>; retried: number;
  list: { flight_id: string; flight_date: string; drone_code: string; destination_name: string | null; cause: string; conditions: string[]; details: string | null }[];
}

export interface PilotRow {
  id: string; full_name: string; drone_port_name: string | null; active: boolean; flights: number; minutes: number; pic_minutes: number;
  /** vols / minutes en tant que pilote en formation (hors heures) */
  trainee_flights?: number; trainee_minutes?: number; has_account: boolean;
}

export interface FlightRow {
  flight_id: string; flight_date: string; takeoff_time: string; landing_time: string; minutes: number;
  drone_code: string; drone_port_name: string | null; destination_name: string | null;
  flight_type: 'livraison' | 'controle'; qrf: boolean; qrf_cause: string | null;
  payload_kg: number | null; distance_km: number | null; consumption_mah: number | null;
  pack_number: number | null; status: 'ouvert' | 'cloture'; pilot_names: string | null; trainee_name?: string | null; reports: number;
}

export interface TechReport {
  kind: 'pilotes'; period: Period; drone_port: { id: string; name: string } | null;
  summary: FlightSummary; previous: FlightSummary; open_flights: OpenFlight[]; fleet: FleetRow[];
  batteries: Batteries; parts: Parts; reports: Reports; work_orders: WorkOrders; crm: Crm; qrf: Qrf; pilots: PilotRow[];
  flights: FlightRow[];
}

export interface AttentionItem { level: 'danger' | 'warn' | 'info'; category: string; label: string; link: string | null }
export type PortRow = FlightSummary & {
  id: string; name: string; reports_in_month: number; incidents_in_month: number; open_reports: number; qrf_technique: number;
  open_work_orders: number; overdue_work_orders: number; crm_incomplete: number; drones: number; drones_unavailable: number;
};
export interface CsbTechRow {
  id: string; name: string; code: string | null; category: string; district: string | null; region: string | null; drone_ports: string | null;
  flights: number; deliveries: number; qrf: number; qrf_meteo: number; qrf_technique: number;
  avg_minutes: number | null; avg_wind: number | null; avg_consumption: number | null; avg_payload: number | null;
  reports: number; incidents: number; major_reports: number; open_reports: number; watch: boolean; reasons: string[];
}
export interface AdminReport {
  kind: 'admin'; period: Period; summary: FlightSummary; previous: FlightSummary; attention: AttentionItem[]; by_port: PortRow[];
  open_flights: OpenFlight[]; fleet: FleetRow[]; batteries: Batteries; parts: Parts; reports: Reports; work_orders: WorkOrders;
  crm: Crm; qrf: Qrf; csb: { network: { avg_consumption: number | null; avg_wind: number | null }; csb: CsbTechRow[] }; pilots: PilotRow[];
  audit: { entries: number; deletions: number; flights_reopened: number; work_orders_reopened: number };
}

export interface DeliveryKpis {
  from: string; to: string; flights: number; attempts: number; deliveries: number; qrf_deliveries: number; success_rate: number | null;
  kg: number; km: number; minutes: number; delivery_minutes: number; kg_per_delivery: number | null; kg_per_hour: number | null;
  avg_time_to_drop: number | null; avg_minutes: number | null; csb_served: number; districts_served: number;
}
export interface DistrictRow { region: string; district: string; csb_active: number; csb_served: number; deliveries: number; kg: number }
export interface CsbDeliveryRow {
  id: string; name: string; code: string | null; category: string; district: string | null; region: string | null; drone_ports: string | null;
  deliveries: number; kg: number; last_delivery: string | null; first_time: boolean;
}
export interface DeliveryReport {
  kind: 'unfpa'; period: Period; kpis: DeliveryKpis; previous: DeliveryKpis; last_year: DeliveryKpis; ytd: DeliveryKpis;
  csb_active: number; new_csb: number;
  by_port: { id: string; name: string; deliveries: number; kg: number; csb_served: number; qrf: number }[];
  by_org: { organization: string; deliveries: number; kg: number }[];
  by_district: DistrictRow[]; by_csb: CsbDeliveryRow[];
  daily: { date: string; deliveries: number; kg: number }[];
  qrf: Qrf;
}

export type AnyReport = TechReport | AdminReport | DeliveryReport;

// ---------------------------------------------------------------------
// Validation (rapport UNFPA) : table monthly_reports
// ---------------------------------------------------------------------
export interface MonthlyReportRow {
  id: string; kind: 'unfpa'; month: string; status: 'brouillon' | 'valide'; comment: string | null;
  snapshot: DeliveryReport | null; validated_by_name: string | null; validated_at: string | null;
}

/** Écarts entre les chiffres figés à la validation et les chiffres actuels (indicateurs principaux) */
export function snapshotChanges(frozen: DeliveryReport, live: DeliveryReport): string[] {
  const fmt = (v: number | null | undefined, unit = '') => (v == null ? '—' : `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(Number(v))}${unit}`);
  const checks: [string, number | null, number | null, string][] = [
    ['Poids livré', frozen.kpis.kg, live.kpis.kg, ' kg'],
    ['Livraisons réussies', frozen.kpis.deliveries, live.kpis.deliveries, ''],
    ['Tentatives de livraison', frozen.kpis.attempts, live.kpis.attempts, ''],
    ['CSB desservis', frozen.kpis.csb_served, live.kpis.csb_served, ''],
    ['Districts desservis', frozen.kpis.districts_served, live.kpis.districts_served, ''],
  ];
  return checks.filter(([, a, b]) => Number(a ?? 0) !== Number(b ?? 0)).map(([l, a, b, u]) => `${l} : ${fmt(a, u)} → ${fmt(b, u)}`);
}

// ---------------------------------------------------------------------
// Mois
// ---------------------------------------------------------------------
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** « 2026-10 » -> « octobre 2026 » */
export const monthLabel = (m: string) => { const [y, mo] = m.split('-').map(Number); return `${MONTHS[mo - 1]} ${y}`; };

/** Mois écoulé (celui du prochain envoi automatique) au format AAAA-MM */
export function previousMonth(today = new Date()) {
  const d = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function shiftMonth(m: string, n: number) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export const isMonth = (s: string | null): s is string => !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

// ---------------------------------------------------------------------
// Libellés
// ---------------------------------------------------------------------
export const PART_EVENT: Record<string, string> = {
  entree_stock: 'Entrée en stock', montage: 'Montage', demontage: 'Démontage', quarantaine: 'Quarantaine',
  remise_en_stock: 'Remise en stock', rebut: 'Rebut', transfert: 'Transfert',
};
export const WO_KIND: Record<string, string> = { visite: 'Visite', corrective: 'Corrective', remplacement: 'Remplacement', inspection: 'Inspection', autre: 'Autre' };
export const WO_PRIORITY: Record<string, string> = { normale: 'Normale', haute: 'Haute', urgente: 'Urgente' };
export const WO_STATUS: Record<string, string> = { ouvert: 'Ouvert', en_cours: 'En cours', termine: 'Terminé', cloture: 'Clôturé' };
export const CRM_VISA: Record<string, string> = { pilote: 'commandant de bord', copilote: 'copilote', rapports: 'rapports' };

/** Variation en % (null si non calculable) */
export function pctChange(cur: number | null | undefined, prev: number | null | undefined) {
  if (cur == null || prev == null) return null;
  if (Number(prev) === 0) return Number(cur) === 0 ? 0 : null;
  return (100 * (Number(cur) - Number(prev))) / Number(prev);
}

// ---------------------------------------------------------------------
// Annexes CSV (une ligne par élément, colonnes en français)
// ---------------------------------------------------------------------
export function csvRows(r: AnyReport): Record<string, unknown>[] {
  if (r.kind === 'unfpa') {
    return r.by_csb.filter((c) => c.deliveries > 0).map((c) => ({
      CSB: c.name, Code: c.code, Catégorie: c.category, District: c.district, Région: c.region, 'Drone port': c.drone_ports,
      Livraisons: c.deliveries, 'Poids livré (kg)': Number(c.kg), 'Dernière livraison': c.last_delivery, 'Première livraison ce mois': c.first_time ? 'oui' : 'non',
    }));
  }
  if (r.kind === 'admin') {
    return r.csb.csb.map((c) => ({
      CSB: c.name, District: c.district, Région: c.region, 'Drone port': c.drone_ports, Vols: c.flights, Livraisons: c.deliveries,
      QRF: c.qrf, 'QRF météo': c.qrf_meteo, 'QRF technique': c.qrf_technique, 'Durée moyenne (min)': c.avg_minutes,
      'Vent moyen (m/s)': c.avg_wind, 'Consommation moyenne (mAh)': c.avg_consumption, 'Charge moyenne (kg)': c.avg_payload,
      Rapports: c.reports, Incidents: c.incidents, 'Majeurs / critiques': c.major_reports, 'À surveiller': c.watch ? c.reasons.join(', ') : '',
    }));
  }
  return r.fleet.map((d) => ({
    Drone: d.code, Statut: d.status, Vols: d.flights, 'Heures du mois': Math.round(Number(d.minutes) / 6) / 10, QRF: d.qrf,
    'Heures totales': d.total_hours, 'Prochaine visite (h)': d.next_visit_hours, 'Reste avant visite (h)': d.hours_to_next_visit,
    'Visites du mois': d.visits_in_month, 'Rapports du mois': d.reports_in_month, 'Rapports ouverts': d.open_reports, 'OT ouverts': d.open_work_orders,
  }));
}

export const fileBase = (r: AnyReport, portName?: string | null) => {
  const kind = r.kind === 'unfpa' ? 'livraisons-UNFPA' : r.kind === 'admin' ? 'technique-admin' : `technique-pilotes${portName ? `-${portName}` : ''}`;
  return `rapport-${kind}-${r.period.month}`.replace(/[\\/:*?"<>|\s]+/g, '-');
};
