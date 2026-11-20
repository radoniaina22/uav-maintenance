import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { byPort, useApp } from '../lib/app';
import { POTENTIAL_WARN_PCT } from '../lib/parts';
import { useData } from '../lib/useData';
import { useCrmTasks } from '../lib/crmTasks';
import type { BatteryStatusRow, DroneStatusRow, FlightRow, PackStatusRow, ReportRow } from '../lib/types';
import { batteryCode, batteryLevel, healthLevel, date, hours, LABELS, minutes, num, time, visitLevel } from '../lib/format';
import { addDays, iso } from '../lib/stats';
import {
  droneReadiness, FORECAST_WINDOW_DAYS, MountedPart, projection, READINESS_LABEL, READINESS_LEVEL, Readiness,
} from '../lib/dashboard';
import { Badge, Empty, ErrorBox, FlightStatusBadge, Loading, PageHeader, Progress } from '../components/ui';
import { ActionCenter, ActionItem, ActivityFeed, FeedItem, TabbedCard, TrendTile, WeatherPanel } from '../components/DashboardWidgets';
import DeliveryMap, { MapFacility } from '../components/DeliveryMap';
import { fmt } from '../components/charts';
import { milestoneProgress } from '../lib/milestones';

type F60 = Pick<FlightRow, 'id' | 'flight_date' | 'duration_min' | 'drone_id' | 'drone_port_id' | 'drone_port_name' | 'qrf' | 'qrf_cause' | 'flight_type' |
  'payload_kg' | 'distance_km' | 'destination_id' | 'status' | 'battery_1_id' | 'battery_2_id' | 'avg_wind_ms'>;
interface Facility { id: string; name: string; latitude: number | null; longitude: number | null; distance_km: number | null; drone_port_id: string | null }
interface RankLite { pilot_id: string; minutes: number; career_hours: number; flights: number; active: boolean }

const PALETTE = { liv: 'var(--series-1)', qrf: 'var(--series-2)', ctl: 'var(--series-3)' };

/** Tableau de bord */
export default function Dashboard() {
  const { portFilter, ports, pilot, session, isAdmin } = useApp();
  const crm = useCrmTasks();
  const firstName = (pilot?.full_name ?? session.user.email ?? '').split(/[\s@]/)[0];
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Indian/Antananarivo', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).find((p) => p.type === 'hour')?.value ?? 12);
  const greeting = hour < 5 || hour >= 18 ? 'Bonsoir' : 'Bonjour';

  const { data, error, loading } = useData(async () => {
    const todayIso = iso(new Date());
    const from60 = addDays(todayIso, -59);
    const yearStart = `${todayIso.slice(0, 4)}-01-01`, monthStart = `${todayIso.slice(0, 8)}01`;
    const [drones, batteries, packs, reports, recent, flights, open, parts, thresholds, facilities, feed, rankYear, rankMonth] = await Promise.all([
      byPort(supabase.from('v_drone_status').select('*'), portFilter).order('code'),
      byPort(supabase.from('v_battery_status').select('*'), portFilter).neq('status', 'hors_service').order('cycle_pct', { ascending: false }),
      byPort(supabase.from('v_pack_status').select('*'), portFilter),
      byPort(supabase.from('v_reports').select('*'), portFilter).neq('status', 'clos').order('created_at', { ascending: false }),
      byPort(supabase.from('v_flights').select('*'), portFilter).order('flight_date', { ascending: false }).order('takeoff_time', { ascending: false }).limit(8),
      byPort(supabase.from('v_flights').select('id, flight_date, duration_min, drone_id, drone_port_id, drone_port_name, qrf, qrf_cause, flight_type, payload_kg, distance_km, destination_id, status, battery_1_id, battery_2_id, avg_wind_ms'), portFilter)
        .gte('flight_date', from60).limit(5000),
      byPort(supabase.from('v_flights').select('id', { count: 'exact', head: true }), portFilter).eq('status', 'ouvert'),
      byPort(supabase.from('v_parts').select('id, code, status, drone_id, potential_pct, max_hours_effective, total_hours, type_name, type_code, drone_port_id'), portFilter).neq('status', 'rebut'),
      byPort(supabase.from('part_stock_thresholds').select('*'), portFilter),
      supabase.from('health_facilities').select('id, name, latitude, longitude, distance_km, drone_port_id').eq('active', true),
      supabase.rpc('activity_feed', { p_port: portFilter || null, p_limit: 30 }),
      pilot ? supabase.rpc('pilot_ranking', { p_from: yearStart, p_to: todayIso }) : Promise.resolve({ data: [], error: null }),
      pilot ? supabase.rpc('pilot_ranking', { p_from: monthStart, p_to: todayIso }) : Promise.resolve({ data: [], error: null }),
    ]);
    return {
      drones: unwrap(drones) as DroneStatusRow[],
      batteries: unwrap(batteries) as BatteryStatusRow[],
      packs: unwrap(packs) as PackStatusRow[],
      reports: unwrap(reports) as ReportRow[],
      recent: unwrap(recent) as FlightRow[],
      flights: unwrap(flights) as F60[],
      openFlights: open.count ?? 0,
      parts: unwrap(parts) as (MountedPart & { status: string; type_code: string; drone_port_id: string | null })[],
      thresholds: unwrap(thresholds) as { drone_port_id: string; type_code: string; min_qty: number }[],
      facilities: unwrap(facilities) as Facility[],
      feed: unwrap(feed) as FeedItem[],
      rankYear: (unwrap(rankYear) ?? []) as RankLite[],
      rankMonth: (unwrap(rankMonth) ?? []) as RankLite[],
    };
  }, [portFilter, pilot?.id]);

  const view = useMemo(() => {
    if (!data) return null;
    const todayIso = iso(new Date());
    const from30 = addDays(todayIso, -29), from60 = addDays(todayIso, -59);
    const cur = data.flights.filter((f) => f.flight_date >= from30);
    const prev = data.flights.filter((f) => f.flight_date < from30 && f.flight_date >= from60);
    const delivered = (fs: F60[]) => fs.filter((f) => f.flight_type === 'livraison' && !f.qrf);
    const hrs = (fs: F60[]) => fs.reduce((s, f) => s + Number(f.duration_min), 0) / 60;
    const qrfRate = (fs: F60[]) => (fs.length ? (100 * fs.filter((f) => f.qrf).length) / fs.length : null);
    const days = Array.from({ length: 30 }, (_, i) => addDays(from30, i));
    const perDay = (fn: (fs: F60[]) => number) => days.map((d) => fn(cur.filter((f) => f.flight_date === d)));

    // ---- disponibilité
    const mounted = data.parts.filter((p) => p.status === 'monte');
    const ready = data.drones.filter((d) => d.status !== 'retire').map((d) => ({ d, ...droneReadiness(d, { parts: mounted, reports: data.reports, packs: data.packs }) }));
    const count = (s: Readiness) => ready.filter((r) => r.state === s).length;

    // ---- prévisions de maintenance (rythme des 30 derniers jours)
    const droneRate = new Map<string, number>();
    for (const f of cur) droneRate.set(f.drone_id, (droneRate.get(f.drone_id) ?? 0) + Number(f.duration_min) / 60 / FORECAST_WINDOW_DAYS);
    const batRate = new Map<string, number>();
    for (const f of cur) for (const b of [f.battery_1_id, f.battery_2_id]) if (b) batRate.set(b, (batRate.get(b) ?? 0) + 1 / FORECAST_WINDOW_DAYS);
    const forecast: { key: string; title: string; sub: string; days: number; date: string; level: 'ok' | 'warn' | 'danger'; to: string }[] = [];
    let idle = 0;
    for (const d of data.drones.filter((x) => x.status !== 'retire')) {
      const p = projection(Number(d.hours_to_next_visit), droneRate.get(d.id) ?? 0);
      if (!p) { idle++; continue; }
      forecast.push({ key: `v${d.id}`, title: `${d.code} · visite ${num(d.visit_interval_hours, 0)} h`, sub: `à ${hours(d.next_visit_hours)} · reste ${hours(Math.max(0, d.hours_to_next_visit))}`,
        ...p, level: visitLevel(d.hours_to_next_visit), to: `/drones/${d.id}` });
    }
    for (const b of data.batteries) {
      const p = projection(Number(b.max_cycles) - Number(b.total_cycles), batRate.get(b.id) ?? 0);
      if (!p) continue;
      forecast.push({ key: `b${b.id}`, title: `Batterie ${batteryCode(b)} · ${b.max_cycles} cycles`, sub: `${b.total_cycles} / ${b.max_cycles} cycles`,
        ...p, level: batteryLevel(Number(b.cycle_pct)), to: `/batteries/${b.id}` });
    }
    for (const pt of mounted.filter((x) => x.max_hours_effective != null && x.drone_id)) {
      const p = projection(Number(pt.max_hours_effective) - Number(pt.total_hours), droneRate.get(pt.drone_id!) ?? 0);
      if (!p) continue;
      const pct = Number(pt.potential_pct ?? 0);
      forecast.push({ key: `p${pt.id}`, title: `${pt.code} · ${pt.type_name}`, sub: `${hours(pt.total_hours)} / ${hours(pt.max_hours_effective)}`,
        ...p, level: pct >= 100 ? 'danger' : pct >= POTENTIAL_WARN_PCT ? 'warn' : 'ok', to: `/pieces/${pt.id}` });
    }
    forecast.sort((a, b) => a.days - b.days);
    // au-delà d'un an, l'estimation n'a pas de sens opérationnel
    const farCount = forecast.filter((f) => f.days > 365).length;
    const near = forecast.filter((f) => f.days <= 365);

    // ---- carte : livraisons réussies des 30 derniers jours par CSB
    const byDest = new Map<string, { n: number; kg: number; last: string }>();
    for (const f of delivered(cur)) {
      if (!f.destination_id) continue;
      const x = byDest.get(f.destination_id) ?? { n: 0, kg: 0, last: f.flight_date };
      x.n++; x.kg += Number(f.payload_kg ?? 0); if (f.flight_date > x.last) x.last = f.flight_date;
      byDest.set(f.destination_id, x);
    }
    const facilities: MapFacility[] = data.facilities.filter((h) => !portFilter || !h.drone_port_id || h.drone_port_id === portFilter)
      .map((h) => ({ ...h, deliveries: byDest.get(h.id)?.n ?? 0, kg: byDest.get(h.id)?.kg ?? 0, last: byDest.get(h.id)?.last ?? null }));

    // ---- stock sous le minimum
    const lowStock = data.thresholds.filter((t) => t.min_qty > 0 &&
      data.parts.filter((p) => p.status === 'stock' && p.type_code === t.type_code && p.drone_port_id === t.drone_port_id).length < t.min_qty).length;

    // ---- QRF météo : vent moyen
    const qm = data.flights.filter((f) => f.qrf && f.qrf_cause === 'meteo' && f.avg_wind_ms != null);
    const qrfWind = qm.length ? qm.reduce((s, f) => s + Number(f.avg_wind_ms), 0) / qm.length : null;

    // ---- comparaison des drone ports (administrateur, tous les ports)
    const portRows = ports.map((p) => {
      const fs = cur.filter((f) => f.drone_port_id === p.id);
      const r = ready.filter((x) => x.d.drone_port_id === p.id);
      return { id: p.id, name: p.name, ready: r.filter((x) => x.state === 'pret').length, drones: r.length, flights: fs.length,
        delivered: delivered(fs).length, hours: hrs(fs), qrf: qrfRate(fs), reports: data.reports.filter((x) => x.drone_port_id === p.id).length };
    });

    return {
      cur, prev, ready, readyCount: { pret: count('pret'), reserve: count('reserve'), indisponible: count('indisponible') },
      trends: {
        flights: { cur: cur.length, prev: prev.length, series: perDay((fs) => fs.length) },
        delivered: { cur: delivered(cur).length, prev: delivered(prev).length, series: perDay((fs) => delivered(fs).length) },
        hours: { cur: hrs(cur), prev: hrs(prev), series: perDay(hrs) },
        qrf: { cur: qrfRate(cur), prev: qrfRate(prev), series: perDay((fs) => fs.filter((f) => f.qrf).length) },
        kg: delivered(cur).reduce((s, f) => s + Number(f.payload_kg ?? 0), 0),
      },
      forecast: near, farCount, idle, facilities, lowStock, qrfWind, portRows, mounted,
    };
  }, [data, ports, portFilter]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data || !view) return null;

  const { drones, batteries, reports, recent, openFlights } = data;
  const portName = ports.find((p) => p.id === portFilter)?.name;
  const shownPorts = portFilter ? ports.filter((p) => p.id === portFilter) : ports;
  const mounted = view.mounted;
  const partsOver = mounted.filter((p) => Number(p.potential_pct) >= 100).length;
  const partsNear = mounted.filter((p) => Number(p.potential_pct) >= POTENTIAL_WARN_PCT && Number(p.potential_pct) < 100).length;
  const quarantine = data.parts.filter((p) => p.status === 'quarantaine').length;
  const visitsOver = drones.filter((d) => d.status !== 'retire' && d.hours_to_next_visit <= 0).length;
  const visitsSoon = drones.filter((d) => d.status !== 'retire' && visitLevel(d.hours_to_next_visit) === 'warn').length;
  const batOver = batteries.filter((b) => batteryLevel(Number(b.cycle_pct)) === 'danger').length;
  const batNear = batteries.filter((b) => batteryLevel(Number(b.cycle_pct)) === 'warn' || healthLevel(b.health_pct) !== 'ok').length;
  const crmVisas = crm.tasks.filter((t) => t.kind === 'pilote' || t.kind === 'copilote').length;
  const crmCorrective = crm.tasks.filter((t) => t.kind === 'rapports' && t.open_reports === 0).length;
  const crmFollow = crm.tasks.filter((t) => t.kind === 'suivi').length;
  const firstVisa = crm.tasks.find((t) => t.kind === 'pilote' || t.kind === 'copilote');
  const firstCorrective = crm.tasks.find((t) => t.kind === 'rapports' && t.open_reports === 0);

  const actions: ActionItem[] = [
    { key: 'unav', level: 'danger', icon: 'drone', count: view.readyCount.indisponible, label: 'drone(s) indisponible(s)', to: '/drones' },
    { key: 'vo', level: 'danger', icon: 'wrench', count: visitsOver, label: 'visite(s) 250 h dépassée(s)', to: '/drones' },
    { key: 'po', level: 'danger', icon: 'chip', count: partsOver, label: 'pièce(s) au potentiel dépassé', to: '/pieces?onglet=synthese' },
    { key: 'bo', level: 'danger', icon: 'battery', count: batOver, label: 'batterie(s) à 500 cycles', to: '/batteries' },
    { key: 'crm', level: 'warn', icon: 'pen', count: crmVisas, label: 'CRM à signer', to: firstVisa ? `/vols/${firstVisa.flight_id}/crm` : '/vols' },
    { key: 'cor', level: 'warn', icon: 'shield', count: crmCorrective, label: 'visa(s) « mesures correctives » à signer', to: firstCorrective ? `/vols/${firstCorrective.flight_id}/crm` : '/rapports' },
    { key: 'rep', level: 'warn', icon: 'alert', count: reports.length, label: 'rapport(s) technique(s) / incident(s) ouvert(s)', to: '/rapports' },
    { key: 'fol', level: 'info', icon: 'bell', count: isAdmin ? crmFollow : 0, label: 'vol(s) avec comptes rendus à suivre', to: '/rapports' },
    { key: 'open', level: 'warn', icon: 'book', count: openFlights, label: 'vol(s) à clôturer', to: '/vols?statut=ouvert' },
    { key: 'vs', level: 'warn', icon: 'wrench', count: visitsSoon, label: 'visite(s) 250 h à prévoir', to: '/drones' },
    { key: 'pn', level: 'warn', icon: 'chip', count: partsNear, label: `pièce(s) à ≥ ${POTENTIAL_WARN_PCT} % du potentiel`, to: '/pieces?onglet=synthese' },
    { key: 'q', level: 'warn', icon: 'box', count: quarantine, label: 'pièce(s) en quarantaine', to: '/pieces?onglet=quarantaine' },
    { key: 'st', level: 'warn', icon: 'box', count: view.lowStock, label: 'type(s) de pièce sous le stock minimum', to: '/pieces?onglet=stock' },
    { key: 'bn', level: 'warn', icon: 'battery', count: batNear, label: 'batterie(s) à surveiller (cycles ou santé)', to: '/batteries' },
  ];

  const t = view.trends;
  const me = pilot && data.rankYear.find((r) => r.pilot_id === pilot.id);
  const meMonth = pilot && data.rankMonth.find((r) => r.pilot_id === pilot.id);
  const yearRanked = data.rankYear.filter((r) => r.active && Number(r.minutes) > 0).sort((a, b) => Number(b.minutes) - Number(a.minutes));
  const myRank = me && Number(me.minutes) > 0 ? yearRanked.findIndex((r) => r.pilot_id === pilot!.id) + 1 : null;
  const career = me ? Number(me.career_hours) : null;
  const ms = career != null ? milestoneProgress(career) : null;

  // ------------------------------------------------------------------
  const readiness = (
    <section className="card readiness-card" id="flotte">
      <div className="row-between">
        <h2 className="card-title">Disponibilité de la flotte</h2>
        <div className="ready-summary">
          <strong className={`text-${view.readyCount.indisponible ? 'danger' : view.readyCount.reserve ? 'warn' : 'ok'}`}>
            {view.readyCount.pret} / {view.ready.length}
          </strong> <span className="muted small">prêt(s) à voler</span>
        </div>
      </div>
      {view.ready.length === 0 ? <Empty>Aucun drone dans ce périmètre.</Empty> : (
        <div className="ready-grid">
          {view.ready.map(({ d, state, reasons }) => {
            const lvl = visitLevel(d.hours_to_next_visit);
            return (
              <Link key={d.id} to={`/drones/${d.id}`} className={`ready-drone ready-${state}`}>
                <div className="row-between">
                  <div>
                    <div className="drone-code">{d.code}</div>
                    <div className="small muted">{d.drone_port_name ?? 'Non affecté'} · {hours(d.total_hours)} · {num(d.flight_count, 0)} vols</div>
                  </div>
                  <Badge level={READINESS_LEVEL[state]}>{READINESS_LABEL[state]}</Badge>
                </div>
                <div className="small row-between">
                  <span className="muted">Visite {num(d.visit_interval_hours, 0)} h</span>
                  <strong className={`text-${lvl}`}>{d.hours_to_next_visit <= 0 ? `dépassée de ${hours(-d.hours_to_next_visit)}` : `reste ${hours(d.hours_to_next_visit)}`}</strong>
                </div>
                <Progress value={d.visit_interval_hours - d.hours_to_next_visit} max={d.visit_interval_hours} level={lvl} />
                {reasons.length > 0 ? (
                  <ul className="ready-reasons">{reasons.map((r) => <li key={r}>{r}</li>)}</ul>
                ) : <div className="small text-ok">✓ Aucune restriction</div>}
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );

  const trends = (
    <div className="stats trend-stats">
      <TrendTile label="Vols · 30 jours" value={String(t.flights.cur)} cur={t.flights.cur} prev={t.flights.prev} series={t.flights.series} />
      <TrendTile label="Livraisons réussies" value={String(t.delivered.cur)} cur={t.delivered.cur} prev={t.delivered.prev} series={t.delivered.series}
        sub={`${fmt(t.kg)} kg livrés`} />
      <TrendTile label="Heures de vol" value={fmt(t.hours.cur)} unit="h" cur={t.hours.cur} prev={t.hours.prev} series={t.hours.series} />
      <TrendTile label="Taux de QRF" value={t.qrf.cur != null ? fmt(t.qrf.cur) : '—'} unit={t.qrf.cur != null ? '%' : undefined}
        cur={t.qrf.cur} prev={t.qrf.prev} series={t.qrf.series} goodWhenUp={false} pts color={PALETTE.qrf} />
    </div>
  );

  const map = (
    <section className="card map-card">
      <div className="row-between">
        <h2 className="card-title">Livraisons · 30 derniers jours</h2>
        <span className="small muted">{view.facilities.filter((f) => f.deliveries > 0).length} CSB desservi(s) · {view.facilities.filter((f) => f.deliveries === 0).length} sans livraison</span>
      </div>
      <DeliveryMap ports={shownPorts} facilities={view.facilities} fill />
      <div className="map-legend small muted">
        <span><i className="dot dot-served" /> CSB desservi (taille = livraisons)</span>
        <span><i className="dot dot-idle" /> CSB sans livraison depuis 30 jours</span>
        <span><i className="dot-base" />Drone port</span>
      </div>
    </section>
  );

  const forecast = (
    <>
      {view.forecast.length === 0 ? (
        <div className="muted small">Aucune échéance prévue dans les 12 prochains mois au rythme actuel.</div>
      ) : (
        <ul className="forecast">
          {view.forecast.slice(0, 5).map((f) => (
            <li key={f.key}>
              <Link to={f.to} className="forecast-item">
                <span className={`forecast-days level-${f.days <= 7 || f.level === 'danger' ? 'danger' : f.days <= 30 || f.level === 'warn' ? 'warn' : 'ok'}`}>
                  {f.days === 0 ? 'Échu' : <>J-{f.days}</>}
                </span>
                <span className="forecast-body"><strong>{f.title}</strong><span className="small muted">{f.sub}</span></span>
                <span className="small">{f.days === 0 ? 'maintenant' : `vers le ${date(f.date)}`}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="small muted tabbed-foot">
        Estimé au rythme des {FORECAST_WINDOW_DAYS} derniers jours.
        {view.forecast.length > 5 ? ` ${view.forecast.length - 5} autre(s) échéance(s) dans l'année.` : ''}
        {view.farCount > 0 ? ` ${view.farCount} au-delà d'un an.` : ''}
        {view.idle > 0 ? ` ${view.idle} drone(s) sans vol depuis 30 jours : pas d'estimation.` : ''}
      </div>
    </>
  );

  const reportsList = reports.length === 0 ? <Empty>Aucun rapport ouvert. 👍</Empty> : (
    <div className="list">
      {reports.slice(0, 5).map((r) => (
        <Link key={r.id} to={`/vols/${r.flight_id}`} className="list-item list-link">
          <div className="row-between small">
            <span>
              <Badge level={r.report_type === 'incident' ? 'danger' : 'info'}>{LABELS.reportType[r.report_type]}</Badge>{' '}
              <strong>{r.drone_code}</strong> · {date(r.flight_date)}
            </span>
            <Badge level={r.severity === 'critique' ? 'danger' : r.severity === 'majeur' ? 'warn' : 'neutral'}>{LABELS.severity[r.severity]}</Badge>
          </div>
          <div className="small ellipsis">{r.component ? `[${r.component}] ` : ''}{r.description}</div>
        </Link>
      ))}
    </div>
  );

  const batteryList = batteries.length === 0 ? <Empty>Aucune batterie enregistrée.</Empty> : (
    <div className="list">
      {batteries.slice(0, 5).map((b) => {
        const lvl = batteryLevel(b.cycle_pct);
        return (
          <div key={b.id} className="list-item">
            <div className="row-between small">
              <span><Link to={`/batteries/${b.id}`}><strong>{batteryCode(b)}</strong></Link>
                {b.health_pct != null && <span className={`text-${healthLevel(b.health_pct)}`}> · santé {num(b.health_pct)} %</span>}</span>
              <span className={`text-${lvl}`}>{b.total_cycles} / {b.max_cycles} cycles</span>
            </div>
            <Progress value={b.total_cycles} max={b.max_cycles} level={lvl} />
          </div>
        );
      })}
    </div>
  );
  const soonCount = view.forecast.filter((f) => f.days <= 30).length;

  const rolePanel = isAdmin && !portFilter ? (
    <section className="card">
      <h2 className="card-title">Comparaison des drone ports · 30 jours</h2>
      <div className="table-wrap">
        <table className="compact-table">
          <thead><tr><th>Drone port</th><th className="num">Prêts</th><th className="num">Vols</th><th className="num">Heures</th><th className="num">QRF</th><th className="num" title="Rapports ouverts">Rapp.</th></tr></thead>
          <tbody>
            {view.portRows.map((p) => (
              <tr key={p.id}>
                <td><strong>{p.name}</strong><div className="small muted">{p.delivered} livraison(s)</div></td>
                <td className="num"><span className={p.drones && p.ready < p.drones ? 'text-warn' : ''}>{p.ready} / {p.drones}</span></td>
                <td className="num">{p.flights}</td>
                <td className="num">{fmt(p.hours)} h</td>
                <td className="num">{p.qrf != null ? `${fmt(p.qrf, 0)} %` : '—'}</td>
                <td className="num">{p.reports ? <span className="text-warn">{p.reports}</span> : 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  ) : pilot ? (
    <section className="card my-activity">
      <div className="row-between">
        <h2 className="card-title">Mon activité</h2>
        <Link to="/classement" className="small">Classement →</Link>
      </div>
      <div className="kv kv-3">
        <div><span>Ce mois-ci</span><strong>{meMonth ? minutes(Number(meMonth.minutes)) : '0 min'}</strong></div>
        <div><span>Cette année</span><strong>{me ? hours(Number(me.minutes) / 60) : '0 h'}</strong></div>
        <div><span>Rang {new Date().getFullYear()}</span><strong>{myRank ? `${myRank} / ${yearRanked.length}` : '—'}</strong></div>
      </div>
      {career != null && (
        <>
          <div className="small row-between"><span>Carrière : <strong>{hours(career)}</strong></span>{ms && <span className="muted">prochain palier {ms.next} h · reste {fmt(ms.remaining)} h</span>}</div>
          {ms && <div className="rank-ms-track"><span style={{ width: `${ms.pct}%` }} /></div>}
        </>
      )}
      <div className="slot-actions"><Link className="btn btn-sm" to="/carnet">Mon carnet de vol</Link><Link className="btn btn-sm" to="/vols/nouveau">Nouveau vol</Link></div>
    </section>
  ) : null;

  // ------------------------------------------------------------------
  return (
    <>
      <PageHeader
        title={<>{greeting}{firstName ? `, ${firstName.charAt(0).toUpperCase()}${firstName.slice(1)}` : ''}</>}
        subtitle={<>{portName ? <strong>{portName}</strong> : 'Tous les drone ports'} · disponibilité de la flotte, météo, actions et tendances</>}
        actions={<>
          <Link className="btn" to="/statistiques">Statistiques →</Link>
        </>}
      />

      <ActionCenter items={actions} />
      {trends}

      {/* deux colonnes indépendantes : chaque bloc s'empile sous le précédent, sans vide */}
      <div className="dash-columns">
        <div className="dash-col">
          {readiness}
          {map}
        </div>
        <div className="dash-col">
          <WeatherPanel ports={shownPorts} qrfWind={view.qrfWind} />
          {rolePanel}
        </div>
      </div>

      {/* bas de page : deux cartes compactes de même hauteur */}
      <div className="dash-bottom">
        <TabbedCard id="dash-watch" title="À surveiller" tabs={[
          { key: 'echeances', label: 'Échéances', count: soonCount, level: view.forecast.some((f) => f.days <= 7) ? 'danger' : 'warn', link: { to: '/pieces?onglet=synthese', label: 'Échéancier →' }, content: forecast },
          { key: 'rapports', label: 'Rapports ouverts', count: reports.length, level: 'warn', link: { to: '/rapports', label: 'Tous →' }, content: reportsList },
          { key: 'batteries', label: 'Batteries', link: { to: '/batteries', label: 'Toutes →' }, content: batteryList },
        ]} />
        <ActivityFeed items={data.feed} limit={6} />
      </div>
      <section className="card">
        <div className="row-between">
          <h2 className="card-title">Derniers vols</h2>
          <Link to="/vols" className="small">Tous les vols →</Link>
        </div>
        {recent.length === 0 ? (
          <Empty>Aucun vol enregistré. <Link to="/vols/nouveau">Saisir le premier vol</Link></Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Drone</th><th>Destination</th><th>Décollage</th><th>Durée</th><th>Colis</th><th>Pilotes</th><th>Statut</th></tr></thead>
              <tbody>
                {recent.slice(0, 5).map((f) => (
                  <tr key={f.id}>
                    <td><Link to={`/vols/${f.id}`}>{date(f.flight_date)}</Link></td>
                    <td>{f.drone_code}{f.qrf && <> <Badge level="danger">QRF</Badge></>}</td>
                    <td>{f.destination_name ?? <span className="muted">{f.flight_type === 'controle' ? 'Vol de contrôle' : '—'}</span>}</td>
                    <td>{time(f.takeoff_time)}</td>
                    <td>{minutes(f.duration_min)}</td>
                    <td>{f.payload_kg != null ? `${num(f.payload_kg)} kg` : '—'}</td>
                    <td className="ellipsis">{f.pilot_names ?? '—'}</td>
                    <td><FlightStatusBadge status={f.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
