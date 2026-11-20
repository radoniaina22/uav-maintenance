import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { useApp } from '../lib/app';
import { useData } from '../lib/useData';
import { date as fmtDate, LABELS } from '../lib/format';
import {
  buckets, byHour, byPort, byWeekday, daily, download, fetchFlights, isDelivered, Preset, PRESETS, rangeFor, rank, StatFlight, summarize, toCsv,
} from '../lib/stats';
import { BarList, CalendarHeatmap, ChartCard, ColumnChart, fmt, Legend, SegmentedBar, TimeSeriesChart, TipRow } from '../components/charts';
import { Icon } from '../components/icons';
import { CountUp, ErrorBox, Field, Loading, PageHeader } from '../components/ui';

const C1 = 'var(--series-1)', C2 = 'var(--series-2)', C3 = 'var(--series-3)';
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const shortDate = (s: string) => { const [, m, d] = s.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; };
const longDate = (s: string) => {
  const d = new Date(`${s}T12:00:00`);
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
};

/** Variation par rapport à la période de comparaison */
function Delta({ cur, prev, goodWhenUp = true, unit = '%' }: { cur: number | null; prev: number | null; goodWhenUp?: boolean; unit?: '%' | 'pts' }) {
  if (cur == null || prev == null) return null;
  if (unit === 'pts') {
    const d = cur - prev;
    if (Math.abs(d) < 0.05) return <span className="stat-delta flat">= stable</span>;
    const good = d > 0 === goodWhenUp;
    return <span className={`stat-delta ${good ? 'up' : 'down'}`}>{d > 0 ? '▲' : '▼'} {fmt(Math.abs(d))} pt{Math.abs(d) >= 2 ? 's' : ''}</span>;
  }
  if (prev === 0) return cur === 0 ? <span className="stat-delta flat">= stable</span> : <span className="stat-delta flat">nouveau</span>;
  const d = (100 * (cur - prev)) / prev;
  if (Math.abs(d) < 0.5) return <span className="stat-delta flat">= stable</span>;
  const good = d > 0 === goodWhenUp;
  return <span className={`stat-delta ${good ? 'up' : 'down'}`}>{d > 0 ? '▲' : '▼'} {fmt(Math.abs(d), 0)} %</span>;
}


export default function Statistics() {
  const { isAdmin, ports, portFilter, setPortFilter, myPort } = useApp();
  const [preset, setPreset] = useState<Preset>('annee');
  const year = new Date().getFullYear();
  const [custom, setCustom] = useState({ from: `${year}-01-01`, to: new Date().toISOString().slice(0, 10) });
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);

  const { data, error, loading } = useData(async () => {
    const [cur, prev, reports] = await Promise.all([
      fetchFlights(range.from, range.to, portFilter),
      fetchFlights(range.prev.from, range.prev.to, portFilter),
      (async () => {
        let q = supabase.from('v_reports').select('id, report_type, status', { count: 'exact' })
          .gte('flight_date', range.from).lte('flight_date', range.to);
        if (portFilter) q = q.eq('drone_port_id', portFilter);
        return unwrap(await q) as { id: string; report_type: string; status: string }[];
      })(),
    ]);
    return { cur, prev, reports };
  }, [range.from, range.to, range.prev.from, range.prev.to, portFilter]);

  const stats = useMemo(() => {
    if (!data) return null;
    const flights = data.cur;
    const s = summarize(flights);
    const p = summarize(data.prev);
    const days = daily(flights, range.from, range.to);
    // moyenne mobile sur 7 jours
    const ma = days.map((d, i) => {
      const w = days.slice(Math.max(0, i - 6), i + 1);
      return { ...d, ma7: w.reduce((t, x) => t + x.flights, 0) / w.length };
    });
    const busiest = days.reduce((b, d) => (d.flights > (b?.flights ?? 0) ? d : b), null as (typeof days)[number] | null);
    const delivered = flights.filter(isDelivered);
    const csbRank = rank(delivered, (f) => f.destination_name, () => 1);
    const csbKg = new Map(rank(delivered, (f) => f.destination_name, (f) => Number(f.payload_kg ?? 0)).map((x) => [x.label, x.value]));
    const qrfFlights = flights.filter((f) => f.qrf);
    const conditions = rank(qrfFlights.flatMap((f) => (f.qrf_conditions ?? []).map((c) => ({ ...f, _c: c }))) as (StatFlight & { _c: string })[],
      (f) => LABELS.qrfConditions[f._c as keyof typeof LABELS.qrfConditions] ?? f._c, () => 1);
    const windOf = (fs: StatFlight[]) => {
      const w = fs.filter((f) => f.avg_wind_ms != null);
      return w.length ? w.reduce((t, f) => t + Number(f.avg_wind_ms), 0) / w.length : null;
    };
    const pilotHours = rank(flights.flatMap((f) => (f.pilot_names ? f.pilot_names.split(', ').map((name) => ({ ...f, _p: name })) : [])) as (StatFlight & { _p: string })[],
      (f) => f._p, (f) => Number(f.duration_min) / 60);
    return {
      s, p, ma, busiest, csbRank, csbKg, conditions,
      months: buckets(flights, range.from, range.to),
      weekdays: byWeekday(flights),
      hours: byHour(flights),
      drones: rank(flights, (f) => f.drone_code, (f) => Number(f.duration_min) / 60),
      droneFlights: new Map(rank(flights, (f) => f.drone_code, () => 1).map((x) => [x.label, x.value])),
      pilots: pilotHours,
      ports: byPort(flights),
      orgs: [
        { key: 'UNFPA', label: 'UNFPA', color: C1, value: flights.filter((f) => f.organization === 'UNFPA').length },
        { key: 'MINSAN', label: 'MINSAN', color: C2, value: flights.filter((f) => f.organization === 'MINSAN').length },
        { key: 'AUTRE', label: 'Autres', color: C3, value: flights.filter((f) => f.organization === 'AUTRE').length },
      ],
      mix: [
        { key: 'liv', label: 'Livraisons réussies', color: C1, value: s.delivered },
        { key: 'qrf', label: 'QRF', color: C2, value: s.qrf },
        { key: 'ctl', label: 'Vols de contrôle', color: C3, value: flights.filter((f) => f.flight_type === 'controle' && !f.qrf).length },
      ],
      windQrfMeteo: windOf(qrfFlights.filter((f) => f.qrf_cause === 'meteo')),
      windOthers: windOf(flights.filter((f) => !f.qrf)),
    };
  }, [data, range.from, range.to]);

  const portName = portFilter ? ports.find((p) => p.id === portFilter)?.name ?? '' : 'Tous les drone ports';
  const prevLabel = preset === 'annee' || preset === 'annee_prec' || preset === '12mois'
    ? `vs même période ${Number(range.from.slice(0, 4)) - 1}`
    : 'vs période précédente';

  function exportCsv() {
    if (!data) return;
    download(`vols_${range.from}_${range.to}${portFilter ? `_${portName.replace(/\s+/g, '-')}` : ''}.csv`, toCsv(data.cur.map((f) => ({
      date: f.flight_date, decollage: f.takeoff_time.slice(0, 5), drone: f.drone_code, drone_port: f.drone_port_name,
      type: LABELS.flightType[f.flight_type], organisation: f.organization, destination: f.destination_name,
      distance_km: f.distance_km, duree_min: f.duration_min, colis_kg: f.payload_kg, qrf: f.qrf ? 'oui' : 'non',
      cause_qrf: f.qrf_cause ? LABELS.qrfCause[f.qrf_cause] : null,
      conditions_qrf: (f.qrf_conditions ?? []).map((c) => LABELS.qrfConditions[c]),
      conso_mah: f.consumption_mah, vent_ms: f.avg_wind_ms, altitude_m_amsl: f.cruise_altitude_m, pilotes: f.pilot_names,
      statut: LABELS.flightStatus[f.status],
    }))));
  }

  const [trendView, setTrendView] = useState<'calendrier' | 'courbe'>('calendrier');
  const periodName = preset === 'annee' ? `Bilan ${year}` : preset === 'annee_prec' ? `Bilan ${year - 1}` : 'Bilan de la période';
  const bestMonth = stats ? stats.months.rows.reduce((b, m) => (m.delivered + m.qrf + m.control > (b ? b.delivered + b.qrf + b.control : 0) ? m : b), null as (typeof stats.months.rows)[number] | null) : null;

  return (
    <div className="stats-page">
      <PageHeader title="Statistiques" subtitle={<>{portName} · du {fmtDate(range.from)} au {fmtDate(range.to)}</>}
        actions={<button className="btn" onClick={exportCsv} disabled={!data?.cur.length}>⇩ Exporter les vols (CSV)</button>} />

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
            <select value={portFilter} onChange={(e) => setPortFilter(e.target.value)}>
              <option value="">Tous les drone ports</option>
              {ports.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          ) : <select value={myPort?.id} disabled><option>{myPort?.name}</option></select>}
        </Field>
        <span className="muted small">Comparaison : {prevLabel} ({fmtDate(range.prev.from)} → {fmtDate(range.prev.to)})</span>
      </div>

      <ErrorBox error={error} />
      {!stats ? <Loading /> : (
        <div className={`stats-body${loading ? ' viz-refetch' : ''}`}>
          {stats.s.flights === 0 && (
            <div className="alert alert-info">
              Aucun vol enregistré du {fmtDate(range.from)} au {fmtDate(range.to)} pour {portFilter ? portName : 'les drone ports'}. Choisissez une autre période ou un autre drone port.
            </div>
          )}

          {/* ---------------- Bilan ---------------- */}
          <section className="bilan">
            <div className="bilan-story">
              <span className="bilan-kicker">{periodName} · {portFilter ? portName : 'tous les drone ports'}</span>
              <div className="bilan-big"><CountUp value={stats.s.delivered} /><span>livraisons réussies</span></div>
              <p className="bilan-line">
                <strong>{fmt(stats.s.kg)} kg</strong> de produits de santé livrés dans <strong>{stats.s.csb} CSB</strong>,
                {' '}<strong>{fmt(stats.s.km, 0)} km</strong> parcourus en <strong>{fmt(stats.s.hours)} h</strong> de vol.
              </p>
              <div className="bilan-delta">
                <Delta cur={stats.s.delivered} prev={stats.p.delivered} /> <span className="muted small">{prevLabel}</span>
                {stats.s.successRate != null && <span className="bilan-pill">Réussite {fmt(stats.s.successRate, 0)} % · {fmt(stats.s.deliveryAttempts, 0)} tentatives</span>}
              </div>
              <div className="bilan-bars">
                <div><span className="bilan-bar-label">Missions</span><SegmentedBar parts={stats.mix} /></div>
                <div><span className="bilan-bar-label">Organisations</span><SegmentedBar parts={stats.orgs} /></div>
              </div>
            </div>
            <div className="bilan-tiles">
              {([
                ['pin', 'Distance', `${fmt(stats.s.km, 0)} km`, <Delta key="d" cur={stats.s.km} prev={stats.p.km} />, 'distances saisies'],
                ['clock', 'Heures de vol', `${fmt(stats.s.hours)} h`, <Delta key="d" cur={stats.s.hours} prev={stats.p.hours} />, stats.s.avgMinutes != null ? `${fmt(stats.s.avgMinutes, 0)} min / vol` : ''],
                ['box', 'Poids livré', `${fmt(stats.s.kg)} kg`, <Delta key="d" cur={stats.s.kg} prev={stats.p.kg} />, stats.s.avgKg != null ? `${fmt(stats.s.avgKg, 2)} kg / livraison` : ''],
                ['health', 'CSB desservis', String(stats.s.csb), <Delta key="d" cur={stats.s.csb} prev={stats.p.csb} />, 'au moins une livraison'],
                ['wind', 'Taux de QRF', stats.s.qrfRate != null ? `${fmt(stats.s.qrfRate, 1)} %` : '—', <Delta key="d" cur={stats.s.qrfRate} prev={stats.p.qrfRate} goodWhenUp={false} unit="pts" />, `${stats.s.qrfMeteo} météo · ${stats.s.qrfTech} tech.`],
                ['shield', 'Vols de contrôle', stats.s.controlRate != null ? `${fmt(stats.s.controlRate, 1)} %` : '—', null, `${stats.s.control} vol(s) sur ${stats.s.flights}`],
              ] as const).map(([icon, label, value, delta, sub]) => (
                <div key={label} className="bt">
                  <span className="bt-icon"><Icon name={icon} size={17} /></span>
                  <span className="bt-label">{label}</span>
                  <strong className="bt-value">{value}</strong>
                  <span className="bt-sub">{delta} {sub}</span>
                </div>
              ))}
            </div>
          </section>

          {/* ---------------- Records ---------------- */}
          <div className="records">
            {[
              { icon: '📅', label: 'Jour record', value: stats.busiest && stats.busiest.flights > 0 ? longDate(stats.busiest.date) : '—', sub: stats.busiest ? `${stats.busiest.flights} vol(s) · ${stats.busiest.delivered} livraison(s)` : '' },
              { icon: '📈', label: `Meilleur ${stats.months.unit}`, value: bestMonth && bestMonth.delivered + bestMonth.qrf + bestMonth.control > 0 ? bestMonth.label : '—', sub: bestMonth ? `${bestMonth.delivered + bestMonth.qrf + bestMonth.control} vol(s) · ${fmt(bestMonth.hours)} h` : '' },
              { icon: '🏥', label: 'CSB le plus desservi', value: stats.csbRank[0]?.label ?? '—', sub: stats.csbRank[0] ? `${stats.csbRank[0].value} livraison(s) · ${fmt(stats.csbKg.get(stats.csbRank[0].label) ?? 0)} kg` : '' },
              { icon: '🛸', label: 'Drone le plus actif', value: stats.drones[0]?.label ?? '—', sub: stats.drones[0] ? `${fmt(stats.drones[0].value)} h · ${stats.droneFlights.get(stats.drones[0].label) ?? 0} vol(s)` : '' },
              { icon: '🏆', label: 'Pilote le plus actif', value: stats.pilots[0]?.label ?? '—', sub: stats.pilots[0] ? `${fmt(stats.pilots[0].value)} h de vol` : '' },
            ].map((r) => (
              <div key={r.label} className="record">
                <span className="record-icon" aria-hidden>{r.icon}</span>
                <span className="record-label">{r.label}</span>
                <strong className="record-value">{r.value}</strong>
                <span className="record-sub">{r.sub}</span>
              </div>
            ))}
          </div>

          {/* ---------------- À retenir ---------------- */}
          <section className="card">
            <h2 className="card-title">À retenir</h2>
            <div className="insights conso-insights">
              <div className="insight ins-blue"><span className="insight-icon">✈</span><div><strong>{fmt(stats.s.flights, 0)} vols</strong> au total <Delta cur={stats.s.flights} prev={stats.p.flights} /><br /><span className="muted">{stats.s.activeDays} jour(s) d'activité · {stats.s.flightsPerActiveDay != null ? fmt(stats.s.flightsPerActiveDay) : '—'} vol(s) / jour actif</span></div></div>
              <div className="insight ins-violet"><span className="insight-icon">⏱</span><div>Délai moyen décollage → largage : <strong>{stats.s.avgTimeToDrop != null ? `${fmt(stats.s.avgTimeToDrop, 0)} min` : '—'}</strong><br /><span className="muted">sur les livraisons avec heure de largage</span></div></div>
              <div className="insight ins-gold"><span className="insight-icon">⚡</span><div>Consommation moyenne : <strong>{stats.s.mahPerKm != null ? `${fmt(stats.s.mahPerKm, 0)} mAh / km` : '—'}</strong><br /><span className="muted"><Link to="/consommation">analyse détaillée →</Link></span></div></div>
              {stats.windQrfMeteo != null && (
                <div className="insight ins-cyan"><span className="insight-icon">☁</span><div>Vent moyen lors des QRF météo : <strong>{fmt(stats.windQrfMeteo)} m/s</strong><br /><span className="muted">contre {stats.windOthers != null ? `${fmt(stats.windOthers)} m/s` : '—'} sur les autres vols</span></div></div>
              )}
              <div className="insight ins-green"><span className="insight-icon">☺</span><div><strong>{stats.s.pilots}</strong> pilote(s) et <strong>{stats.s.drones}</strong> drone(s) actifs<br /><span className="muted">sur la période · <Link to="/classement">classement →</Link></span></div></div>
              <div className={`insight ${data!.reports.some((r) => r.status !== 'clos') ? 'ins-orange' : 'ins-green'}`}><span className="insight-icon">⚠</span><div><strong>{data!.reports.length}</strong> rapport(s) technique(s) / incident(s)<br /><span className="muted">dont {data!.reports.filter((r) => r.status !== 'clos').length} non clos · <Link to="/rapports">voir</Link></span></div></div>
              {stats.s.openFlights > 0 && (
                <div className="insight ins-orange"><span className="insight-icon">✎</span><div><strong>{stats.s.openFlights}</strong> vol(s) non clôturé(s)<br /><span className="muted">leurs heures ne sont pas encore au carnet · <Link to="/vols?statut=ouvert">clôturer</Link></span></div></div>
              )}
            </div>
          </section>

          {/* ---------------- Graphiques ---------------- */}
          <div className="viz-grid-layout">
            <ChartCard wide title="Activité de vol" subtitle={`${fmt(stats.s.flights, 0)} vols du ${fmtDate(range.from)} au ${fmtDate(range.to)}`}
              legend={<div className="row-between viz-controls">
                {trendView === 'courbe'
                  ? <Legend shape="line" items={[{ key: 'd', label: 'Vols par jour', color: C1 }, { key: 'm', label: 'Moyenne mobile 7 jours', color: C2 }]} />
                  : <span className="calhm-legend small muted">moins <i className="calhm-cell l0" /><i className="calhm-cell l1" /><i className="calhm-cell l2" /><i className="calhm-cell l3" /><i className="calhm-cell l4" /> plus · une case par jour</span>}
                <div className="segmented segmented-sm" role="tablist" aria-label="Présentation">
                  <button type="button" role="tab" aria-selected={trendView === 'calendrier'} className={trendView === 'calendrier' ? 'active' : ''} onClick={() => setTrendView('calendrier')}>Calendrier</button>
                  <button type="button" role="tab" aria-selected={trendView === 'courbe'} className={trendView === 'courbe' ? 'active' : ''} onClick={() => setTrendView('courbe')}>Courbe</button>
                </div>
              </div>}
              table={{
                columns: ['Date', 'Vols', 'Livraisons', 'QRF', 'Contrôles', 'Heures'],
                rows: stats.ma.filter((d) => d.flights > 0).map((d) => [fmtDate(d.date), d.flights, d.delivered, d.qrf, d.control, d.minutes / 60]),
              }}>
              {trendView === 'calendrier' ? (
                <CalendarHeatmap days={stats.ma.map((d) => ({ date: d.date, value: d.flights }))}
                  title={(d) => { const x = stats.ma.find((m) => m.date === d.date)!; return `${longDate(d.date)} : ${x.flights ? `${x.flights} vol(s) · ${x.delivered} livraison(s)${x.qrf ? ` · ${x.qrf} QRF` : ''}` : 'aucun vol'}`; }} />
              ) : (
                <TimeSeriesChart data={stats.ma} height={240} xLabel={shortDate}
                  series={[
                    { key: 'd', label: 'Vols par jour', color: C1, value: (d) => d.flights, area: true },
                    { key: 'm', label: 'Moyenne mobile 7 jours', color: C2, value: (d) => d.ma7 },
                  ]}
                  tooltip={(d) => <>
                    <div className="viz-tip-title">{longDate(d.date)}</div>
                    <TipRow color={C1} label={d.flights > 1 ? 'vols' : 'vol'} value={fmt(d.flights, 0)} />
                    <TipRow color={C2} label="moyenne 7 j" value={fmt(d.ma7)} />
                    {d.flights > 0 && <div className="muted small">{d.delivered} livraison(s) · {d.qrf} QRF · {d.control} contrôle(s)</div>}
                  </>} />
              )}
            </ChartCard>

            <ChartCard title={`Activité par ${stats.months.unit}`} subtitle="Livraisons réussies, QRF et vols de contrôle"
              legend={<Legend items={[{ key: 'l', label: 'Livraisons', color: C1 }, { key: 'q', label: 'QRF', color: C2 }, { key: 'c', label: 'Contrôles', color: C3 }]} />}
              table={{ columns: [stats.months.unit === 'mois' ? 'Mois' : 'Semaine du', 'Livraisons', 'QRF', 'Contrôles', 'Total'],
                rows: stats.months.rows.map((m) => [m.label, m.delivered, m.qrf, m.control, m.delivered + m.qrf + m.control]) }}>
              <ColumnChart data={stats.months.rows}
                series={[
                  { key: 'l', label: 'Livraisons', color: C1, value: (m) => m.delivered },
                  { key: 'q', label: 'QRF', color: C2, value: (m) => m.qrf },
                  { key: 'c', label: 'Contrôles', color: C3, value: (m) => m.control },
                ]}
                tooltip={(m) => <>
                  <div className="viz-tip-title">{m.label}</div>
                  <TipRow color={C1} label="livraisons" value={fmt(m.delivered, 0)} />
                  <TipRow color={C2} label="QRF" value={fmt(m.qrf, 0)} />
                  <TipRow color={C3} label="contrôles" value={fmt(m.control, 0)} />
                </>} />
            </ChartCard>

            <ChartCard title={`Heures de vol par ${stats.months.unit}`} subtitle={`${fmt(stats.s.hours)} h au total`}
              table={{ columns: [stats.months.unit === 'mois' ? 'Mois' : 'Semaine du', 'Heures', 'Distance (km)', 'Poids livré (kg)'],
                rows: stats.months.rows.map((m) => [m.label, m.hours, m.km, m.kg]) }}>
              <ColumnChart data={stats.months.rows}
                series={[{ key: 'h', label: 'Heures', color: C1, value: (m) => m.hours }]}
                tooltip={(m) => <>
                  <div className="viz-tip-title">{m.label}</div>
                  <TipRow color={C1} label="heures de vol" value={fmt(m.hours)} />
                  <div className="muted small">{fmt(m.km, 0)} km · {fmt(m.kg)} kg livrés</div>
                </>} />
            </ChartCard>

            <ChartCard title="Vols par jour de la semaine"
              table={{ columns: ['Jour', 'Vols'], rows: stats.weekdays.map((d) => [d.label, d.value]) }}>
              <ColumnChart data={stats.weekdays} height={200}
                series={[{ key: 'v', label: 'Vols', color: C1, value: (d) => d.value }]}
                tooltip={(d) => <><div className="viz-tip-title">{d.label}</div><TipRow color={C1} label="vols" value={fmt(d.value, 0)} /></>} />
            </ChartCard>

            <ChartCard title="Heures de décollage" subtitle="Nombre de vols selon l'heure de décollage"
              table={{ columns: ['Heure', 'Vols'], rows: stats.hours.filter((h) => h.value > 0).map((h) => [h.label, h.value]) }}>
              <ColumnChart data={stats.hours} height={200}
                series={[{ key: 'v', label: 'Vols', color: C1, value: (d) => d.value }]}
                tooltip={(d) => <><div className="viz-tip-title">Décollage à {d.label}</div><TipRow color={C1} label="vols" value={fmt(d.value, 0)} /></>} />
            </ChartCard>

            <ChartCard title="CSB les plus desservis" subtitle={`${stats.s.csb} CSB · livraisons réussies`}
              table={{ columns: ['CSB', 'Livraisons', 'Poids livré (kg)'], rows: stats.csbRank.map((c) => [c.label, c.value, stats.csbKg.get(c.label) ?? 0]) }}>
              {stats.csbRank.length ? (
                <BarList data={stats.csbRank} color={C1} format={(v) => `${fmt(v, 0)} livr.`}
                  sub={(l) => `${fmt(stats.csbKg.get(l) ?? 0)} kg`} />
              ) : <div className="muted small">Aucune livraison réussie sur la période.</div>}
            </ChartCard>

            <ChartCard title="QRF : conditions rencontrées" subtitle={`${stats.s.qrf} QRF · une condition peut apparaître sur plusieurs vols`}
              table={{ columns: ['Condition', 'QRF'], rows: stats.conditions.map((c) => [c.label, c.value]) }}>
              {stats.conditions.length ? <BarList data={stats.conditions} color={C2} format={(v) => fmt(v, 0)} />
                : <div className="muted small">{stats.s.qrf ? 'Aucune condition renseignée sur les QRF.' : 'Aucun QRF sur la période.'}</div>}
            </ChartCard>

            <ChartCard title="Heures de vol par drone"
              table={{ columns: ['Drone', 'Heures', 'Vols'], rows: stats.drones.map((d) => [d.label, d.value, stats.droneFlights.get(d.label) ?? 0]) }}>
              {stats.drones.length ? <BarList data={stats.drones} color={C1} format={(v) => `${fmt(v)} h`}
                sub={(l) => `${stats.droneFlights.get(l) ?? 0} vol(s)`} /> : <div className="muted small">Aucun vol.</div>}
            </ChartCard>

            <ChartCard title="Heures de vol par pilote" subtitle="Tous les vols de la période (clôturés ou non)"
              table={{ columns: ['Pilote', 'Heures'], rows: stats.pilots.map((p) => [p.label, p.value]) }}>
              {stats.pilots.length ? <BarList data={stats.pilots} color={C1} format={(v) => `${fmt(v)} h`} /> : <div className="muted small">Aucun vol.</div>}
            </ChartCard>

            {!portFilter && stats.ports.length > 0 && (
              <section className="card viz-card-wide">
                <h2 className="card-title">Comparaison des drone ports</h2>
                <div className="port-cards">
                  {stats.ports.map((p) => (
                    <div key={p.port} className="port-card">
                      <div className="row-between"><strong className="port-card-name">⌂ {p.port}</strong><span className="small muted">{fmt(p.flights, 0)} vols</span></div>
                      <div className="port-card-grid">
                        <div><span>Livraisons</span><strong>{fmt(p.delivered, 0)}</strong></div>
                        <div><span>Réussite</span><strong>{p.successRate != null ? `${fmt(p.successRate, 0)} %` : '—'}</strong></div>
                        <div><span>Heures</span><strong>{fmt(p.hours)} h</strong></div>
                        <div><span>Distance</span><strong>{fmt(p.km, 0)} km</strong></div>
                        <div><span>Poids livré</span><strong>{fmt(p.kg)} kg</strong></div>
                        <div><span>CSB</span><strong>{p.csb}</strong></div>
                        <div><span>QRF</span><strong>{p.qrfRate != null ? `${fmt(p.qrfRate, 1)} %` : '—'}</strong></div>
                        <div><span>Contrôles</span><strong>{p.controlRate != null ? `${fmt(p.controlRate, 1)} %` : '—'}</strong></div>
                      </div>
                      <div className="port-card-share" title="Part des vols de la période">
                        <span style={{ width: `${stats.s.flights ? (100 * p.flights) / stats.s.flights : 0}%` }} />
                      </div>
                      <span className="small muted">{stats.s.flights ? `${fmt((100 * p.flights) / stats.s.flights, 0)} %` : '—'} des vols de la période</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
          <p className="muted small">
            Livraison réussie = vol de type « Livraison » sans QRF. Le poids livré et les CSB desservis ne comptent que les livraisons réussies.
            La distance totale reprend les distances saisies sur chaque vol (QRF compris). Les heures comptent tous les vols, clôturés ou non.
          </p>
        </div>
      )}
    </div>
  );
}