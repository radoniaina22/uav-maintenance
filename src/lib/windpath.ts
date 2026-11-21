/* Échanges entre UAV Maintenance et WindPath (voir public/windpath-bridge.js) */
import { WEATHER_LIMITS } from './dashboard';

export type Source = 'reel' | 'estime';

export interface WindpathResult {
  error?: string;
  missionName: string | null;
  waypointCount: number;
  windChecked: boolean;
  takeoffDate: string | null;
  takeoffTime: string | null;
  dropTime: { value: string; source: Source } | null;
  landingTime: { value: string; source: Source } | null;
  distanceKm: number | null;
  windSpeedMs: number | null;
  windDirectionDeg: number | null;
  cruiseAltitudeAmsl: number | null;
  consumption: { value: number; source: Source } | null;
  voltageEnd: { value: number; source: Source } | null;
  departureVoltage: number | null;
  payloadKg: number | null;
  /** estimation seule (sans valeurs réelles), enregistrée avec le vol */
  estimate?: PlanEstimate;
}

/** Estimation WindPath retenue pour un vol (table flight_plan_estimates) */
export interface PlanEstimate {
  planId: string | null;
  missionName: string | null;
  waypointCount: number;
  distanceKm: number | null;
  takeoffTime: string | null;
  dropTime: string | null;
  landingTime: string | null;
  durationMin: number | null;
  consumptionMah: number | null;
  voltageEndV: number | null;
  marginPct: number | null;
  windMs: number | null;
  windDirectionDeg: number | null;
  maxWindMs: number | null;
  maxGustMs: number | null;
  payloadKg: number | null;
  capacityMah: number | null;
  windCheckedAt: string | null;
}

/** Ligne à enregistrer dans flight_plan_estimates */
export const estimateRow = (flightId: string, e: PlanEstimate) => ({
  flight_id: flightId, plan_id: e.planId, mission_name: e.missionName, waypoint_count: e.waypointCount, distance_km: e.distanceKm,
  takeoff_time: e.takeoffTime, drop_time: e.dropTime, landing_time: e.landingTime, duration_min: e.durationMin,
  consumption_mah: e.consumptionMah, voltage_end_v: e.voltageEndV, margin_pct: e.marginPct, wind_ms: e.windMs,
  wind_direction_deg: e.windDirectionDeg, max_wind_ms: e.maxWindMs, max_gust_ms: e.maxGustMs, payload_kg: e.payloadKg,
  capacity_mah: e.capacityMah, wind_checked_at: e.windCheckedAt,
});

/** État de la mission envoyé en continu par WindPath */
export interface WindpathStatus {
  waypointCount: number;
  missionName: string | null;
  planId: string | null;
  modified: boolean;
  distanceKm: number | null;
  windChecked: boolean;
  windCheckAgeMin: number | null;
  maxWindMs: number | null;
  maxWindWp: number | null;
  maxGustMs: number | null;
  estimatedMah: number | null;
  capacityMah: number | null;
  marginPct: number | null;
  finalVoltage: number | null;
  durationMin: number | null;
  payloadKg: number | null;
  /** points ayant au moins une valeur réelle saisie (mAh cumulés ou tension) */
  realCount?: number;
  layout?: PlanningLayout;
}

/** Place donnée à la carte ou au tableau des points dans WindPath */
export type PlanningLayout = 'map' | 'balanced' | 'entry';

/** Plan exporté par WindPath (fichier d'origine, ou .plan généré si la mission a été tracée / modifiée) */
export interface PlanFile {
  error?: string;
  fileName: string;
  content: string;
  waypointCount: number;
  distanceKm: number | null;
  generated: boolean;
  missionName: string | null;
}

export interface WindpathPrefill {
  payloadKg?: number | null;
  capacityMah?: number | null;
  departureVoltage?: number | null;
  /** date et heure de décollage prévues, AAAA-MM-JJTHH:MM */
  takeoff?: string | null;
  /** centre de la carte (drone port) quand aucune mission n'est chargée */
  center?: [number, number] | null;
}

/** État de navigation : formulaire de vol -> planification */
export interface PlanningNavState {
  prefill?: WindpathPrefill;
  returnTo?: string;
  context?: string;
  draft?: unknown;
  /** destination et drone port du vol (bibliothèque de plans, historique) */
  destinationId?: string | null;
  portId?: string | null;
  /** drone du vol : partage de la position avec le drone port */
  droneId?: string | null;
}

/** État du vol envoyé par la passerelle toutes les ~5 s (partagé dans live_flights) */
export type WindpathLive = Omit<import('./types').LiveFlight, 'user_id' | 'drone_id' | 'drone_port_id' | 'drone_code' | 'pilot_name' | 'updated_at'>;

/** Champs du formulaire de vol que WindPath peut renseigner */
export type TransferKey =
  | 'flight_date' | 'takeoff_time' | 'drop_time' | 'landing_time' | 'distance_km' | 'avg_wind_ms' | 'wind_direction_deg'
  | 'cruise_altitude_m' | 'consumption_mah' | 'voltage_start_v' | 'voltage_end_v' | 'payload_kg' | 'destination_id';

/** État de navigation : planification -> formulaire de vol */
export interface FlightNavState {
  draft?: unknown;
  windpath?: Partial<Record<TransferKey, string>>;
  windpathLabels?: string[];
  /** estimation à enregistrer avec le vol (comparaison prévu / réel) */
  estimate?: PlanEstimate | null;
}

export interface TransferField {
  key: TransferKey;
  label: string;
  value: string;      // valeur pour le formulaire
  display: string;    // valeur affichée
  source: 'reel' | 'estime' | 'plan';
}

const comma = (v: number, d = 2) => v.toFixed(d).replace('.', ',');

/** Liste des valeurs reportables, avec leur provenance */
export function transferFields(r: WindpathResult): TransferField[] {
  const out: TransferField[] = [];
  const add = (f: TransferField | null) => { if (f) out.push(f); };
  if (r.takeoffDate) add({ key: 'flight_date', label: 'Date du vol', value: r.takeoffDate, display: r.takeoffDate.split('-').reverse().join('/'), source: 'plan' });
  if (r.takeoffTime) add({ key: 'takeoff_time', label: 'Heure de décollage', value: r.takeoffTime, display: r.takeoffTime, source: 'plan' });
  if (r.dropTime) add({ key: 'drop_time', label: 'Heure de largage', value: r.dropTime.value, display: r.dropTime.value, source: r.dropTime.source });
  if (r.landingTime) add({ key: 'landing_time', label: "Heure d'atterrissage", value: r.landingTime.value, display: r.landingTime.value, source: r.landingTime.source });
  if (r.distanceKm != null) add({ key: 'distance_km', label: 'Distance de vol (trajet complet)', value: String(r.distanceKm), display: `${comma(r.distanceKm)} km`, source: 'plan' });
  if (r.windSpeedMs != null) add({ key: 'avg_wind_ms', label: 'Vent moyen', value: String(r.windSpeedMs), display: `${comma(r.windSpeedMs, 1)} m/s`, source: 'estime' });
  if (r.windDirectionDeg != null) add({ key: 'wind_direction_deg', label: 'Direction moyenne du vent', value: String(r.windDirectionDeg), display: `${r.windDirectionDeg}°`, source: 'estime' });
  if (r.cruiseAltitudeAmsl != null) add({ key: 'cruise_altitude_m', label: 'Altitude de croisière (AMSL)', value: String(r.cruiseAltitudeAmsl), display: `${r.cruiseAltitudeAmsl} m`, source: 'plan' });
  if (r.consumption) add({ key: 'consumption_mah', label: 'Consommation', value: String(r.consumption.value), display: `${r.consumption.value.toLocaleString('fr-FR')} mAh`, source: r.consumption.source });
  if (r.departureVoltage != null) add({ key: 'voltage_start_v', label: 'Tension de départ', value: comma(r.departureVoltage), display: `${comma(r.departureVoltage)} V`, source: 'plan' });
  if (r.voltageEnd) add({ key: 'voltage_end_v', label: "Tension d'arrivée", value: comma(r.voltageEnd.value), display: `${comma(r.voltageEnd.value)} V`, source: r.voltageEnd.source });
  if (r.payloadKg != null) add({ key: 'payload_kg', label: 'Poids du colis', value: String(r.payloadKg), display: `${comma(r.payloadKg)} kg`, source: 'plan' });
  return out;
}

export const SOURCE_LABEL: Record<TransferField['source'], string> = {
  reel: 'réel (saisi dans WindPath)',
  plan: 'plan de vol / saisie',
  estime: 'estimation',
};

// ---------------------------------------------------------------------
// Verdict de la mission (mêmes seuils que la météo du tableau de bord)
// ---------------------------------------------------------------------
export type VerdictLevel = 'ok' | 'warn' | 'danger';
export interface PlanVerdict { level: VerdictLevel | 'none'; label: string; reasons: { level: VerdictLevel; text: string }[] }

/** Seuil de la marge batterie : capacité restante après consommation estimée + réserve de route de 20 % */
export const MARGIN_WARN_PCT = 10;

const n1 = (v: number) => v.toFixed(1).replace('.', ',');

export function planVerdict(s: WindpathStatus | null, history?: HistoryStats | null): PlanVerdict {
  if (!s || !s.waypointCount) return { level: 'none', label: 'Aucune mission', reasons: [] };
  const reasons: PlanVerdict['reasons'] = [];
  const age = s.windCheckAgeMin ?? 0;
  if (!s.windChecked) reasons.push({ level: 'warn', text: 'vent non vérifié (« Check waypoint winds »)' });
  else if (age > 60) reasons.push({ level: 'warn', text: `vent vérifié il y a ${Math.floor(age / 60)} h ${String(age % 60).padStart(2, '0')} : relancez avant le vol` });
  if (s.maxWindMs != null) {
    const at = s.maxWindWp ? ` (point ${s.maxWindWp})` : '';
    if (s.maxWindMs > WEATHER_LIMITS.windMax) reasons.push({ level: 'danger', text: `vent ${n1(s.maxWindMs)} m/s${at}, limite ${WEATHER_LIMITS.windMax} m/s` });
    else if (s.maxWindMs > WEATHER_LIMITS.windOk) reasons.push({ level: 'warn', text: `vent ${n1(s.maxWindMs)} m/s${at}` });
  }
  if (s.maxGustMs != null && s.maxGustMs > WEATHER_LIMITS.gustMax) reasons.push({ level: 'danger', text: `rafales ${n1(s.maxGustMs)} m/s, limite ${WEATHER_LIMITS.gustMax} m/s` });
  if (s.marginPct != null) {
    if (s.marginPct < 0) reasons.push({ level: 'danger', text: `réserve de 20 % non couverte (il manque ${Math.round(-s.marginPct)} % de la capacité)` });
    else if (s.marginPct < MARGIN_WARN_PCT) reasons.push({ level: 'warn', text: `marge batterie faible : ${Math.round(s.marginPct)} % après réserve` });
  }
  const ref = history?.similar?.medianMah ?? history?.medianMah;
  if (history && ref != null && s.estimatedMah != null && history.n >= 3 && ref > s.estimatedMah * 1.15) {
    reasons.push({ level: 'warn', text: `estimation optimiste : vos vols vers cette destination consomment ${ref.toLocaleString('fr-FR')} mAh (médiane)` });
  }
  const level: VerdictLevel = reasons.some((r) => r.level === 'danger') ? 'danger' : reasons.length ? 'warn' : 'ok';
  return { level, label: level === 'ok' ? 'Favorable' : level === 'warn' ? 'Limite' : 'Défavorable', reasons };
}

// ---------------------------------------------------------------------
// Historique des vols réels vers une destination (garde-fou de l'estimation)
// ---------------------------------------------------------------------
export interface HistoryFlight {
  consumption_mah: number | null; duration_min: number | null; avg_wind_ms: number | null; payload_kg: number | null;
  distance_km: number | null; voltage_end_v: number | null; flight_date: string;
}
export interface HistoryStats {
  n: number;
  medianMah: number;
  p90Mah: number;
  maxMah: number;
  medianDurationMin: number | null;
  medianWindMs: number | null;
  medianDistanceKm: number | null;
  medianVoltageEnd: number | null;
  lastDate: string;
  /** même calcul limité aux vols de charge comparable (± 0,5 kg), s'il y en a au moins 3 */
  similar: { n: number; medianMah: number; payloadKg: number } | null;
}

const quantile = (sorted: number[], q: number) => {
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};
const nums = (xs: (number | null)[]) => xs.filter((x): x is number => x != null && Number.isFinite(Number(x))).map(Number).sort((a, b) => a - b);
const median = (xs: number[], d = 1) => (xs.length ? Math.round(quantile(xs, 0.5) * 10 ** d) / 10 ** d : null);

export function historyStats(rows: HistoryFlight[], payloadKg?: number | null): HistoryStats | null {
  const withMah = rows.filter((r) => r.consumption_mah != null && Number(r.consumption_mah) > 0);
  if (!withMah.length) return null;
  const mah = nums(withMah.map((r) => r.consumption_mah));
  let similar: HistoryStats['similar'] = null;
  if (payloadKg != null) {
    const sim = nums(withMah.filter((r) => r.payload_kg != null && Math.abs(Number(r.payload_kg) - payloadKg) <= 0.5).map((r) => r.consumption_mah));
    if (sim.length >= 3) similar = { n: sim.length, medianMah: Math.round(quantile(sim, 0.5)), payloadKg };
  }
  return {
    n: mah.length,
    medianMah: Math.round(quantile(mah, 0.5)),
    p90Mah: Math.round(quantile(mah, 0.9)),
    maxMah: Math.round(mah[mah.length - 1]),
    medianDurationMin: median(nums(withMah.map((r) => r.duration_min)), 0),
    medianWindMs: median(nums(withMah.map((r) => r.avg_wind_ms))),
    medianDistanceKm: median(nums(withMah.map((r) => r.distance_km))),
    medianVoltageEnd: median(nums(withMah.map((r) => r.voltage_end_v)), 2),
    lastDate: withMah.map((r) => r.flight_date).sort().reverse()[0] ?? '',
    similar,
  };
}
