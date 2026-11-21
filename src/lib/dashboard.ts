import { useEffect, useState } from 'react';
import { batteryLevel, THRESHOLDS, visitLevel } from './format';
import { POTENTIAL_WARN_PCT } from './parts';
import { addDays, iso } from './stats';
import type { DronePort, DroneStatusRow, PackStatusRow, ReportRow } from './types';
import type { AvObs } from './metar';

// ---------------------------------------------------------------------
// Seuils météo (m/s). À ajuster selon les limites opérationnelles du Tango 4.
// ---------------------------------------------------------------------
export const WEATHER_LIMITS = {
  windOk: 8,        // vent moyen favorable en dessous
  windMax: 12,      // défavorable au-dessus
  gustMax: 15,      // rafales défavorables au-dessus
  rainProbWarn: 60, // probabilité de pluie (%) : limite au-dessus
};

export type Readiness = 'pret' | 'reserve' | 'indisponible';
export const READINESS_LABEL: Record<Readiness, string> = { pret: 'Prêt', reserve: 'Avec réserve', indisponible: 'Indisponible' };
export const READINESS_LEVEL: Record<Readiness, 'ok' | 'warn' | 'danger'> = { pret: 'ok', reserve: 'warn', indisponible: 'danger' };

export interface MountedPart { id: string; code: string; drone_id: string | null; potential_pct: number | null; max_hours_effective: number | null; total_hours: number; type_name: string }

/** Disponibilité d'un drone : croise statut, visite 250 h, pièces, rapports ouverts et packs de batteries du drone port. */
export function droneReadiness(d: DroneStatusRow, ctx: { parts: MountedPart[]; reports: ReportRow[]; packs: PackStatusRow[] }) {
  const stop: string[] = [];
  const warn: string[] = [];
  if (d.status !== 'operationnel') stop.push(`Statut : ${d.status === 'maintenance' ? 'en maintenance' : d.status === 'immobilise' ? 'immobilisé' : 'retiré'}`);
  const v = visitLevel(d.hours_to_next_visit);
  if (v === 'danger') stop.push('Visite 250 h dépassée');
  else if (v === 'warn') warn.push(`Visite 250 h dans ${Math.max(0, d.hours_to_next_visit).toFixed(1).replace('.', ',')} h`);
  const parts = ctx.parts.filter((p) => p.drone_id === d.id && p.potential_pct != null);
  const over = parts.filter((p) => Number(p.potential_pct) >= 100);
  const near = parts.filter((p) => Number(p.potential_pct) >= POTENTIAL_WARN_PCT && Number(p.potential_pct) < 100);
  if (over.length) stop.push(`${over.length} pièce(s) au potentiel dépassé`);
  if (near.length) warn.push(`${near.length} pièce(s) proche(s) du potentiel`);
  const reports = ctx.reports.filter((r) => r.drone_id === d.id);
  const critical = reports.filter((r) => r.severity === 'critique');
  if (critical.length) stop.push(`${critical.length} rapport(s) critique(s) ouvert(s)`);
  else if (reports.length) warn.push(`${reports.length} rapport(s) ouvert(s)`);
  const packs = ctx.packs.filter((p) => p.drone_port_id === d.drone_port_id && p.status === 'en_service' && Number(p.battery_count) >= 2);
  const usable = packs.filter((p) => batteryLevel(Number(p.max_cycle_pct ?? 0)) !== 'danger');
  if (!usable.length) stop.push('Aucun pack de batteries utilisable au drone port');
  else if (usable.every((p) => batteryLevel(Number(p.max_cycle_pct ?? 0)) === 'warn')) warn.push('Packs proches de 500 cycles');
  const state: Readiness = stop.length ? 'indisponible' : warn.length ? 'reserve' : 'pret';
  return { state, reasons: [...stop, ...warn] };
}

/** Rythme moyen (unités / jour) sur une fenêtre, et date estimée pour consommer « remaining ». */
export function projection(remaining: number, perDay: number) {
  if (remaining <= 0) return { days: 0, date: iso(new Date()) };
  if (perDay <= 0) return null;
  const days = Math.ceil(remaining / perDay);
  return { days, date: addDays(iso(new Date()), days) };
}

export const FORECAST_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------
// Météo Open-Meteo (même service que WindPath ; seules les coordonnées du drone port sont envoyées)
// ---------------------------------------------------------------------
export interface Weather {
  current: { time: string; wind: number; gust: number; dir: number; temp: number; code: number; precip: number };
  hours: { time: string; wind: number; gust: number; rainProb: number; code: number }[];
  /** données aviation (METAR / TAF synthétiques) */
  av: { offset: number; now: AvObs };
}
const cache = new Map<string, { at: number; w: Weather }>();

async function fetchWeather(lat: number, lon: number): Promise<Weather> {
  const key = `v4:${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.w;
  const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: String(lat), longitude: String(lon), timezone: 'Indian/Antananarivo', wind_speed_unit: 'ms', forecast_days: '2',
    current: 'temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code,precipitation,dew_point_2m,pressure_msl,visibility,cloud_cover_low,cloud_cover_mid,cloud_cover_high',
    hourly: 'wind_speed_10m,wind_gusts_10m,precipitation_probability,precipitation,weather_code',
  });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Météo indisponible (${r.status})`);
  const j = await r.json();
  const now = j.current.time as string;
  const start = (j.hourly.time as string[]).findIndex((t) => t >= now.slice(0, 13));
  const hours = (j.hourly.time as string[]).slice(Math.max(0, start), Math.max(0, start) + 12).map((time, i) => {
    const k = Math.max(0, start) + i;
    return { time, wind: j.hourly.wind_speed_10m[k], gust: j.hourly.wind_gusts_10m[k], rainProb: j.hourly.precipitation_probability[k] ?? 0, code: j.hourly.weather_code[k] };
  });
  const C = j.current;
  // Pluie pour le METAR. Open-Meteo : la valeur horaire à HH:00 porte sur l'heure précédente,
  // donc le créneau [time[k-1], time[k][ est à l'indice k ; l'heure en cours est à s0 + 1.
  const s0 = Math.max(0, start);
  const H = j.hourly;
  const slot = (k: number) => (k > 0 && k < H.time.length
    ? { start: H.time[k - 1] as string, end: H.time[k] as string, prob: Number(H.precipitation_probability[k] ?? 0), mm: Number(H.precipitation[k] ?? 0), code: Number(H.weather_code[k] ?? 0) }
    : null);
  const cur = slot(s0 + 1), prev = slot(s0);
  // tendance sur les 3 heures suivant l'heure en cours
  const next = [slot(s0 + 2), slot(s0 + 3), slot(s0 + 4)].filter((h): h is NonNullable<typeof h> => h != null);
  const w: Weather = {
    current: { time: now, wind: C.wind_speed_10m, gust: C.wind_gusts_10m, dir: C.wind_direction_10m,
      temp: C.temperature_2m, code: C.weather_code, precip: C.precipitation },
    hours,
    av: {
      offset: Number(j.utc_offset_seconds ?? 10800),
      now: { time: now, wind: C.wind_speed_10m, gust: C.wind_gusts_10m, dir: C.wind_direction_10m, code: C.weather_code, vis: C.visibility ?? 10000,
        low: C.cloud_cover_low ?? 0, mid: C.cloud_cover_mid ?? 0, high: C.cloud_cover_high ?? 0, temp: C.temperature_2m, dew: C.dew_point_2m, qnh: C.pressure_msl,
        nowMm: cur?.mm ?? C.precipitation ?? 0, prevMm: prev?.mm, prevCode: prev?.code, next },
    },
  };
  cache.set(key, { at: Date.now(), w });
  return w;
}

export function useWeather(ports: DronePort[]) {
  const [state, setState] = useState<Record<string, { w?: Weather; error?: string }>>({});
  const key = ports.map((p) => `${p.id}:${p.latitude},${p.longitude}`).join('|');
  useEffect(() => {
    let alive = true;
    const load = () => ports.forEach((p) => {
      if (p.latitude == null || p.longitude == null) return;
      fetchWeather(Number(p.latitude), Number(p.longitude))
        .then((w) => alive && setState((s) => ({ ...s, [p.id]: { w } })))
        .catch((e) => alive && setState((s) => ({ ...s, [p.id]: { error: e instanceof Error ? e.message : String(e) } })));
    });
    load();
    const id = window.setInterval(load, 15 * 60_000);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

/** Codes météo WMO : orage 95–99, pluie 51–67 / 80–82, brouillard 45–48 */
export const isStorm = (c: number) => c >= 95;
export const isRain = (c: number) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82);
export const isFog = (c: number) => c === 45 || c === 48;
export function weatherText(c: number) {
  if (c === 0) return 'Ciel clair';
  if (c <= 2) return 'Peu nuageux';
  if (c === 3) return 'Couvert';
  if (isFog(c)) return 'Brouillard';
  if (c >= 51 && c <= 57) return 'Bruine';
  if (c >= 61 && c <= 67) return 'Pluie';
  if (c >= 80 && c <= 82) return 'Averses';
  if (isStorm(c)) return 'Orage';
  return 'Variable';
}
export function weatherIcon(c: number) {
  if (c === 0) return '☀';
  if (c <= 2) return '⛅';
  if (c === 3) return '☁';
  if (isFog(c)) return '🌫';
  if (isStorm(c)) return '⛈';
  if (isRain(c)) return '🌧';
  return '☁';
}

/** Verdict de vol : favorable / limite / défavorable */
export function flightVerdict(h: { wind: number; gust: number; rainProb?: number; code: number }): { level: 'ok' | 'warn' | 'danger'; label: string; why: string[] } {
  const why: string[] = [];
  let level: 'ok' | 'warn' | 'danger' = 'ok';
  const up = (l: 'warn' | 'danger') => { if (l === 'danger' || level === 'ok') level = l; };
  if (h.wind > WEATHER_LIMITS.windMax) { up('danger'); why.push(`vent ${h.wind.toFixed(0)} m/s`); }
  else if (h.wind > WEATHER_LIMITS.windOk) { up('warn'); why.push(`vent ${h.wind.toFixed(0)} m/s`); }
  if (h.gust > WEATHER_LIMITS.gustMax) { up('danger'); why.push(`rafales ${h.gust.toFixed(0)} m/s`); }
  if (isStorm(h.code)) { up('danger'); why.push('orage'); }
  else if (isRain(h.code)) { up('warn'); why.push('pluie'); }
  if (isFog(h.code)) { up('warn'); why.push('brouillard'); }
  if ((h.rainProb ?? 0) >= WEATHER_LIMITS.rainProbWarn && !isRain(h.code)) { up('warn'); why.push(`pluie ${h.rainProb} %`); }
  return { level, label: level === 'ok' ? 'Favorable' : level === 'warn' ? 'Limite' : 'Défavorable', why };
}

export const THRESHOLD_VISIT = THRESHOLDS.visitWarnHours;
