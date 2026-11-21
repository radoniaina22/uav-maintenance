import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { FlightNavState, PlanningNavState } from '../lib/windpath';
import { supabase, unwrap } from '../lib/supabase';
import { useData } from '../lib/useData';
import { byPort, useApp } from '../lib/app';
import type {
  BatteryStatusRow, Drone, Flight, FlightPilot, FlightType, HealthFacility, Organization, PackStatusRow, Pilot, QrfCause, QrfCondition,
} from '../lib/types';
import {
  batteryCode, batteryLevel, cardinal, cellLevel, cellVolts, COMPASS_POINTS, date, healthLevel, isTechCondition, isWeatherCondition, km, LABELS,
  minutes, num, QRF_CONDITION_GROUPS, QRF_TECH_COMPONENT, THRESHOLDS, time, today, toNum, toStr,
} from '../lib/format';
import { ErrorBox, Field, Loading, PageHeader } from '../components/ui';
import { Icon, IconName } from '../components/icons';

/** En-tête de section numérotée, avec indicateur « complet » */
function SectionHead({ n, icon, title, sub, done, right }: {
  n: string; icon: IconName; title: string; sub?: string; done?: boolean | null; right?: React.ReactNode;
}) {
  return (
    <div className="ff-head">
      <span className="ff-num">{n}</span>
      <span className="ff-ico"><Icon name={icon} size={18} /></span>
      <div className="ff-title"><h2 className="card-title">{title}</h2>{sub && <span className="small muted">{sub}</span>}</div>
      {done != null && <span className={`ff-done${done ? ' ok' : ''}`}>{done ? '✓ Complet' : 'À compléter'}</span>}
      {right}
    </div>
  );
}

/** Jauge circulaire de la part du pack consommée */
function PackRing({ pct }: { pct: number | null }) {
  const R = 30, C = 2 * Math.PI * R, v = pct == null ? 0 : Math.min(100, Math.max(0, pct));
  const lvl = pct == null ? 'none' : pct > 100 ? 'danger' : pct >= 80 ? 'warn' : 'ok';
  return (
    <div className={`pack-ring lvl-${lvl}`}>
      <svg viewBox="0 0 72 72" aria-hidden>
        <circle cx="36" cy="36" r={R} className="pr-track" />
        <circle cx="36" cy="36" r={R} className="pr-value" strokeDasharray={`${(C * v) / 100} ${C}`} transform="rotate(-90 36 36)" />
      </svg>
      <span>{pct == null ? '—' : `${Math.round(pct)} %`}</span>
    </div>
  );
}
import ReportFields, { draftToPayload, emptyReport, ReportDraft } from '../components/ReportFields';

interface FormState {
  drone_id: string;
  flight_type: FlightType;
  organization: Organization;
  organization_other: string;
  distance_km: string;
  cruise_altitude_m: string;
  voltage_start_v: string;
  voltage_end_v: string;
  destination_id: string;
  flight_date: string;
  takeoff_time: string;
  drop_time: string;
  landing_time: string;
  payload_kg: string;
  avg_wind_ms: string;
  wind_direction_deg: string;
  consumption_mah: string;
  battery_pack_id: string;
  battery_1_id: string;
  battery_2_id: string;
  pilot_1_id: string;
  pilot_2_id: string;
  /** pilote en formation (facultatif) */
  trainee_id: string;
  observation: string;
  qrf: boolean;
  qrf_cause: QrfCause;
  qrf_conditions: QrfCondition[];
  qrf_time: string;
  qrf_details: string;
  retry_of_flight_id: string;
}

const QRF_BLANK = { qrf: false, qrf_cause: 'meteo' as QrfCause, qrf_conditions: [] as QrfCondition[], qrf_time: '', qrf_details: '', retry_of_flight_id: '' };

const blank: FormState = {
  ...QRF_BLANK,
  drone_id: '', flight_type: 'livraison', organization: 'UNFPA', organization_other: '', distance_km: '', cruise_altitude_m: '',
  voltage_start_v: '', voltage_end_v: '', destination_id: '', flight_date: today(), takeoff_time: '', drop_time: '', landing_time: '',
  payload_kg: '', avg_wind_ms: '', wind_direction_deg: '', consumption_mah: '', battery_pack_id: '', battery_1_id: '', battery_2_id: '',
  pilot_1_id: '', pilot_2_id: '', trainee_id: '', observation: '',
};

/** Équipage d'un vol par rôle : commandant de bord, copilote, pilote en formation */
const crewOf = (fps: FlightPilot[]) => ({
  pilot_1_id: fps.find((x) => x.role === 'pilote')?.pilot_id ?? '',
  pilot_2_id: fps.find((x) => x.role === 'copilote')?.pilot_id ?? '',
  trainee_id: fps.find((x) => x.role === 'stagiaire')?.pilot_id ?? '',
});

const nfCell = (v: number | null) => (v == null ? '—' : v.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/** Saisie d'une tension au format « 48,25 » avec l'estimation par cellule (12S) à côté */
function VoltageField({ label, kind, value, onChange }: { label: string; kind: 'start' | 'end'; value: string; onChange: (v: string) => void }) {
  const v = toNum(value);
  const cell = v != null && !Number.isNaN(v) ? cellVolts(v) : null;
  const lvl = cellLevel(cell, kind);
  return (
    <Field label={`${label} (V)`} hint={kind === 'start' ? 'Pleine charge 12S : 50,40 V (4,20 V/cell.)' : 'Seuil de décharge profonde : 42,00 V (3,50 V/cell.)'}>
      <div className="input-group">
        <input type="text" inputMode="decimal" placeholder="48,25" value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9.,]/g, ''))}
          onBlur={() => { if (v != null && !Number.isNaN(v)) onChange(v.toFixed(2).replace('.', ',')); }} />
        <span className={`cell-badge text-${lvl}`} title={`Tension par cellule estimée (pack ${THRESHOLDS.cells}S)`}>
          {cell != null ? `≈ ${nfCell(cell)} V/cell.` : 'V/cell.'}
        </span>
      </div>
    </Field>
  );
}

const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

export default function FlightForm() {
  const { id } = useParams();
  const editing = Boolean(id);
  const nav = useNavigate();
  const [params] = useSearchParams();
  const retryId = editing ? null : params.get('tentative');
  const [form, setForm] = useState<FormState | null>(editing ? null : blank);
  const [reports, setReports] = useState<ReportDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  const [techReport, setTechReport] = useState(true);
  const { portFilter, ports, geo } = useApp();

  const refs = useData(async () => {
    const [drones, facilities, batteries, pilots, packs] = await Promise.all([
      byPort(supabase.from('drones').select('*'), portFilter).order('code'),
      supabase.from('health_facilities').select('*').order('name'),
      supabase.from('v_battery_status').select('*').order('serial_number'),
      supabase.from('pilots').select('*').order('full_name'),
      supabase.from('v_pack_status').select('*').order('pack_number'),
    ]);
    const result = {
      drones: unwrap(drones) as Drone[],
      facilities: unwrap(facilities) as HealthFacility[],
      batteries: unwrap(batteries) as BatteryStatusRow[],
      pilots: unwrap(pilots) as Pilot[],
      packs: unwrap(packs) as PackStatusRow[],
    };
    if (id) {
      const [f, fp] = await Promise.all([
        supabase.from('flights').select('*').eq('id', id).single(),
        supabase.from('flight_pilots').select('*').eq('flight_id', id),
      ]);
      const flight = unwrap(f) as Flight;
      setClosed(flight.status === 'cloture');
      const crew = crewOf(unwrap(fp) as FlightPilot[]);
      const v2 = (v: number | null) => (v == null ? '' : String(v).replace('.', ','));
      setForm({
        drone_id: flight.drone_id, destination_id: flight.destination_id ?? '', flight_date: flight.flight_date,
        flight_type: flight.flight_type, organization: flight.organization, organization_other: flight.organization_other ?? '',
        distance_km: flight.distance_km?.toString() ?? '', cruise_altitude_m: flight.cruise_altitude_m?.toString() ?? '',
        voltage_start_v: v2(flight.voltage_start_v), voltage_end_v: v2(flight.voltage_end_v),
        takeoff_time: flight.takeoff_time.slice(0, 5), drop_time: flight.drop_time?.slice(0, 5) ?? '',
        landing_time: flight.landing_time.slice(0, 5), payload_kg: flight.payload_kg?.toString() ?? '',
        avg_wind_ms: flight.avg_wind_ms?.toString() ?? '', wind_direction_deg: flight.wind_direction_deg?.toString() ?? '',
        consumption_mah: flight.consumption_mah?.toString() ?? '', battery_pack_id: flight.battery_pack_id ?? '',
        battery_1_id: flight.battery_1_id ?? '', battery_2_id: flight.battery_2_id ?? '',
        ...crew, observation: flight.observation ?? '',
        qrf: flight.qrf, qrf_cause: flight.qrf_cause ?? 'meteo', qrf_conditions: flight.qrf_conditions ?? [],
        qrf_time: flight.qrf_time?.slice(0, 5) ?? '', qrf_details: flight.qrf_details ?? '',
        retry_of_flight_id: flight.retry_of_flight_id ?? '',
      });
      return { ...result, retryOf: null as Flight | null };
    }
    if (retryId) {
      // Nouvelle tentative après un QRF : on reprend la mission du vol d'origine
      const [f, fp] = await Promise.all([
        supabase.from('flights').select('*').eq('id', retryId).single(),
        supabase.from('flight_pilots').select('*').eq('flight_id', retryId),
      ]);
      const src = unwrap(f) as Flight;
      const crew = crewOf(unwrap(fp) as FlightPilot[]);
      setForm({
        ...blank,
        drone_id: src.drone_id, flight_type: src.flight_type, organization: src.organization,
        organization_other: src.organization_other ?? '', destination_id: src.destination_id ?? '',
        distance_km: src.distance_km?.toString() ?? '', payload_kg: src.payload_kg?.toString() ?? '',
        cruise_altitude_m: src.cruise_altitude_m?.toString() ?? '',
        flight_date: today(), ...crew,
        retry_of_flight_id: src.id,
      });
      return { ...result, retryOf: src };
    }
    if (result.drones.length === 1) {
      setForm((s) => (s ? { ...s, drone_id: result.drones[0].id } : s));
    }
    return { ...result, retryOf: null as Flight | null };
  }, [id, retryId, portFilter]);

  // Retour de la planification WindPath : brouillon du formulaire + valeurs reportées
  const loc = useLocation();
  const navState = (loc.state ?? null) as FlightNavState | null;
  const [wpApplied, setWpApplied] = useState<string[] | null>(null);
  const appliedRef = useRef(false);
  useEffect(() => {
    if (!refs.data || appliedRef.current || !navState || (!navState.draft && !navState.windpath)) return;
    appliedRef.current = true;
    setForm((s) => {
      const base = (navState.draft as FormState | undefined) ?? s;
      return base ? { ...base, ...(navState.windpath ?? {}) } : s;
    });
    if (navState.windpathLabels?.length) setWpApplied(navState.windpathLabels);
    nav(loc.pathname + loc.search, { replace: true, state: null }); // évite une seconde application au rechargement
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs.data]);

  /** Ouvre WindPath avec le colis, la capacité réelle du pack et la tension de départ du formulaire */
  function openWindpath() {
    if (!form || !refs.data) return;
    const bats = [form.battery_1_id, form.battery_2_id]
      .map((bid) => refs.data!.batteries.find((b) => b.id === bid))
      .filter((b): b is BatteryStatusRow => Boolean(b));
    const capacityMah = bats.length ? bats.reduce((s, b) => s + Number(b.last_measured_mah ?? b.capacity_mah), 0) : null;
    const state: PlanningNavState = {
      prefill: { payloadKg: toNum(form.payload_kg), capacityMah, departureVoltage: toNum(form.voltage_start_v) },
      returnTo: loc.pathname + loc.search,
      draft: form,
      context: editing ? 'modification du vol' : 'nouveau vol',
    };
    nav('/planification', { state });
  }

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((s) => (s ? { ...s, [k]: v } : s));

  // Valeurs calculées & contrôles
  const derived = useMemo(() => {
    if (!form || !refs.data) return null;
    const warnings: string[] = [];
    let duration: number | null = null;
    if (form.takeoff_time && form.landing_time) {
      duration = toMin(form.landing_time) - toMin(form.takeoff_time);
      if (duration < 0) duration += 24 * 60;
      if (duration === 0) warnings.push("L'heure d'atterrissage est égale à l'heure de décollage.");
      if (duration > 4 * 60) warnings.push('Durée de vol supérieure à 4 h : vérifiez les heures saisies.');
    }
    if (form.qrf && form.qrf_time && form.takeoff_time && form.landing_time) {
      const t = toMin(form.takeoff_time), q = toMin(form.qrf_time), l = toMin(form.landing_time);
      const inRange = l >= t ? q >= t && q <= l : q >= t || q <= l;
      if (!inRange) warnings.push("L'heure du demi-tour (QRF) n'est pas comprise entre le décollage et l'atterrissage.");
    }
    if (form.qrf && form.qrf_cause === 'meteo' && !form.qrf_conditions.some(isWeatherCondition))
      warnings.push('QRF météo : indiquez les conditions météo rencontrées.');
    if (form.qrf && form.qrf_cause === 'technique' && !form.qrf_conditions.some(isTechCondition))
      warnings.push('QRF technique : indiquez le problème technique rencontré.');
    if (!form.qrf && form.drop_time && form.takeoff_time && form.landing_time) {
      const t = toMin(form.takeoff_time), d = toMin(form.drop_time), l = toMin(form.landing_time);
      const inRange = l >= t ? d >= t && d <= l : d >= t || d <= l;
      if (!inRange) warnings.push("L'heure de largage n'est pas comprise entre le décollage et l'atterrissage.");
    }
    const b1 = refs.data.batteries.find((b) => b.id === form.battery_1_id);
    const b2 = refs.data.batteries.find((b) => b.id === form.battery_2_id);
    const capacity = (b1?.capacity_mah ?? 0) + (b2?.capacity_mah ?? 0);
    const conso = toNum(form.consumption_mah);
    const consoPct = capacity && conso != null ? (conso / capacity) * 100 : null;
    if (consoPct != null && consoPct > 100) warnings.push('Consommation supérieure à la capacité du pack batteries.');
    if (b1 && b2 && b1.capacity_mah !== b2.capacity_mah) warnings.push('Les deux batteries en parallèle ont des capacités différentes.');
    if (form.battery_pack_id && (!b1 || !b2)) warnings.push("Le pack sélectionné n'a pas ses deux batteries (A et B).");
    for (const b of [b1, b2]) {
      if (!b) continue;
      if (!editing && b.total_cycles + 1 > b.max_cycles) warnings.push(`Batterie ${batteryCode(b)} : cycle max (${b.max_cycles}) dépassé.`);
      else if (b.status !== 'en_service') warnings.push(`Batterie ${batteryCode(b)} n'est pas « en service ».`);
      if (healthLevel(b.health_pct) === 'danger') warnings.push(`Batterie ${batteryCode(b)} : capacité réelle à ${num(b.health_pct)} % de la nominale.`);
    }
    const alt = toNum(form.cruise_altitude_m);
    if (alt != null && (Number.isNaN(alt) || alt < 0 || alt > 6000)) warnings.push("L'altitude de croisière doit être comprise entre 0 et 6 000 m.");
    // AMSL : le point culminant de Madagascar (Maromokotro) est à ~2 876 m
    else if (alt != null && alt > 3500) warnings.push(`Altitude de croisière de ${num(alt, 0)} m AMSL : vérifiez la valeur saisie.`);
    const vs = toNum(form.voltage_start_v), ve = toNum(form.voltage_end_v);
    for (const [v, label] of [[vs, 'de départ'], [ve, "d'arrivée"]] as const) {
      if (v != null && (Number.isNaN(v) || v < 30 || v > 55)) warnings.push(`Tension ${label} hors plage pour un pack 12S (30 à 55 V).`);
    }
    if (vs != null && ve != null && ve > vs) warnings.push("La tension d'arrivée est supérieure à la tension de départ.");
    const cs = cellVolts(vs), ce = cellVolts(ve);
    if (cellLevel(cs, 'start') !== 'ok') warnings.push(`Tension de départ ${nfCell(cs)} V/cellule : pack pas pleinement chargé.`);
    if (cellLevel(ce, 'end') === 'danger') warnings.push(`Tension d'arrivée ${nfCell(ce)} V/cellule : décharge critique.`);
    else if (cellLevel(ce, 'end') === 'warn') warnings.push(`Tension d'arrivée ${nfCell(ce)} V/cellule : décharge profonde.`);
    if (form.organization === 'AUTRE' && !form.organization_other.trim()) warnings.push("Précisez l'organisation (« Autres »).");
    const dir = toNum(form.wind_direction_deg);
    if (dir != null && (dir < 0 || dir > 359 || !Number.isInteger(dir))) warnings.push('La direction du vent doit être un nombre entier de 0 à 359°.');
    const drone = refs.data.drones.find((d) => d.id === form.drone_id);
    if (drone && drone.status !== 'operationnel') warnings.push(`Le drone ${drone.code} n'est pas marqué opérationnel.`);
    if (drone && !drone.drone_port_id) warnings.push(`Le drone ${drone.code} n'est affecté à aucun drone port : le vol ne sera visible que des administrateurs.`);
    return { duration, capacity, consoPct, warnings };
  }, [form, refs.data, editing]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setError(null);
    if (form.pilot_2_id && form.pilot_2_id === form.pilot_1_id) return setError('Les deux pilotes doivent être différents.');
    if (form.trainee_id && (form.trainee_id === form.pilot_1_id || form.trainee_id === form.pilot_2_id)) {
      return setError('Le pilote en formation doit être différent du pilote et du copilote.');
    }
    if (form.battery_1_id && form.battery_1_id === form.battery_2_id) return setError('Les deux batteries doivent être différentes.');
    if (form.flight_type === 'livraison' && !form.destination_id) return setError('Une livraison doit avoir un CSB de destination.');
    if (form.organization === 'AUTRE' && !form.organization_other.trim()) return setError("Précisez l'organisation (« Autres »).");
    const badReport = reports.find((r) => !r.description.trim());
    if (badReport) return setError('Chaque rapport technique doit avoir une description.');

    setBusy(true);
    try {
      const payload = {
        drone_id: form.drone_id,
        destination_id: toStr(form.destination_id),
        flight_type: form.flight_type,
        organization: form.organization,
        organization_other: form.organization === 'AUTRE' ? toStr(form.organization_other) : null,
        distance_km: toNum(form.distance_km),
        cruise_altitude_m: toNum(form.cruise_altitude_m) == null ? null : Math.round(toNum(form.cruise_altitude_m) as number),
        voltage_start_v: toNum(form.voltage_start_v),
        voltage_end_v: toNum(form.voltage_end_v),
        qrf: form.qrf,
        qrf_cause: form.qrf ? form.qrf_cause : null,
        qrf_conditions: form.qrf && form.qrf_conditions.length ? form.qrf_conditions : null,
        qrf_time: form.qrf ? toStr(form.qrf_time) : null,
        qrf_details: form.qrf ? toStr(form.qrf_details) : null,
        retry_of_flight_id: toStr(form.retry_of_flight_id),
        flight_date: form.flight_date,
        takeoff_time: form.takeoff_time,
        drop_time: form.qrf ? null : toStr(form.drop_time),
        landing_time: form.landing_time,
        payload_kg: toNum(form.payload_kg),
        avg_wind_ms: toNum(form.avg_wind_ms),
        wind_direction_deg: toNum(form.wind_direction_deg),
        consumption_mah: toNum(form.consumption_mah),
        battery_pack_id: toStr(form.battery_pack_id),
        battery_1_id: toStr(form.battery_1_id),
        battery_2_id: toStr(form.battery_2_id),
        observation: toStr(form.observation),
      };
      const pilots = [form.pilot_1_id, form.pilot_2_id].filter(Boolean);
      // p_trainee_id envoyé seulement s'il est renseigné (paramètre facultatif de save_flight)
      const flightId = unwrap(await supabase.rpc('save_flight', {
        p_id: id ?? null, p_data: payload, p_pilot_ids: pilots, ...(form.trainee_id ? { p_trainee_id: form.trainee_id } : {}),
      })) as string;
      const toInsert = reports.map((r) => ({ ...draftToPayload(r), flight_id: flightId }));
      // QRF technique : rapport technique ouvert, pré-rempli, pour suivre la mesure corrective
      const techConds = form.qrf ? form.qrf_conditions.filter(isTechCondition) : [];
      if (!editing && techReport && techConds.length) {
        const components = Array.from(new Set(techConds.map((c) => QRF_TECH_COMPONENT[c]).filter(Boolean)));
        toInsert.push({
          ...draftToPayload({
            ...emptyReport(),
            report_type: 'technique',
            severity: 'majeur',
            component: components.length === 1 ? components[0] : '',
            description: `QRF : ${techConds.map((c) => LABELS.qrfConditions[c]).join(', ')}`
              + `${form.qrf_time ? ` (demi-tour à ${form.qrf_time})` : ''}.${form.qrf_details.trim() ? `\n${form.qrf_details.trim()}` : ''}`,
          }),
          flight_id: flightId,
        });
      }
      if (toInsert.length) {
        unwrap(await supabase.from('technical_reports').insert(toInsert));
      }
      nav(`/vols/${flightId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  if (refs.error) return <ErrorBox error={refs.error} />;
  if (!refs.data || !form) return <Loading />;
  if (closed) {
    return (
      <div className="card narrow">
        <h1>Vol clôturé</h1>
        <p>Ce vol est clôturé : ses heures sont inscrites dans le carnet de vol des pilotes et il ne peut plus être modifié.</p>
        <p className="muted">Un administrateur peut le rouvrir depuis la fiche du vol.</p>
        <Link className="btn" to={`/vols/${id}`}>← Retour au vol</Link>
      </div>
    );
  }
  const { drones, facilities, batteries, pilots, packs, retryOf } = refs.data;

  // Les listes suivent le drone port du drone choisi (ou le filtre actif)
  const selectedDrone = drones.find((d) => d.id === form.drone_id);
  const scopePort = selectedDrone ? selectedDrone.drone_port_id : portFilter || null;
  const inScope = (portId: string | null) => !scopePort || portId === scopePort;
  const scopePortName = ports.find((p) => p.id === scopePort)?.name;

  // listes : éléments actifs + élément déjà sélectionné (en édition)
  const facilityOpts = facilities.filter((f) => ((f.active && (!f.drone_port_id || inScope(f.drone_port_id))) || f.id === form.destination_id));
  const pilotOpts = pilots.filter((p) => (p.active && inScope(p.drone_port_id)) || p.id === form.pilot_1_id || p.id === form.pilot_2_id || p.id === form.trainee_id);
  const packOpts = packs.filter((p) => (p.status === 'en_service' && inScope(p.drone_port_id)) || p.id === form.battery_pack_id);
  const droneOpts = drones.filter((d) => d.status !== 'retire' || d.id === form.drone_id);

  const packBatteries = (packId: string) => ({
    a: batteries.find((b) => b.pack_id === packId && b.position === 'A'),
    b: batteries.find((b) => b.pack_id === packId && b.position === 'B'),
  });
  const packLabel = (p: PackStatusRow) => {
    const { a, b } = packBatteries(p.id);
    const part = (x?: BatteryStatusRow) => (x ? `${batteryCode(x)} ${x.total_cycles}/${x.max_cycles}` : '—');
    const lvl = batteryLevel(p.max_cycle_pct ?? 0);
    const flag = lvl === 'danger' || healthLevel(p.min_health_pct) === 'danger' ? ' ⛔' : lvl === 'warn' || healthLevel(p.min_health_pct) === 'warn' ? ' ⚠' : '';
    return `Pack ${p.pack_number} · ${part(a)} · ${part(b)} cycles${p.min_health_pct != null ? ` · santé ${num(p.min_health_pct)} %` : ''}${flag}`;
  };
  const choosePack = (packId: string) => {
    const { a, b } = packBatteries(packId);
    setForm({ ...form, battery_pack_id: packId, battery_1_id: a?.id ?? '', battery_2_id: b?.id ?? '' });
  };
  const selectedCsb = facilities.find((f) => f.id === form.destination_id);
  const b1 = batteries.find((b) => b.id === form.battery_1_id);
  const b2 = batteries.find((b) => b.id === form.battery_2_id);
  const windDeg = toNum(form.wind_direction_deg);

  // ---- complétude des sections et résumé « Plan de vol »
  const needDest = form.flight_type === 'livraison';
  const check = {
    mission: !!(form.drone_id && form.flight_date && form.pilot_1_id && (!needDest || form.destination_id)
      && (form.organization !== 'AUTRE' || form.organization_other.trim())),
    horaires: !!(form.takeoff_time && form.landing_time && (derived?.duration ?? 0) > 0),
    energie: !!(packs.some((p) => p.id === form.battery_pack_id) && form.consumption_mah && form.voltage_start_v && form.voltage_end_v),
  };
  const drone = drones.find((d) => d.id === form.drone_id);
  const pilotName = (pid: string) => pilots.find((p) => p.id === pid)?.full_name;
  const pack = packs.find((p) => p.id === form.battery_pack_id);
  const vStart = toNum(form.voltage_start_v), vEnd = toNum(form.voltage_end_v);
  const cellS = vStart != null && !Number.isNaN(vStart) ? cellVolts(vStart) : null;
  const cellE = vEnd != null && !Number.isNaN(vEnd) ? cellVolts(vEnd) : null;
  const checklist: { label: string; ok: boolean; optional?: boolean }[] = [
    { label: 'Drone et date', ok: !!(form.drone_id && form.flight_date) },
    { label: 'Pilote', ok: !!form.pilot_1_id },
    ...(needDest ? [{ label: 'CSB de destination', ok: !!form.destination_id }] : []),
    { label: 'Décollage et atterrissage', ok: check.horaires },
    ...(form.qrf ? [{ label: 'Cause et conditions du QRF', ok: form.qrf_conditions.length > 0 }] : []),
    { label: 'Pack de batteries', ok: !!pack, optional: true },
    { label: 'Consommation', ok: !!form.consumption_mah, optional: true },
    { label: 'Tensions départ / arrivée', ok: !!(form.voltage_start_v && form.voltage_end_v), optional: true },
  ];
  const required = checklist.filter((c) => !c.optional);
  const requiredOk = required.filter((c) => c.ok).length;
  const warnCount = derived?.warnings.length ?? 0;

  const summary = (
    <aside className="ff-aside">
      <div className="card ff-summary">
        <div className="row-between">
          <span className="ff-kicker">Plan de vol</span>
          <span className={`ff-type ft-${form.qrf ? 'qrf' : form.flight_type}`}>{form.qrf ? 'QRF' : LABELS.flightType[form.flight_type]}</span>
        </div>
        <div className="ff-route">
          <div className="ff-pt"><span>Départ</span><strong>{scopePortName ?? 'Drone port'}</strong></div>
          <div className="ff-path" aria-hidden><span className="ff-plane"><Icon name="drone" size={15} /></span><em>{form.distance_km ? km(toNum(form.distance_km)) : '— km'}</em></div>
          <div className="ff-pt right"><span>{form.qrf ? 'Demi-tour' : 'Destination'}</span><strong>{selectedCsb?.name ?? (needDest ? 'CSB ?' : 'Vol local')}</strong></div>
        </div>
        <dl className="ff-facts">
          <div><dt>Drone</dt><dd>{drone?.code ?? '—'}</dd></div>
          <div><dt>Date</dt><dd>{form.flight_date ? date(form.flight_date) : '—'}</dd></div>
          <div><dt>Pilote</dt><dd>{pilotName(form.pilot_1_id) ?? '—'}</dd></div>
          <div><dt>Copilote</dt><dd>{pilotName(form.pilot_2_id) ?? '—'}</dd></div>
          {form.trainee_id && <div><dt>En formation</dt><dd>{pilotName(form.trainee_id) ?? '—'}</dd></div>}
        </dl>
        <ol className="ff-timeline">
          <li className={form.takeoff_time ? 'on' : ''}><span>Décollage</span><strong>{form.takeoff_time || '--:--'}</strong></li>
          <li className={form.qrf ? (form.qrf_time ? 'on qrf' : 'qrf') : form.drop_time ? 'on' : ''}>
            <span>{form.qrf ? 'Demi-tour' : 'Largage'}</span><strong>{(form.qrf ? form.qrf_time : form.drop_time) || '--:--'}</strong></li>
          <li className={form.landing_time ? 'on' : ''}><span>Atterrissage</span><strong>{form.landing_time || '--:--'}</strong></li>
        </ol>
        <div className="ff-duration"><span>Durée de vol</span><strong>{derived?.duration != null ? minutes(derived.duration) : '—'}</strong></div>
        <div className="ff-energy">
          <PackRing pct={derived?.consoPct ?? null} />
          <div className="ff-energy-txt">
            <span className="ff-kicker">Énergie</span>
            <strong>{form.consumption_mah ? `${num(toNum(form.consumption_mah), 0)} mAh` : '— mAh'}</strong>
            <span className="small muted">{pack ? `Pack ${pack.pack_number}` : 'Aucun pack'}{derived?.capacity ? ` · ${num(derived.capacity, 0)} mAh` : ''}</span>
          </div>
        </div>
        <div className="ff-volts">
          <div className={`ff-volt lvl-${cellLevel(cellS, 'start')}`}><span>Départ</span><strong>{vStart != null && !Number.isNaN(vStart) ? `${num(vStart, 2)} V` : '—'}</strong><em>{cellS != null ? `${num(cellS, 2)} V/cell.` : ''}</em></div>
          <div className={`ff-volt lvl-${cellLevel(cellE, 'end')}`}><span>Arrivée</span><strong>{vEnd != null && !Number.isNaN(vEnd) ? `${num(vEnd, 2)} V` : '—'}</strong><em>{cellE != null ? `${num(cellE, 2)} V/cell.` : ''}</em></div>
        </div>
        <div className="ff-check">
          <div className="row-between small"><strong>Prêt à enregistrer</strong><span className={requiredOk === required.length ? 'text-ok' : 'muted'}>{requiredOk} / {required.length} obligatoires</span></div>
          <div className="ff-progress"><span style={{ width: `${(100 * requiredOk) / required.length}%` }} /></div>
          <ul>
            {checklist.map((c) => (
              <li key={c.label} className={c.ok ? 'ok' : c.optional ? 'opt' : 'todo'}>
                <span aria-hidden>{c.ok ? '✓' : c.optional ? '○' : '•'}</span>{c.label}{c.optional && !c.ok ? <em> · recommandé</em> : null}
              </li>
            ))}
          </ul>
          {warnCount > 0 && <div className="ff-warn">⚠ {warnCount} point(s) à vérifier (en bas du formulaire)</div>}
        </div>
        <button className="btn btn-primary ff-save" disabled={busy}>{busy ? 'Enregistrement…' : editing ? 'Enregistrer les modifications' : 'Enregistrer le vol'}</button>
      </div>
    </aside>
  );

  return (
    <form onSubmit={submit} className="ff-form">
      <PageHeader
        title={editing ? 'Modifier le vol' : retryOf ? 'Nouvelle tentative' : 'Nouveau vol'}
        subtitle="Les champs marqués * sont obligatoires"
        actions={<>
          <Link className="btn" to={editing ? `/vols/${id}` : retryOf ? `/vols/${retryOf.id}` : '/vols'}>Annuler</Link>
          <button type="button" className="btn" onClick={openWindpath}
            title="Calculer vent et énergie dans WindPath avec le colis, le pack et la tension saisis, puis reporter les résultats ici">
            ≋ Préparer avec WindPath
          </button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button>
        </>}
      />

      {wpApplied && (
        <div className="alert alert-info">
          ≋ Valeurs reprises de WindPath : {wpApplied.join(' · ')}. Vérifiez-les avant d'enregistrer.
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setWpApplied(null)} style={{ marginLeft: 8 }}>OK</button>
        </div>
      )}

      {retryOf && (
        <div className="alert alert-info">
          ↻ Nouvelle tentative du vol du <strong>{date(retryOf.flight_date)}</strong> (décollage {time(retryOf.takeoff_time)})
          {retryOf.qrf ? ', interrompu par un QRF' : ''}. Mission, CSB, colis et pilotes ont été repris : vérifiez-les puis saisissez les horaires du nouveau vol.
        </div>
      )}

      {facilityOpts.length === 0 && (
        <div className="alert alert-warn">Aucune formation sanitaire enregistrée. <Link to="/csb">Ajoutez d'abord les CSB de destination.</Link></div>
      )}
      {pilotOpts.length === 0 && (
        <div className="alert alert-warn">Aucun pilote enregistré. <Link to="/pilotes">Ajoutez d'abord les pilotes.</Link></div>
      )}

      <div className="ff-layout">
      <div className="ff-main">
      <section className="card ff-section">
        <SectionHead n="01" icon="flight" title="Mission" sub="Type, drone, destination et équipage" done={check.mission} />
        <div className="type-cards" role="radiogroup" aria-label="Type de vol">
          {(Object.keys(LABELS.flightType) as FlightType[]).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={form.flight_type === t}
              className={`type-card tc-${t}${form.flight_type === t ? ' active' : ''}`} onClick={() => set('flight_type', t)}>
              <span className="tc-icon"><Icon name={t === 'livraison' ? 'box' : 'shield'} size={22} /></span>
              <span className="tc-text"><strong>{LABELS.flightType[t]}</strong>
                <span>{t === 'livraison' ? 'Largage d\'un colis dans un CSB' : 'Vol d\'essai ou de vérification, sans livraison'}</span></span>
              <span className="tc-check" aria-hidden>{form.flight_type === t ? '✓' : ''}</span>
            </button>
          ))}
        </div>
        <div className="form-grid">
          <Field label="Organisation" required>
            <div className="input-group">
              <select value={form.organization} onChange={(e) => set('organization', e.target.value as Organization)}>
                {(Object.keys(LABELS.organization) as Organization[]).map((o) => <option key={o} value={o}>{LABELS.organization[o]}</option>)}
              </select>
              {form.organization === 'AUTRE' && (
                <input required placeholder="Préciser l'organisation" value={form.organization_other}
                  onChange={(e) => set('organization_other', e.target.value)} aria-label="Préciser l'organisation" />
              )}
            </div>
          </Field>
          <Field label="Drone" required>
            <select required value={form.drone_id} onChange={(e) => {
              // changement de drone : on retire les sélections qui n'appartiennent pas à son drone port
              const port = drones.find((d) => d.id === e.target.value)?.drone_port_id ?? null;
              const keep = (p: string | null | undefined) => !port || p === port;
              const keepPack = !form.battery_pack_id || keep(packs.find((p) => p.id === form.battery_pack_id)?.drone_port_id);
              setForm({
                ...form,
                drone_id: e.target.value,
                pilot_1_id: keep(pilots.find((p) => p.id === form.pilot_1_id)?.drone_port_id) ? form.pilot_1_id : '',
                pilot_2_id: keep(pilots.find((p) => p.id === form.pilot_2_id)?.drone_port_id) ? form.pilot_2_id : '',
                trainee_id: keep(pilots.find((p) => p.id === form.trainee_id)?.drone_port_id) ? form.trainee_id : '',
                battery_pack_id: keepPack ? form.battery_pack_id : '',
                battery_1_id: keepPack ? form.battery_1_id : '',
                battery_2_id: keepPack ? form.battery_2_id : '',
              });
            }}>
              <option value="">— Choisir —</option>
              {droneOpts.map((d) => <option key={d.id} value={d.id}>{d.code} ({d.model}){d.drone_port_id ? ` – ${ports.find((p) => p.id === d.drone_port_id)?.name ?? ''}` : ' – non affecté'}</option>)}
            </select>
            {scopePortName && <span className="field-hint">Drone port : {scopePortName}</span>}
          </Field>
          <Field label="Date du vol" required>
            <input type="date" required value={form.flight_date} onChange={(e) => set('flight_date', e.target.value)} />
          </Field>
          <Field label={form.flight_type === 'controle' ? 'Destination (facultative pour un vol de contrôle)' : 'Destination (formation sanitaire)'}
            required={form.flight_type === 'livraison'}>
            <select required={form.flight_type === 'livraison'} value={form.destination_id} onChange={(e) => {
              // la distance du vol reprend celle du CSB choisi (modifiable ensuite)
              const csb = facilities.find((f) => f.id === e.target.value);
              setForm({ ...form, destination_id: e.target.value, distance_km: csb?.distance_km != null ? String(csb.distance_km) : form.distance_km });
            }}>
              <option value="">{form.flight_type === 'controle' ? '— Aucune (vol local) —' : '— Choisir un CSB —'}</option>
              {facilityOpts.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.category} {f.name}{geo.placeText(f.region_id, f.district_id) ? ` – ${geo.placeText(f.region_id, f.district_id)}` : ''}{f.distance_km != null ? ` · ${km(f.distance_km)}` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Distance de vol (km)" hint={selectedCsb?.distance_km != null
            ? `Distance enregistrée pour ce CSB : ${km(selectedCsb.distance_km)}`
            : selectedCsb ? "Aucune distance enregistrée pour ce CSB" : undefined}>
            <input type="number" step="0.1" min="0" inputMode="decimal" value={form.distance_km} onChange={(e) => set('distance_km', e.target.value)} />
          </Field>
          <Field label="Pilote" required>
            <select required value={form.pilot_1_id} onChange={(e) => set('pilot_1_id', e.target.value)}>
              <option value="">— Choisir —</option>
              {pilotOpts.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
            </select>
          </Field>
          <Field label="Second pilote" hint="Optionnel : copilote">
            <select value={form.pilot_2_id} onChange={(e) => set('pilot_2_id', e.target.value)}>
              <option value="">— Aucun —</option>
              {pilotOpts.filter((p) => p.id !== form.pilot_1_id && p.id !== form.trainee_id).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
            </select>
          </Field>
          <Field label="Pilote en formation" hint="Optionnel : session d'apprentissage. Heures inscrites à part dans son carnet, pas de visa CRM">
            <select value={form.trainee_id} onChange={(e) => set('trainee_id', e.target.value)}>
              <option value="">— Aucun —</option>
              {pilotOpts.filter((p) => p.id !== form.pilot_1_id && p.id !== form.pilot_2_id).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
            </select>
          </Field>
        </div>
      </section>

      <section className="card ff-section">
        <SectionHead n="02" icon="clock" title="Horaires" sub="Heure locale de Madagascar" done={check.horaires} />
        <div className="form-grid form-grid-4">
          <Field label="Décollage" required>
            <input type="time" required value={form.takeoff_time} onChange={(e) => set('takeoff_time', e.target.value)} />
          </Field>
          <Field label="Largage" hint={form.qrf ? 'Pas de largage : QRF' : undefined}>
            <input type="time" value={form.qrf ? '' : form.drop_time} disabled={form.qrf} onChange={(e) => set('drop_time', e.target.value)} />
          </Field>
          <Field label="Atterrissage" required>
            <input type="time" required value={form.landing_time} onChange={(e) => set('landing_time', e.target.value)} />
          </Field>
          <div className="computed">
            <span className="field-label">Durée de vol</span>
            <strong>{derived?.duration != null ? minutes(derived.duration) : '—'}</strong>
          </div>
        </div>
      </section>

      <section className={`card ff-section${form.qrf ? ' card-qrf' : ''}`}>
        <SectionHead n="03" icon="wind" title="Retour anticipé (QRF)" sub="Uniquement si le drone a fait demi-tour avant le largage" />
        <label className="check qrf-toggle">
          <input type="checkbox" checked={form.qrf} onChange={(e) => set('qrf', e.target.checked)} />
          <span>
            <strong>QRF : retour au drone port avant largage</strong>
            <span className="field-hint"> · à cocher si le drone a fait demi-tour en route (météo dégradée, problème technique…)</span>
          </span>
        </label>
        {form.qrf && (
          <div className="form-grid form-grid-4">
            <Field label="Cause du QRF" required>
              <select value={form.qrf_cause} onChange={(e) => set('qrf_cause', e.target.value as QrfCause)}>
                {(Object.keys(LABELS.qrfCause) as QrfCause[]).map((c) => <option key={c} value={c}>{LABELS.qrfCause[c]}</option>)}
              </select>
            </Field>
            <Field label="Heure du demi-tour" hint="Moment où le retour a été décidé">
              <input type="time" value={form.qrf_time} onChange={(e) => set('qrf_time', e.target.value)} />
            </Field>
            <div className="field field-wide">
              <span className="field-label">Conditions rencontrées <span className="field-hint">(plusieurs choix possibles, météo et technique)</span></span>
              {/* le groupe correspondant à la cause est affiché en premier */}
              {[...QRF_CONDITION_GROUPS].sort((a, b) => Number(b.key === form.qrf_cause) - Number(a.key === form.qrf_cause)).map((g) => (
                <div key={g.key} className="chip-group">
                  <span className="chip-group-label">{g.label}</span>
                  <div className="chips">
                    {g.items.map((c) => {
                      const on = form.qrf_conditions.includes(c);
                      return (
                        <button key={c} type="button" className={`chip${on ? ' active' : ''}${g.key === 'technique' ? ' chip-tech' : ''}`} aria-pressed={on}
                          onClick={() => setForm((s) => (s ? {
                            ...s,
                            qrf_conditions: s.qrf_conditions.includes(c) ? s.qrf_conditions.filter((x) => x !== c) : [...s.qrf_conditions, c],
                          } : s))}>
                          {on ? '✓ ' : ''}{LABELS.qrfConditions[c]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            {!editing && form.qrf_conditions.some(isTechCondition) && (
              <label className="check field-wide">
                <input type="checkbox" checked={techReport} onChange={(e) => setTechReport(e.target.checked)} />
                <span>Créer aussi un <strong>rapport technique</strong> (ouvert, gravité majeure) pour suivre la mesure corrective</span>
              </label>
            )}
            <Field label="Détails" wide hint="Position approximative du demi-tour, observations du pilote, décision prise…">
              <textarea rows={2} value={form.qrf_details} onChange={(e) => set('qrf_details', e.target.value)} />
            </Field>
            <p className="muted small field-wide">
              Le colis n'est pas livré (pas d'heure de largage). Les heures de vol, les cycles batteries et le carnet de vol sont quand même comptés.
              Après l'enregistrement, vous pourrez créer une <strong>nouvelle tentative</strong> depuis la fiche du vol.
            </p>
          </div>
        )}
      </section>

      <section className="card ff-section">
        <SectionHead n="04" icon="bolt" title="Charge, météo & énergie" sub="Recommandé : pack, consommation et tensions" done={check.energie} />
        <div className="form-grid form-grid-4">
          <Field label="Poids du colis (kg)">
            <input type="number" step="0.01" min="0" inputMode="decimal" value={form.payload_kg} onChange={(e) => set('payload_kg', e.target.value)} />
          </Field>
          <Field label="Altitude de croisière (m AMSL)" hint="Au-dessus du niveau moyen de la mer">
            <input type="number" step="1" min="0" max="6000" inputMode="numeric" value={form.cruise_altitude_m}
              onChange={(e) => set('cruise_altitude_m', e.target.value)} placeholder="ex. 1450" />
          </Field>
          <Field label="Vent moyen en vol (m/s)">
            <input type="number" step="0.1" min="0" inputMode="decimal" value={form.avg_wind_ms} onChange={(e) => set('avg_wind_ms', e.target.value)} />
          </Field>
          <Field label="Direction moyenne du vent (°)" hint={windDeg != null ? `Vent du ${cardinal(windDeg)} (provenance)` : "D'où vient le vent : 0 = Nord, 90 = Est"}>
            <div className="input-group">
              <input type="number" step="1" min="0" max="359" inputMode="numeric" value={form.wind_direction_deg}
                onChange={(e) => set('wind_direction_deg', e.target.value)} placeholder="0–359" />
              <select aria-label="Direction cardinale" value={windDeg != null ? cardinal(windDeg) : ''}
                onChange={(e) => {
                  const pt = COMPASS_POINTS.find((c) => c.label === e.target.value);
                  set('wind_direction_deg', pt ? String(pt.deg) : '');
                }}>
                <option value="">—</option>
                {COMPASS_POINTS.map((c) => <option key={c.label} value={c.label}>{c.label}</option>)}
              </select>
            </div>
          </Field>
          <Field label="Consommation (mAh)">
            <input type="number" step="1" min="0" inputMode="numeric" value={form.consumption_mah} onChange={(e) => set('consumption_mah', e.target.value)} />
          </Field>
          <Field label="Pack de batteries" wide hint="Tattu 12S – les batteries A et B du pack sont montées en parallèle">
            <select value={form.battery_pack_id} onChange={(e) => choosePack(e.target.value)}>
              <option value="">— Choisir un pack —</option>
              {packOpts.map((p) => <option key={p.id} value={p.id}>{packLabel(p)}</option>)}
            </select>
          </Field>
          <div className="computed">
            <span className="field-label">Batteries</span>
            <strong>{b1 || b2 ? `${b1 ? batteryCode(b1) : '—'} + ${b2 ? batteryCode(b2) : '—'}` : '—'}</strong>
            {!form.battery_pack_id && (b1 || b2) && <span className="field-hint">Saisie antérieure sans pack</span>}
          </div>
          <div className="computed">
            <span className="field-label">% du pack</span>
            <strong>{derived?.consoPct != null ? `${num(derived.consoPct)} %` : '—'}</strong>
            {derived?.capacity ? <span className="field-hint">Capacité nominale : {num(derived.capacity, 0)} mAh</span> : null}
          </div>
          <VoltageField label="Tension de départ" kind="start" value={form.voltage_start_v} onChange={(v) => set('voltage_start_v', v)} />
          <VoltageField label="Tension d'arrivée" kind="end" value={form.voltage_end_v} onChange={(v) => set('voltage_end_v', v)} />
        </div>
      </section>

      <section className="card ff-section">
        <SectionHead n="05" icon="book" title="Observation" />
        <Field label="Observation simple" wide hint="Remarques générales sur le vol (sans caractère technique)">
          <textarea rows={3} value={form.observation} onChange={(e) => set('observation', e.target.value)} />
        </Field>
      </section>

      {!editing && (
        <section className="card ff-section">
          <SectionHead n="06" icon="alert" title="Rapports techniques / incidents" sub="En cas de problème technique ou d'incident"
            right={<button type="button" className="btn btn-sm" onClick={() => setReports([...reports, emptyReport()])}>+ Ajouter un rapport</button>} />
          {reports.length === 0 && <p className="muted small">Aucun rapport pour ce vol. Ajoutez-en un en cas de problème technique ou d'incident.</p>}
          {reports.map((r, i) => (
            <div key={i} className="subcard">
              <div className="row-between">
                <strong>Rapport {i + 1}</strong>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReports(reports.filter((_, j) => j !== i))}>Retirer</button>
              </div>
              <ReportFields value={r} onChange={(v) => setReports(reports.map((x, j) => (j === i ? v : x)))} />
            </div>
          ))}
        </section>
      )}

      {derived && derived.warnings.length > 0 && (
        <div className="alert alert-warn">
          <strong>Points à vérifier :</strong>
          <ul>{derived.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      )}
      <ErrorBox error={error} />
      <div className="form-actions">
        <Link className="btn" to={editing ? `/vols/${id}` : '/vols'}>Annuler</Link>
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer le vol'}</button>
      </div>
      <p className="muted small right">Le vol est enregistré au statut « ouvert ». Clôturez-le depuis sa fiche pour inscrire les heures au carnet de vol des pilotes.</p>
      </div>
      {summary}
      </div>
    </form>
  );
}
