/* Échanges entre UAV Maintenance et WindPath (voir public/windpath-bridge.js) */

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
}

export interface WindpathPrefill {
  payloadKg?: number | null;
  capacityMah?: number | null;
  departureVoltage?: number | null;
}

/** État de navigation : formulaire de vol -> planification */
export interface PlanningNavState {
  prefill?: WindpathPrefill;
  returnTo?: string;
  context?: string;
  draft?: unknown;
}

/** Champs du formulaire de vol que WindPath peut renseigner */
export type TransferKey =
  | 'flight_date' | 'takeoff_time' | 'drop_time' | 'landing_time' | 'distance_km' | 'avg_wind_ms' | 'wind_direction_deg'
  | 'cruise_altitude_m' | 'consumption_mah' | 'voltage_start_v' | 'voltage_end_v' | 'payload_kg';

/** État de navigation : planification -> formulaire de vol */
export interface FlightNavState {
  draft?: unknown;
  windpath?: Partial<Record<TransferKey, string>>;
  windpathLabels?: string[];
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
