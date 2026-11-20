import { supabase, unwrap } from './supabase';
import type { FlightRow } from './types';

/** Colonnes nécessaires aux statistiques */
export const STAT_COLUMNS = [
  'id', 'flight_date', 'takeoff_time', 'duration_min', 'time_to_drop_min', 'flight_type', 'qrf', 'qrf_cause', 'qrf_conditions',
  'distance_km', 'payload_kg', 'destination_id', 'destination_name', 'drone_id', 'drone_code', 'drone_port_id', 'drone_port_name',
  'organization', 'consumption_mah', 'avg_wind_ms', 'cruise_altitude_m', 'status', 'pilot_names',
].join(',');

export type StatFlight = Pick<FlightRow,
  'id' | 'flight_date' | 'takeoff_time' | 'duration_min' | 'time_to_drop_min' | 'flight_type' | 'qrf' | 'qrf_cause' | 'qrf_conditions' |
  'distance_km' | 'payload_kg' | 'destination_id' | 'destination_name' | 'drone_id' | 'drone_code' | 'drone_port_id' | 'drone_port_name' |
  'organization' | 'consumption_mah' | 'avg_wind_ms' | 'cruise_altitude_m' | 'status' | 'pilot_names'>;

/** Charge tous les vols d'une période (pagination : l'API renvoie 1 000 lignes max par requête) */
export async function fetchFlights(from: string, to: string, portId: string): Promise<StatFlight[]> {
  const PAGE = 1000;
  const out: StatFlight[] = [];
  for (let offset = 0; ; offset += PAGE) {
    let q = supabase.from('v_flights').select(STAT_COLUMNS).gte('flight_date', from).lte('flight_date', to)
      .order('flight_date').order('takeoff_time').range(offset, offset + PAGE - 1);
    if (portId) q = q.eq('drone_port_id', portId);
    const rows = unwrap(await q) as unknown as StatFlight[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

// ---------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------
export const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const parseIso = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s: string, n: number) => { const d = parseIso(s); d.setDate(d.getDate() + n); return iso(d); };
export const daysBetween = (a: string, b: string) => Math.round((parseIso(b).getTime() - parseIso(a).getTime()) / 86400000);
export const shiftYear = (s: string, n: number) => {
  const d = parseIso(s); const day = d.getDate();
  d.setFullYear(d.getFullYear() + n);
  if (d.getDate() !== day) d.setDate(0); // 29 février -> 28
  return iso(d);
};

export type Preset = 'annee' | 'annee_prec' | '12mois' | 'mois' | '30j' | 'perso';

export const PRESETS: { key: Preset; label: string }[] = [
  { key: 'annee', label: 'Année en cours' },
  { key: 'annee_prec', label: 'Année précédente' },
  { key: '12mois', label: '12 derniers mois' },
  { key: 'mois', label: 'Mois en cours' },
  { key: '30j', label: '30 derniers jours' },
  { key: 'perso', label: 'Période personnalisée' },
];

/** Période + période de comparaison (même période un an avant, ou la période précédente de même durée) */
export function rangeFor(preset: Preset, custom: { from: string; to: string }, today = iso(new Date())) {
  const y = parseIso(today).getFullYear();
  let from: string, to: string, yearly = false;
  switch (preset) {
    case 'annee': from = `${y}-01-01`; to = today; yearly = true; break;
    case 'annee_prec': from = `${y - 1}-01-01`; to = `${y - 1}-12-31`; yearly = true; break;
    case '12mois': from = addDays(shiftYear(today, -1), 1); to = today; yearly = true; break;
    case 'mois': from = `${today.slice(0, 8)}01`; to = today; break;
    case '30j': from = addDays(today, -29); to = today; break;
    default: from = custom.from; to = custom.to;
  }
  if (from > to) [from, to] = [to, from];
  const len = daysBetween(from, to) + 1;
  const prev = yearly || preset === 'mois'
    ? (preset === 'mois'
      ? (() => { const d = parseIso(from); d.setMonth(d.getMonth() - 1); const pf = iso(d); return { from: pf, to: addDays(pf, len - 1) }; })()
      : { from: shiftYear(from, -1), to: shiftYear(to, -1) })
    : { from: addDays(from, -len), to: addDays(from, -1) };
  return { from, to, len, prev };
}

// ---------------------------------------------------------------------
// Agrégats
// ---------------------------------------------------------------------
const n = (v: number | null | undefined) => (v == null ? 0 : Number(v));
export const isDelivered = (f: StatFlight) => f.flight_type === 'livraison' && !f.qrf;

export function summarize(flights: StatFlight[]) {
  const delivered = flights.filter(isDelivered);
  const deliveryAttempts = flights.filter((f) => f.flight_type === 'livraison');
  const qrf = flights.filter((f) => f.qrf);
  const control = flights.filter((f) => f.flight_type === 'controle');
  const minutes = flights.reduce((s, f) => s + n(f.duration_min), 0);
  const km = flights.reduce((s, f) => s + n(f.distance_km), 0);
  const kg = delivered.reduce((s, f) => s + n(f.payload_kg), 0);
  const csb = new Set(delivered.map((f) => f.destination_id).filter(Boolean));
  const days = new Set(flights.map((f) => f.flight_date));
  const withDrop = delivered.filter((f) => f.time_to_drop_min != null);
  const energy = flights.filter((f) => f.consumption_mah != null && n(f.distance_km) > 0);
  const pilots = new Set(flights.flatMap((f) => (f.pilot_names ? f.pilot_names.split(', ') : [])));
  const pct = (a: number, b: number) => (b ? (100 * a) / b : null);
  return {
    flights: flights.length,
    delivered: delivered.length,
    deliveryAttempts: deliveryAttempts.length,
    successRate: pct(delivered.length, deliveryAttempts.length),
    qrf: qrf.length,
    qrfRate: pct(qrf.length, flights.length),
    qrfMeteo: qrf.filter((f) => f.qrf_cause === 'meteo').length,
    qrfTech: qrf.filter((f) => f.qrf_cause === 'technique').length,
    control: control.length,
    controlRate: pct(control.length, flights.length),
    hours: minutes / 60,
    avgMinutes: flights.length ? minutes / flights.length : null,
    km,
    kg,
    avgKg: delivered.length ? kg / delivered.length : null,
    csb: csb.size,
    activeDays: days.size,
    flightsPerActiveDay: days.size ? flights.length / days.size : null,
    avgTimeToDrop: withDrop.length ? withDrop.reduce((s, f) => s + n(f.time_to_drop_min), 0) / withDrop.length : null,
    mahPerKm: energy.length
      ? energy.reduce((s, f) => s + n(f.consumption_mah), 0) / energy.reduce((s, f) => s + n(f.distance_km), 0)
      : null,
    pilots: pilots.size,
    drones: new Set(flights.map((f) => f.drone_id)).size,
    openFlights: flights.filter((f) => f.status === 'ouvert').length,
  };
}
export type Summary = ReturnType<typeof summarize>;

/** Vols par jour sur toute la période (jours sans vol = 0) */
export function daily(flights: StatFlight[], from: string, to: string) {
  const map = new Map<string, { flights: number; delivered: number; qrf: number; control: number; minutes: number }>();
  for (let d = from; d <= to; d = addDays(d, 1)) map.set(d, { flights: 0, delivered: 0, qrf: 0, control: 0, minutes: 0 });
  for (const f of flights) {
    const b = map.get(f.flight_date);
    if (!b) continue;
    b.flights++; b.minutes += n(f.duration_min);
    if (isDelivered(f)) b.delivered++;
    if (f.qrf) b.qrf++;
    if (f.flight_type === 'controle') b.control++;
  }
  return Array.from(map, ([date, v]) => ({ date, ...v }));
}

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

/** Regroupement par mois (ou par semaine si la période fait moins de ~3 mois) */
export function buckets(flights: StatFlight[], from: string, to: string) {
  const weekly = daysBetween(from, to) < 92;
  const keyOf = (s: string) => {
    if (!weekly) return s.slice(0, 7);
    const d = parseIso(s); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); // lundi
    return iso(d);
  };
  const labelOf = (k: string) => {
    if (!weekly) { const [y, m] = k.split('-').map(Number); return `${MONTHS[m - 1]} ${String(y).slice(2)}`; }
    const d = parseIso(k); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  const map = new Map<string, { delivered: number; qrf: number; control: number; other: number; minutes: number; km: number; kg: number }>();
  // toutes les cases de la période, même vides
  for (let d = from; d <= to; d = addDays(d, weekly ? 7 : 28)) map.set(keyOf(d), map.get(keyOf(d)) ?? { delivered: 0, qrf: 0, control: 0, other: 0, minutes: 0, km: 0, kg: 0 });
  if (!map.has(keyOf(to))) map.set(keyOf(to), { delivered: 0, qrf: 0, control: 0, other: 0, minutes: 0, km: 0, kg: 0 });
  for (const f of flights) {
    const k = keyOf(f.flight_date);
    const b = map.get(k) ?? { delivered: 0, qrf: 0, control: 0, other: 0, minutes: 0, km: 0, kg: 0 };
    if (f.qrf) b.qrf++;
    else if (f.flight_type === 'controle') b.control++;
    else b.delivered++;
    b.minutes += n(f.duration_min); b.km += n(f.distance_km);
    if (isDelivered(f)) b.kg += n(f.payload_kg);
    map.set(k, b);
  }
  return {
    unit: weekly ? 'semaine' : 'mois',
    rows: Array.from(map).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => ({ key: k, label: labelOf(k), ...v, hours: v.minutes / 60 })),
  };
}

export const WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

export function byWeekday(flights: StatFlight[]) {
  const c = WEEKDAYS.map(() => 0);
  for (const f of flights) c[(parseIso(f.flight_date).getDay() + 6) % 7]++;
  return WEEKDAYS.map((label, i) => ({ label, value: c[i] }));
}

export function byHour(flights: StatFlight[]) {
  const c = Array.from({ length: 24 }, () => 0);
  for (const f of flights) c[Number(f.takeoff_time.slice(0, 2))]++;
  return c.map((value, h) => ({ label: `${String(h).padStart(2, '0')}h`, value }));
}

/** Regroupe et classe (ex. par CSB, par drone) */
export function rank<R, T extends string = string>(items: R[], keyFn: (f: R) => T | null, valueFn: (f: R) => number) {
  const m = new Map<T, number>();
  for (const f of items) { const k = keyFn(f); if (k == null) continue; m.set(k, (m.get(k) ?? 0) + valueFn(f)); }
  return Array.from(m, ([label, value]) => ({ label, value })).filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
}

/** Tableau comparatif par drone port */
export function byPort(flights: StatFlight[]) {
  const groups = new Map<string, StatFlight[]>();
  for (const f of flights) {
    const k = f.drone_port_name ?? 'Non affecté';
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  return Array.from(groups, ([port, fs]) => ({ port, ...summarize(fs) })).sort((a, b) => b.flights - a.flights);
}

/** Export CSV (séparateur « ; », décimales à virgule : ouverture directe dans Excel FR) */
export function toCsv(rows: Record<string, unknown>[]) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    if (v == null) return '';
    const s = typeof v === 'number' ? String(v).replace('.', ',') : Array.isArray(v) ? v.join(' | ') : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => cell(r[c])).join(';'))].join('\r\n');
}

export function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
