import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { useApp } from '../lib/app';
import { useData } from '../lib/useData';
import type { FlightRow } from '../lib/types';
import { date as fmtDate, LABELS, THRESHOLDS } from '../lib/format';
import { addDays, daysBetween, download, iso, parseIso, Preset, PRESETS, rangeFor, toCsv } from '../lib/stats';
import { BarList, ChartCard, ColumnChart, fmt, Legend, linearFit, ScatterChart, TipRow } from '../components/charts';
import { ErrorBox, Field, Loading, PageHeader } from '../components/ui';
import { Icon } from '../components/icons';

const C1 = 'var(--series-1)', C2 = 'var(--series-2)', C3 = 'var(--series-3)';
/** Réserve de sécurité conservée en fin de vol pour l'estimation d'autonomie */
const RESERVE_PCT = 20;
/** Écart à la médiane du même CSB au-delà duquel un vol est signalé */
const ANOMALY_PCT = 20;

const COLUMNS = [
  'id', 'flight_date', 'takeoff_time', 'duration_min', 'flight_type', 'qrf', 'qrf_cause', 'distance_km', 'payload_kg',
  'destination_id', 'destination_name', 'drone_id', 'drone_code', 'drone_port_id', 'consumption_mah', 'avg_wind_ms',
  'cruise_altitude_m', 'voltage_start_v', 'voltage_end_v', 'cell_voltage_end', 'pack_capacity_mah', 'pack_number',
].join(',');

type CF = Pick<FlightRow, 'id' | 'flight_date' | 'takeoff_time' | 'duration_min' | 'flight_type' | 'qrf' | 'qrf_cause' | 'distance_km' |
  'payload_kg' | 'destination_id' | 'destination_name' | 'drone_id' | 'drone_code' | 'drone_port_id' | 'consumption_mah' | 'avg_wind_ms' |
  'cruise_altitude_m' | 'voltage_start_v' | 'voltage_end_v' | 'cell_voltage_end' | 'pack_capacity_mah' | 'pack_number'>;

/** Vol enrichi des indicateurs de consommation */
type EF = CF & { mah: number; km: number | null; mahKm: number | null; mahMin: number | null; packPct: number | null; wh: number | null; dev: number | null };

const num = (v: number | string | null | undefined) => (v == null || v === '' ? null : Number(v));
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
function quantile(a: number[], q: number) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
  return s[lo] + (s[hi] - s[lo]) * (p - lo);
}
const ratio = (fs: EF[], top: (f: EF) => number | null, bottom: (f: EF) => number | null) => {
  const ok = fs.filter((f) => top(f) != null && (bottom(f) ?? 0) > 0);
  const b = ok.reduce((s, f) => s + bottom(f)!, 0);
  return b ? ok.reduce((s, f) => s + top(f)!, 0) / b : null;
};
const catColor = (f: CF) => (f.qrf ? C2 : f.flight_type === 'controle' ? C3 : C1);
const catLabel = (f: CF) => (f.qrf ? 'QRF' : LABELS.flightType[f.flight_type]);

const FACTORS = {
  distance: { label: 'Distance (km)', get: (f: EF) => f.km },
  vent: { label: 'Vent moyen (m/s)', get: (f: EF) => num(f.avg_wind_ms) },
  charge: { label: 'Charge utile (kg)', get: (f: EF) => num(f.payload_kg) },
  altitude: { label: 'Altitude de croisière (m AMSL)', get: (f: EF) => num(f.cruise_altitude_m) },
  duree: { label: 'Durée de vol (min)', get: (f: EF) => num(f.duration_min) },
} as const;
type Factor = keyof typeof FACTORS;
const METRICS = {
  mahKm: { label: 'mAh / km', get: (f: EF) => f.mahKm },
  mah: { label: 'mAh consommés', get: (f: EF) => f.mah },
  packPct: { label: '% du pack', get: (f: EF) => f.packPct },
} as const;
type Metric = keyof typeof METRICS;

function strength(r: number) {
  const a = Math.abs(r);
  const s = a >= 0.7 ? 'forte' : a >= 0.4 ? 'modérée' : a >= 0.2 ? 'faible' : 'négligeable';
  return `${s}${a >= 0.2 ? (r > 0 ? ', positive' : ', négative') : ''}`;
}

/** Anneau : part moyenne du pack consommée (orange au-delà de 100 − réserve) */
function BigRing({ pct }: { pct: number | null }) {
  const R = 38, C = 2 * Math.PI * R, v = pct == null ? 0 : Math.min(100, Math.max(0, pct));
  const lvl = pct == null ? 'none' : pct >= 100 ? 'danger' : pct >= 100 - RESERVE_PCT ? 'warn' : 'ok';
  return (
    <div className={`big-ring lvl-${lvl}`}>
      <svg viewBox="0 0 92 92" aria-hidden>
        <circle cx="46" cy="46" r={R} className="br-track" />
        {/* repère de la réserve */}
        <circle cx="46" cy="46" r={R} className="br-reserve" strokeDasharray={`2 ${C}`} strokeDashoffset={-(C * (100 - RESERVE_PCT)) / 100} transform="rotate(-90 46 46)" />
        <circle cx="46" cy="46" r={R} className="br-value" strokeDasharray={`${(C * v) / 100} ${C}`} transform="rotate(-90 46 46)" />
      </svg>
      <span>{pct == null ? '—' : <>{Math.round(pct)}<small>%</small></>}</span>
    </div>
  );
}

/** Batterie : tension moyenne par cellule en fin de vol, de 3,3 V (vide) à 4,2 V (pleine) */
function CellBattery({ v }: { v: number | null }) {
  const fill = v == null ? 0 : Math.min(1, Math.max(0, (v - 3.3) / (4.2 - 3.3)));
  const lvl = v == null ? 'none' : v < THRESHOLDS.cellEndDanger ? 'danger' : v < THRESHOLDS.cellEndWarn ? 'warn' : 'ok';
  return (
    <div className={`cell-batt lvl-${lvl}`} aria-hidden>
      <span className="cb-cap" />
      <span className="cb-body"><span className="cb-fill" style={{ height: `${fill * 100}%` }} /></span>
    </div>
  );
}

export default function Consumption() {
  const { isAdmin, ports, portFilter, setPortFilter, myPort } = useApp();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const csb = params.get('csb') ?? '';
  const drone = params.get('drone') ?? '';
  const setParam = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };
  const [preset, setPreset] = useState<Preset>('annee');
  const year = new Date().getFullYear();
  const [custom, setCustom] = useState({ from: `${year}-01-01`, to: iso(new Date()) });
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);
  const [factor, setFactor] = useState<Factor>('vent');
  const [metric, setMetric] = useState<Metric>('mahKm');
  const [split, setSplit] = useState<'csb' | 'drone'>('csb');

  const { data, error, loading } = useData(async () => {
    const out: CF[] = [];
    for (let off = 0; ; off += 1000) {
      let q = supabase.from('v_flights').select(COLUMNS).gte('flight_date', range.from).lte('flight_date', range.to)
        .order('flight_date').order('takeoff_time').range(off, off + 999);
      if (portFilter) q = q.eq('drone_port_id', portFilter);
      const rows = unwrap(await q) as unknown as CF[];
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  }, [range.from, range.to, portFilter]);

  const a = useMemo(() => {
    if (!data) return null;
    // ---- enrichissement
    const base: EF[] = data.filter((f) => f.consumption_mah != null).map((f) => {
      const mah = Number(f.consumption_mah);
      const km = num(f.distance_km);
      const min = num(f.duration_min);
      const cap = num(f.pack_capacity_mah);
      const vs = num(f.voltage_start_v), ve = num(f.voltage_end_v);
      return {
        ...f, mah, km: km && km > 0 ? km : null,
        mahKm: km && km > 0 ? mah / km : null,
        mahMin: min && min > 0 ? mah / min : null,
        packPct: cap && cap > 0 ? (100 * mah) / cap : null,
        wh: vs != null && ve != null ? (mah / 1000) * ((vs + ve) / 2) : null,
        dev: null,
      };
    });
    // écart à la médiane mAh/km du même CSB (livraisons sans QRF, sur la période)
    const medByCsb = new Map<string, number>();
    for (const id of new Set(base.map((f) => f.destination_id).filter(Boolean) as string[])) {
      const m = quantile(base.filter((f) => f.destination_id === id && !f.qrf && f.mahKm != null).map((f) => f.mahKm!), 0.5);
      if (m != null) medByCsb.set(id, m);
    }
    for (const f of base) {
      const m = f.destination_id ? medByCsb.get(f.destination_id) : undefined;
      if (m && f.mahKm != null && !f.qrf) f.dev = (100 * (f.mahKm - m)) / m;
    }

    const csbs = Array.from(new Map(data.filter((f) => f.destination_id).map((f) => [f.destination_id!, f.destination_name ?? '—'])))
      .sort((x, y) => x[1].localeCompare(y[1]));
    const drones = Array.from(new Map(data.map((f) => [f.drone_id, f.drone_code]))).sort((x, y) => x[1].localeCompare(y[1]));

    const sel = base.filter((f) => (!csb || f.destination_id === csb) && (!drone || f.drone_id === drone));
    const missing = data.filter((f) => (!csb || f.destination_id === csb) && (!drone || f.drone_id === drone) && f.consumption_mah == null).length;
    // référence flotte : mêmes CSB, autres drones
    const fleet = drone ? base.filter((f) => (!csb || f.destination_id === csb) && f.drone_id !== drone) : [];

    const mahs = sel.map((f) => f.mah);
    const packs = sel.map((f) => f.packPct).filter((v): v is number => v != null);
    const cells = sel.map((f) => num(f.cell_voltage_end)).filter((v): v is number => v != null);
    const caps = sel.map((f) => num(f.pack_capacity_mah)).filter((v): v is number => v != null && v > 0);
    const mahKm = ratio(sel, (f) => f.mah, (f) => f.km);
    const mahMin = ratio(sel, (f) => f.mah, (f) => num(f.duration_min));
    const whKm = ratio(sel, (f) => f.wh, (f) => f.km);
    const capMean = mean(caps);
    const usable = capMean != null ? capMean * (1 - RESERVE_PCT / 100) : null;
    const fleetMahKm = fleet.length ? ratio(fleet, (f) => f.mah, (f) => f.km) : null;

    // ---- évolution (semaine si < ~3 mois, sinon mois)
    const weekly = daysBetween(range.from, range.to) < 92;
    const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
    const keyOf = (s: string) => {
      if (!weekly) return s.slice(0, 7);
      const d = parseIso(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d);
    };
    const labelOf = (k: string) => {
      if (!weekly) { const [y, m] = k.split('-').map(Number); return `${MONTHS[m - 1]} ${String(y).slice(2)}`; }
      const d = parseIso(k); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    };
    const keys: string[] = [];
    for (let d = range.from; d <= range.to; d = addDays(d, weekly ? 7 : 28)) if (!keys.includes(keyOf(d))) keys.push(keyOf(d));
    if (!keys.includes(keyOf(range.to))) keys.push(keyOf(range.to));
    const trend = keys.map((k) => {
      const fs = sel.filter((f) => keyOf(f.flight_date) === k);
      return { label: labelOf(k), n: fs.length, mahKm: ratio(fs, (f) => f.mah, (f) => f.km) ?? 0, mah: mean(fs.map((f) => f.mah)) ?? 0 };
    });

    // ---- effet du vent
    const WIND = [[0, 2], [2, 4], [4, 6], [6, 8], [8, 10], [10, Infinity]] as const;
    const wind = WIND.map(([lo, hi]) => {
      const fs = sel.filter((f) => { const w = num(f.avg_wind_ms); return w != null && w >= lo && w < hi; });
      return { label: hi === Infinity ? `≥ ${lo}` : `${lo}–${hi}`, n: fs.length, mahKm: ratio(fs, (f) => f.mah, (f) => f.km) ?? 0 };
    }).filter((b, i, arr) => b.n > 0 || arr.slice(i).some((x) => x.n > 0)); // retire les classes vides en fin

    // ---- part du pack utilisée
    const PACK_BINS = [0, 20, 40, 60, 70, 80, 90, 100];
    const pack = PACK_BINS.map((lo, i) => {
      const hi = PACK_BINS[i + 1] ?? Infinity;
      const n = packs.filter((p) => p >= lo && p < hi).length;
      return { label: hi === Infinity ? '≥ 100 %' : `${lo}–${hi} %`, low: lo >= 100 - RESERVE_PCT ? n : 0, ok: lo >= 100 - RESERVE_PCT ? 0 : n };
    });

    // ---- classements
    const group = (key: (f: EF) => string | null) => {
      const m = new Map<string, EF[]>();
      for (const f of sel) { const k = key(f); if (k) m.set(k, [...(m.get(k) ?? []), f]); }
      return Array.from(m, ([label, fs]) => ({ label, n: fs.length, mah: mean(fs.map((f) => f.mah))!, mahKm: ratio(fs, (f) => f.mah, (f) => f.km), km: mean(fs.map((f) => f.km).filter((v): v is number => v != null)) }));
    };
    const byCsb = group((f) => f.destination_name).sort((x, y) => y.mah - x.mah);
    const byDrone = group((f) => f.drone_code).sort((x, y) => (y.mahKm ?? 0) - (x.mahKm ?? 0));

    const anomalies = sel.filter((f) => f.dev != null && f.dev > ANOMALY_PCT);

    return {
      base, sel, csbs, drones, missing, fleet, fleetMahKm, trend, wind, pack, byCsb, byDrone, anomalies, weekly,
      k: {
        n: sel.length, avgMah: mean(mahs), med: quantile(mahs, 0.5), p90: quantile(mahs, 0.9), maxMah: mahs.length ? Math.max(...mahs) : null,
        mahKm, mahMin, whKm, packAvg: mean(packs), packMax: packs.length ? Math.max(...packs) : null,
        lowReserve: packs.filter((p) => p >= 100 - RESERVE_PCT).length,
        cellAvg: mean(cells), cellMin: cells.length ? Math.min(...cells) : null,
        rangeKm: usable != null && mahKm ? usable / mahKm : null,
        enduranceMin: usable != null && mahMin ? usable / mahMin : null,
        capMean,
      },
    };
  }, [data, csb, drone, range.from, range.to]);

  const portName = portFilter ? ports.find((p) => p.id === portFilter)?.name ?? '' : 'Tous les drone ports';
  const csbName = csb ? a?.csbs.find(([id]) => id === csb)?.[1] ?? 'CSB' : null;
  const droneName = drone ? a?.drones.find(([id]) => id === drone)?.[1] ?? 'Drone' : null;
  const scope = [droneName, csbName && `vers ${csbName}`].filter(Boolean).join(' ') || 'Tous les vols';

  const scatter = useMemo(() => {
    if (!a) return [];
    return a.sel.filter((f) => FACTORS[factor].get(f) != null && METRICS[metric].get(f) != null);
  }, [a, factor, metric]);
  const fit = linearFit(scatter.map((f) => ({ x: FACTORS[factor].get(f)!, y: METRICS[metric].get(f)! })));

  function exportCsv() {
    if (!a) return;
    download(`consommation_${range.from}_${range.to}.csv`, toCsv(a.sel.map((f) => ({
      date: f.flight_date, decollage: f.takeoff_time.slice(0, 5), drone: f.drone_code, destination: f.destination_name,
      type: catLabel(f), distance_km: f.km, duree_min: num(f.duration_min), charge_kg: num(f.payload_kg), vent_ms: num(f.avg_wind_ms),
      altitude_m_amsl: num(f.cruise_altitude_m), conso_mah: f.mah, mah_km: f.mahKm != null ? +f.mahKm.toFixed(1) : null,
      pct_pack: f.packPct != null ? +f.packPct.toFixed(1) : null, wh: f.wh != null ? +f.wh.toFixed(1) : null,
      tension_depart_v: num(f.voltage_start_v), tension_arrivee_v: num(f.voltage_end_v), cellule_fin_v: num(f.cell_voltage_end),
      ecart_mediane_csb_pct: f.dev != null ? +f.dev.toFixed(0) : null,
    }))));
  }

  const k = a?.k;
  const fleetDelta = a && k?.mahKm != null && a.fleetMahKm ? (100 * (k.mahKm - a.fleetMahKm)) / a.fleetMahKm : null;

  return (
    <div className="conso-page">
      <PageHeader title="Analyse des consommations" subtitle={<>{scope} · {portName} · du {fmtDate(range.from)} au {fmtDate(range.to)}</>}
        actions={<button className="btn" onClick={exportCsv} disabled={!a?.sel.length}>⇩ Exporter (CSV)</button>} />

      <div className="card filter-row">
        <Field label="Période">
          <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
            {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}{p.key === 'annee' ? ` (${year})` : p.key === 'annee_prec' ? ` (${year - 1})` : ''}</option>)}
          </select>
        </Field>
        {preset === 'perso' && <>
          <Field label="Du"><input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></Field>
          <Field label="Au"><input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></Field>
        </>}
        <Field label="Drone port">
          {isAdmin ? (
            <select value={portFilter} onChange={(e) => { setPortFilter(e.target.value); }}>
              <option value="">Tous les drone ports</option>
              {ports.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          ) : <select value={myPort?.id} disabled><option>{myPort?.name}</option></select>}
        </Field>
        <Field label="CSB">
          <select value={csb} onChange={(e) => setParam('csb', e.target.value)}>
            <option value="">Tous les CSB</option>
            {a?.csbs.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            {csb && a && !a.csbs.some(([id]) => id === csb) && <option value={csb}>(aucun vol sur la période)</option>}
          </select>
        </Field>
        <Field label="Drone">
          <select value={drone} onChange={(e) => setParam('drone', e.target.value)}>
            <option value="">Tous les drones</option>
            {a?.drones.map(([id, code]) => <option key={id} value={id}>{code}</option>)}
            {drone && a && !a.drones.some(([id]) => id === drone) && <option value={drone}>(aucun vol sur la période)</option>}
          </select>
        </Field>
        {(csb || drone) && <button className="btn btn-ghost btn-sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>Réinitialiser</button>}
      </div>

      <ErrorBox error={error} />
      {!a || !k ? <Loading /> : (
        <div className={`conso-body${loading ? ' viz-refetch' : ''}`}>
          {k.n === 0 ? (
            <div className="alert alert-info">
              Aucun vol avec consommation saisie pour cette sélection{a.missing ? ` (${a.missing} vol(s) sans consommation renseignée)` : ''}. Changez de période, de CSB ou de drone.
            </div>
          ) : <>
            {/* ---- Bandeau énergie ---- */}
            <section className="energy-hero">
              <div className="eh-main">
                <span className="eh-kicker">Consommation de référence</span>
                <div className="eh-big">{k.mahKm != null ? fmt(k.mahKm, 0) : '—'}<span> mAh/km</span></div>
                <div className="eh-sub">
                  {fleetDelta != null
                    ? <><span className={`stat-delta ${fleetDelta > 0 ? 'down' : 'up'}`}>{fleetDelta > 0 ? '▲' : '▼'} {fmt(Math.abs(fleetDelta), 0)} %</span> par rapport aux autres drones{csb ? ' (même CSB)' : ''}</>
                    : k.whKm != null ? `≈ ${fmt(k.whKm)} Wh/km · ${k.n} vol(s) analysé(s)` : `${k.n} vol(s) analysé(s)`}
                </div>
                <div className="eh-chips">
                  <span><b>{fmt(k.avgMah!, 0)}</b> mAh / vol en moyenne</span>
                  <span><b>{fmt(k.med!, 0)}</b> médiane</span>
                  <span title="90 % des vols ont consommé moins">P90 <b>{fmt(k.p90!, 0)}</b></span>
                  {k.mahMin != null && <span><b>{fmt(k.mahMin, 0)}</b> mAh/min · ≈ {fmt((k.mahMin * 60) / 1000, 1)} A</span>}
                </div>
              </div>
              <div className={`eh-gauge${k.packMax != null && k.packMax >= 100 - RESERVE_PCT ? ' is-warn' : ''}`}>
                <BigRing pct={k.packAvg} />
                <div><span className="eh-label">Part du pack</span>
                  <span className="eh-note">{k.packMax != null ? <>max {fmt(k.packMax, 0)} %<br />{k.lowReserve} vol(s) sous {RESERVE_PCT} % de réserve</> : 'capacité pack inconnue'}</span></div>
              </div>
              <div className={`eh-gauge${k.cellMin != null && k.cellMin < THRESHOLDS.cellEndWarn ? ' is-warn' : ''}`}>
                <CellBattery v={k.cellAvg} />
                <div><span className="eh-label">Cellule en fin de vol</span>
                  <strong className="eh-val">{k.cellAvg != null ? `${fmt(k.cellAvg, 2)} V` : '—'}</strong>
                  <span className="eh-note">{k.cellMin != null ? `minimum ${fmt(k.cellMin, 2)} V · seuil ${fmt(THRESHOLDS.cellEndWarn, 2)} V` : 'tensions non saisies'}</span></div>
              </div>
              <div className="eh-gauge">
                <span className="eh-range-icon"><Icon name="pin" size={22} /></span>
                <div><span className="eh-label">Distance max. estimée</span>
                  <strong className="eh-val">{k.rangeKm != null ? `${fmt(k.rangeKm, 0)} km` : '—'}</strong>
                  <span className="eh-note">{k.rangeKm != null ? `réserve ${RESERVE_PCT} %${k.enduranceMin != null ? ` · ≈ ${fmt(k.enduranceMin, 0)} min de vol` : ''}` : 'capacité ou distance manquante'}</span></div>
              </div>
            </section>

            <section className="card">
              <h2 className="card-title">À retenir</h2>
              <div className="insights conso-insights">
                <div className="insight ins-blue"><span className="insight-icon">⚡</span><div><strong>{k.n} vol(s)</strong> analysé(s)<br />
                  <span className="muted">{a.missing ? `${a.missing} vol(s) exclus faute de consommation saisie` : 'tous les vols ont une consommation saisie'}</span></div></div>
                {csb && k.p90 != null && (
                  <div className="insight ins-gold"><span className="insight-icon">⌖</span><div>Pour une mission vers <strong>{csbName}</strong>, prévoir <strong>{fmt(k.p90, 0)} mAh</strong><br />
                    <span className="muted">90 % des vols ont consommé moins{k.capMean ? ` · ${fmt((100 * k.p90) / k.capMean, 0)} % du pack` : ''}</span></div></div>
                )}
                {fit && scatter.length >= 5 && (
                  <div className="insight ins-violet"><span className="insight-icon">↗</span><div>{METRICS[metric].label} et {FACTORS[factor].label.replace(/ \(.*\)/, '').toLowerCase()} : corrélation <strong>{strength(fit.r)}</strong><br />
                    <span className="muted">r = {fmt(fit.r, 2)} · {fit.slope >= 0 ? '+' : ''}{fmt(fit.slope, 1)} {METRICS[metric].label} par unité</span></div></div>
                )}
                {(() => {
                  const w = a.wind.filter((b) => b.n > 0 && b.mahKm > 0);
                  if (w.length < 2) return null;
                  const lo = w[0], hi = w[w.length - 1];
                  return <div className="insight ins-cyan"><span className="insight-icon">☁</span><div>Vent {hi.label} m/s : <strong>{fmt(hi.mahKm, 0)} mAh/km</strong><br />
                    <span className="muted">contre {fmt(lo.mahKm, 0)} mAh/km par vent {lo.label} m/s ({hi.mahKm >= lo.mahKm ? '+' : ''}{fmt((100 * (hi.mahKm - lo.mahKm)) / lo.mahKm, 0)} %)</span></div></div>;
                })()}
                <div className={`insight ${a.anomalies.length ? 'ins-orange' : 'ins-green'}`}><span className="insight-icon">{a.anomalies.length ? '⚠' : '✓'}</span><div><strong>{a.anomalies.length}</strong> vol(s) au-dessus de la normale<br />
                  <span className="muted">plus de {ANOMALY_PCT} % au-dessus de la médiane mAh/km du même CSB</span></div></div>
              </div>
            </section>

            <div className="viz-grid-layout">
              <ChartCard wide title="Facteurs d'influence" subtitle={<>
                Chaque point est un vol (cliquez dessus pour ouvrir sa fiche) · {scatter.length} vol(s) avec {FACTORS[factor].label.replace(/ \(.*\)/, '').toLowerCase()} renseigné(e)
                {fit ? <> · tendance en pointillé (r = {fmt(fit.r, 2)}, {strength(fit.r)})</> : null}</>}
                legend={<div className="row-between viz-controls">
                  <Legend items={[{ key: 'l', label: 'Livraison', color: C1 }, { key: 'q', label: 'QRF', color: C2 }, { key: 'c', label: 'Vol de contrôle', color: C3 }]} />
                  <div className="viz-selects">
                    <label className="small muted">Y <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
                      {(Object.keys(METRICS) as Metric[]).map((m) => <option key={m} value={m}>{METRICS[m].label}</option>)}</select></label>
                    <label className="small muted">selon <select value={factor} onChange={(e) => setFactor(e.target.value as Factor)}>
                      {(Object.keys(FACTORS) as Factor[]).map((f) => <option key={f} value={f}>{FACTORS[f].label}</option>)}</select></label>
                  </div>
                </div>}
                table={{ columns: ['Date', 'Drone', 'CSB', FACTORS[factor].label, METRICS[metric].label],
                  rows: scatter.map((f) => [fmtDate(f.flight_date), f.drone_code, f.destination_name ?? '—', FACTORS[factor].get(f)!, METRICS[metric].get(f)!]) }}>
                {scatter.length ? (
                  <ScatterChart data={scatter} x={(f) => FACTORS[factor].get(f)!} y={(f) => METRICS[metric].get(f)!} color={catColor}
                    xLabel={FACTORS[factor].label} yLabel={METRICS[metric].label}
                    onSelect={(f) => navigate(`/vols/${f.id}`)} selectHint="Cliquer pour ouvrir la fiche du vol"
                    tooltip={(f) => <>
                      <div className="viz-tip-title">{fmtDate(f.flight_date)} · {f.drone_code}</div>
                      <div className="muted small">{f.destination_name ?? catLabel(f)}</div>
                      <TipRow color={catColor(f)} label={METRICS[metric].label} value={fmt(METRICS[metric].get(f)!, 0)} />
                      <TipRow label={FACTORS[factor].label} value={fmt(FACTORS[factor].get(f)!)} />
                    </>} />
                ) : <div className="muted small">Aucun vol avec cette donnée renseignée.</div>}
              </ChartCard>

              <ChartCard title={`Consommation par ${a.weekly ? 'semaine' : 'mois'}`} subtitle="mAh par km parcouru"
                table={{ columns: [a.weekly ? 'Semaine du' : 'Mois', 'Vols', 'mAh/km', 'mAh / vol'], rows: a.trend.map((t) => [t.label, t.n, t.mahKm, t.mah]) }}>
                <ColumnChart data={a.trend} series={[{ key: 'k', label: 'mAh/km', color: C1, value: (t) => t.mahKm }]}
                  tooltip={(t) => <>
                    <div className="viz-tip-title">{t.label}</div>
                    <TipRow color={C1} label="mAh/km" value={t.n ? fmt(t.mahKm, 0) : '—'} />
                    <div className="muted small">{t.n} vol(s){t.n ? ` · ${fmt(t.mah, 0)} mAh / vol` : ''}</div>
                  </>} />
              </ChartCard>

              <ChartCard title="Effet du vent" subtitle="mAh/km selon le vent moyen (m/s)"
                table={{ columns: ['Vent (m/s)', 'Vols', 'mAh/km'], rows: a.wind.map((w) => [w.label, w.n, w.mahKm]) }}>
                {a.wind.some((w) => w.n) ? (
                  <ColumnChart data={a.wind} series={[{ key: 'w', label: 'mAh/km', color: C1, value: (w) => w.mahKm }]}
                    tooltip={(w) => <><div className="viz-tip-title">Vent {w.label} m/s</div><TipRow color={C1} label="mAh/km" value={w.n ? fmt(w.mahKm, 0) : '—'} /><div className="muted small">{w.n} vol(s)</div></>} />
                ) : <div className="muted small">Vent non renseigné.</div>}
              </ChartCard>

              <ChartCard title="Part du pack consommée" subtitle={`Nombre de vols · capacité nominale des 2 batteries · réserve ${RESERVE_PCT} %`}
                legend={<Legend items={[{ key: 'o', label: `Réserve ≥ ${RESERVE_PCT} %`, color: C1 }, { key: 'l', label: `Réserve < ${RESERVE_PCT} %`, color: C2 }]} />}
                table={{ columns: ['% du pack', 'Vols'], rows: a.pack.map((p) => [p.label, p.ok + p.low]) }}>
                <ColumnChart data={a.pack} series={[{ key: 'o', label: 'Réserve suffisante', color: C1, value: (p) => p.ok }, { key: 'l', label: 'Réserve faible', color: C2, value: (p) => p.low }]}
                  tooltip={(p) => <><div className="viz-tip-title">{p.label} du pack</div><TipRow color={p.low ? C2 : C1} label="vol(s)" value={fmt(p.ok + p.low, 0)} /></>} />
              </ChartCard>

              {(!csb || !drone) && (() => {
                // une seule carte « Répartition » (CSB / drone) : la grille reste équilibrée
                const tab = !csb && (split === 'csb' || drone) ? 'csb' : 'drone';
                const tabs = !csb && !drone ? (
                  <div className="segmented segmented-sm" role="tablist" aria-label="Répartition">
                    <button type="button" role="tab" aria-selected={tab === 'csb'} className={tab === 'csb' ? 'active' : ''} onClick={() => setSplit('csb')}>Par CSB</button>
                    <button type="button" role="tab" aria-selected={tab === 'drone'} className={tab === 'drone' ? 'active' : ''} onClick={() => setSplit('drone')}>Par drone</button>
                  </div>
                ) : null;
                return tab === 'csb' ? (
                <ChartCard title="Consommation par CSB" subtitle="mAh moyens par vol · cliquez sur un nom pour filtrer" legend={tabs}
                  table={{ columns: ['CSB', 'Vols', 'mAh / vol', 'mAh/km', 'Distance (km)'], rows: a.byCsb.map((c) => [c.label, c.n, c.mah, c.mahKm ?? 0, c.km ?? 0]) }}>
                  {a.byCsb.length ? <>
                    <BarList data={a.byCsb.map((c) => ({ label: c.label, value: c.mah }))} color={C1} format={(v) => `${fmt(v, 0)} mAh`}
                      sub={(l) => { const c = a.byCsb.find((x) => x.label === l)!; return `${c.n} vol(s)${c.mahKm != null ? ` · ${fmt(c.mahKm, 0)} mAh/km` : ''}${c.km != null ? ` · ${fmt(c.km)} km` : ''}`; }} />
                    <div className="chip-row">
                      {a.byCsb.slice(0, 10).map((c) => { const id = a.csbs.find(([, n]) => n === c.label)?.[0]; return id ? <button key={id} className="chip-btn" onClick={() => setParam('csb', id)}>{c.label}</button> : null; })}
                    </div>
                  </> : <div className="muted small">Aucun vol vers un CSB.</div>}
                </ChartCard>
                ) : (
                <ChartCard title="Consommation par drone" subtitle="mAh par km parcouru · cliquez sur un drone pour filtrer" legend={tabs}
                  table={{ columns: ['Drone', 'Vols', 'mAh/km', 'mAh / vol'], rows: a.byDrone.map((d) => [d.label, d.n, d.mahKm ?? 0, d.mah]) }}>
                  <BarList data={a.byDrone.map((d) => ({ label: d.label, value: d.mahKm ?? 0 }))} color={C1} format={(v) => `${fmt(v, 0)} mAh/km`}
                    sub={(l) => { const d = a.byDrone.find((x) => x.label === l)!; return `${d.n} vol(s) · ${fmt(d.mah, 0)} mAh / vol`; }} />
                  <div className="chip-row">
                    {a.byDrone.map((d) => { const id = a.drones.find(([, c]) => c === d.label)?.[0]; return id ? <button key={id} className="chip-btn" onClick={() => setParam('drone', id)}>{d.label}</button> : null; })}
                  </div>
                </ChartCard>
                );
              })()}
            </div>
            <p className="muted small" style={{ marginTop: 12 }}>
              Seuls les vols avec une consommation saisie sont analysés. Les ratios (mAh/km, mAh/min) sont calculés sur les totaux, pas en moyenne de ratios.
              Part du pack = consommation ÷ capacité nominale des 2 batteries montées en parallèle. Distance max. estimée = capacité moyenne moins {RESERVE_PCT} % de réserve, divisée par la consommation au km.
              Wh estimés avec la tension moyenne (départ + arrivée) ÷ 2.
            </p>
          </>}
        </div>
      )}
    </div>
  );
}
