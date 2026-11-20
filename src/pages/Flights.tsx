import { Fragment, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { byPort, useApp } from '../lib/app';
import { useData } from '../lib/useData';
import type { Drone, FlightRow } from '../lib/types';
import { cardinal, cellLevel, cellText, km, LABELS, minutes, num, time, volts } from '../lib/format';
import { Badge, Empty, ErrorBox, FlightStatusBadge, Loading, PageHeader } from '../components/ui';
import { Icon } from '../components/icons';

const PAGE = 50;
type View = 'compact' | 'technique';

const dayTitle = (s: string) => {
  const d = new Date(`${s}T12:00:00`);
  const t = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const readView = (): View => { try { return localStorage.getItem('uav.flightsView') === 'technique' ? 'technique' : 'compact'; } catch { return 'compact'; } };

/** Détails d'un vol affichés quand on déplie sa ligne */
function FlightDetails({ f }: { f: FlightRow }) {
  const items: [string, React.ReactNode][] = [
    ['Organisation', f.organization_label],
    ['Horaires', <>{time(f.takeoff_time)} → {f.qrf ? <span className="text-danger">QRF {f.qrf_time ? time(f.qrf_time) : ''}</span> : time(f.drop_time)} → {time(f.landing_time)}</>],
    ['Distance', km(f.distance_km)],
    ['Altitude de croisière', f.cruise_altitude_m != null ? `${num(f.cruise_altitude_m, 0)} m AMSL` : '—'],
    ['Vent moyen', f.avg_wind_ms != null ? <>{num(f.avg_wind_ms)} m/s{f.wind_direction_deg != null && <span className="muted"> · {cardinal(f.wind_direction_deg)}</span>}</> : '—'],
    ['Pack', f.pack_number ? `Pack ${f.pack_number}${f.battery_1_code ? ` (${f.battery_1_code} + ${f.battery_2_code ?? '—'})` : ''}` : '—'],
    ['Consommation', f.consumption_mah != null ? `${num(f.consumption_mah, 0)} mAh` : '—'],
    ['Tension départ → arrivée', f.voltage_start_v == null && f.voltage_end_v == null ? '—' : <>
      {volts(f.voltage_start_v)} → <span className={`text-${cellLevel(f.cell_voltage_end, 'end')}`}>{volts(f.voltage_end_v)}</span>
      <div className="small muted">{cellText(f.voltage_start_v)} → {cellText(f.voltage_end_v)}</div></>],
    ['Pilotes', f.pilot_names ?? '—'],
    ['Rapports', f.report_count ? `${f.report_count} (dont ${f.open_report_count} ouvert(s))` : 'Aucun'],
  ];
  if (f.qrf) items.push(['QRF', <>{f.qrf_cause ? LABELS.qrfCause[f.qrf_cause] : '—'}{f.qrf_conditions?.length ? ` · ${f.qrf_conditions.map((c) => LABELS.qrfConditions[c]).join(', ')}` : ''}</>]);
  return (
    <div className="flight-details">
      <dl className="detail-grid">
        {items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      {f.observation && <p className="small"><span className="muted">Observation : </span>{f.observation}</p>}
      <div className="slot-actions">
        <Link className="btn btn-sm btn-primary" to={`/vols/${f.id}`}>Ouvrir la fiche →</Link>
        <Link className="btn btn-sm" to={`/vols/${f.id}/modifier`}>Modifier</Link>
      </div>
    </div>
  );
}

export default function Flights() {
  const { portFilter } = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('statut') ?? '';
  const [droneId, setDroneId] = useState('');
  const [flightType, setFlightType] = useState('');
  const [org, setOrg] = useState('');
  const [qrf, setQrf] = useState(params.get('qrf') ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [moreFilters, setMoreFilters] = useState(!!(params.get('qrf')));
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [view, setViewState] = useState<View>(readView);
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem('uav.flightsView', v); } catch { /* sans stockage */ } };

  const drones = useData(async () => unwrap(await byPort(supabase.from('drones').select('*'), portFilter).order('code')) as Drone[], [portFilter]);

  // mêmes filtres pour la liste et pour le bandeau de chiffres clés
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applyFilters = (q: any, opts: { status?: boolean } = {}) => {
    if (status && opts.status !== false) q = q.eq('status', status);
    if (droneId) q = q.eq('drone_id', droneId);
    if (flightType) q = q.eq('flight_type', flightType);
    if (org) q = q.eq('organization', org);
    if (qrf) q = q.eq('qrf', qrf === 'oui');
    if (from) q = q.gte('flight_date', from);
    if (to) q = q.lte('flight_date', to);
    // caractères réservés de la syntaxe de filtre PostgREST retirés
    const s = search.replace(/[,()%*\\"]/g, ' ').trim();
    if (s) q = q.or(`destination_name.ilike.%${s}%,pilot_names.ilike.%${s}%,observation.ilike.%${s}%,organization_other.ilike.%${s}%`);
    return q;
  };
  const filterKey = [portFilter, status, droneId, flightType, org, qrf, from, to, search];

  const flights = useData(async () => {
    const q = applyFilters(byPort(supabase.from('v_flights').select('*', { count: 'exact' }), portFilter)
      .order('flight_date', { ascending: false }).order('takeoff_time', { ascending: false }).limit(limit));
    const res = await q;
    return { rows: unwrap(res) as FlightRow[], count: res.count ?? 0 };
  }, [...filterKey, limit]);

  // chiffres clés : tous les vols correspondant aux filtres (hors statut, pour compter les vols à clôturer)
  const kpi = useData(async () => {
    const res = await applyFilters(byPort(supabase.from('v_flights').select('duration_min, distance_km, payload_kg, qrf, status, flight_type'), portFilter), { status: false }).limit(10000);
    const all = unwrap(res) as Pick<FlightRow, 'duration_min' | 'distance_km' | 'payload_kg' | 'qrf' | 'status' | 'flight_type'>[];
    const fs = status ? all.filter((f) => f.status === status) : all;
    const delivered = fs.filter((f) => f.flight_type === 'livraison' && !f.qrf);
    return {
      flights: fs.length,
      minutes: fs.reduce((s, f) => s + Number(f.duration_min), 0),
      km: fs.reduce((s, f) => s + Number(f.distance_km ?? 0), 0),
      kg: delivered.reduce((s, f) => s + Number(f.payload_kg ?? 0), 0),
      delivered: delivered.length,
      qrf: fs.filter((f) => f.qrf).length,
      controls: fs.filter((f) => f.flight_type === 'controle').length,
      open: all.filter((f) => f.status === 'ouvert').length,
    };
  }, filterKey);

  const rows = flights.data?.rows ?? [];
  const showPort = !portFilter;
  const tech = view === 'technique';
  const secondaryActive = [flightType, org, qrf].filter(Boolean).length;
  const anyFilter = !!(status || droneId || from || to || search || secondaryActive);
  const toggle = (id: string) => { const s = new Set(open); if (s.has(id)) s.delete(id); else s.add(id); setOpen(s); };
  const reset = () => { setParams({}); setDroneId(''); setFlightType(''); setOrg(''); setQrf(''); setFrom(''); setTo(''); setSearch(''); };

  // regroupement par jour
  const days: { date: string; flights: FlightRow[] }[] = [];
  for (const f of rows) {
    const last = days[days.length - 1];
    if (last?.date === f.flight_date) last.flights.push(f); else days.push({ date: f.flight_date, flights: [f] });
  }
  const colCount = 8 + (tech ? 4 : 0);

  return (
    <div className="flights-page">
      <PageHeader
        title="Vols"
        subtitle="Journal des vols de livraison par largage"
        actions={<><Link className="btn" to="/crm/export">⇩ Exporter les CRM</Link><Link className="btn btn-primary" to="/vols/nouveau">+ Nouveau vol</Link></>}
      />

      <div className="card filters">
        <label className="field field-grow">
          <span className="field-label">Recherche</span>
          <input placeholder="CSB, pilote, observation…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Statut</span>
          <select value={status} onChange={(e) => setParams(e.target.value ? { statut: e.target.value } : {})}>
            <option value="">Tous</option>
            <option value="ouvert">Ouverts (à clôturer)</option>
            <option value="cloture">Clôturés</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Drone</span>
          <select value={droneId} onChange={(e) => setDroneId(e.target.value)}>
            <option value="">Tous</option>
            {drones.data?.map((d) => <option key={d.id} value={d.id}>{d.code}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Du</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Au</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="button" className={`btn${moreFilters ? ' active' : ''}`} aria-expanded={moreFilters} onClick={() => setMoreFilters(!moreFilters)}>
          {moreFilters ? '▴' : '▾'} Plus de filtres{secondaryActive ? ` (${secondaryActive})` : ''}
        </button>
        {anyFilter && <button type="button" className="btn btn-ghost" onClick={reset}>Réinitialiser</button>}
        {moreFilters && (
          <div className="filters-more">
            <label className="field">
              <span className="field-label">Type</span>
              <select value={flightType} onChange={(e) => setFlightType(e.target.value)}>
                <option value="">Tous</option>
                {Object.entries(LABELS.flightType).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Organisation</span>
              <select value={org} onChange={(e) => setOrg(e.target.value)}>
                <option value="">Toutes</option>
                {Object.entries(LABELS.organization).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="field-label">QRF</span>
              <select value={qrf} onChange={(e) => setQrf(e.target.value)}>
                <option value="">Tous les vols</option>
                <option value="oui">QRF uniquement</option>
                <option value="non">Sans QRF</option>
              </select>
            </label>
          </div>
        )}
      </div>

      {kpi.data && (
        <div className="flight-kpis">
          <div className="fk"><span className="fk-icon"><Icon name="flight" size={18} /></span><div><strong>{kpi.data.flights}</strong><span>vol(s)</span></div></div>
          <div className="fk"><span className="fk-icon"><Icon name="clock" size={18} /></span><div><strong>{minutes(kpi.data.minutes)}</strong><span>de vol</span></div></div>
          <div className="fk"><span className="fk-icon"><Icon name="pin" size={18} /></span><div><strong>{num(kpi.data.km, 0)} km</strong><span>parcourus</span></div></div>
          <div className="fk"><span className="fk-icon"><Icon name="box" size={18} /></span><div><strong>{num(kpi.data.kg)} kg</strong><span>livrés · {kpi.data.delivered} livr.</span></div></div>
          <div className={`fk${kpi.data.qrf ? ' fk-warn' : ''}`}><span className="fk-icon"><Icon name="wind" size={18} /></span>
            <div><strong>{kpi.data.flights ? `${num((100 * kpi.data.qrf) / kpi.data.flights, 0)} %` : '—'}</strong><span>{kpi.data.qrf} QRF</span></div></div>
          <button type="button" className={`fk fk-action${kpi.data.open ? ' fk-warn' : ' fk-ok'}`} onClick={() => setParams(status === 'ouvert' ? {} : { statut: 'ouvert' })}
            title={status === 'ouvert' ? 'Afficher tous les vols' : 'Afficher les vols à clôturer'}>
            <span className="fk-icon"><Icon name="book" size={18} /></span>
            <div><strong>{kpi.data.open}</strong><span>{kpi.data.open ? 'à clôturer →' : 'tout est clôturé ✓'}</span></div>
          </button>
        </div>
      )}

      <div className="quick-filters" role="group" aria-label="Filtres rapides">
        {([
          ['tous', 'Tous les vols', !status && !qrf && !flightType, () => { setParams({}); setQrf(''); setFlightType(''); }],
          ['ouvert', `À clôturer${kpi.data ? ` · ${kpi.data.open}` : ''}`, status === 'ouvert', () => setParams({ statut: 'ouvert' })],
          ['cloture', 'Clôturés', status === 'cloture', () => setParams({ statut: 'cloture' })],
          ['livraison', 'Livraisons', flightType === 'livraison' && !qrf, () => { setFlightType('livraison'); setQrf(''); }],
          ['qrf', `QRF${kpi.data ? ` · ${kpi.data.qrf}` : ''}`, qrf === 'oui', () => { setQrf('oui'); setFlightType(''); }],
          ['controle', 'Contrôles', flightType === 'controle', () => { setFlightType('controle'); setQrf(''); }],
        ] as const).map(([k, label, active, go]) => (
          <button key={k} type="button" className={`qf qf-${k}${active ? ' active' : ''}`} aria-pressed={active} onClick={go}>{label}</button>
        ))}
      </div>

      <ErrorBox error={flights.error} />
      {flights.loading && !flights.data ? <Loading /> : rows.length === 0 ? (
        <Empty>Aucun vol trouvé.</Empty>
      ) : (
        <div className="card no-pad">
          <div className="table-summary row-between">
            <span className="small muted">
              <strong className="text">{flights.data?.count}</strong> vol(s){rows.length < (flights.data?.count ?? 0) ? ` · ${rows.length} les plus récents affichés` : ''}
              <span className="legend-dots"><i className="ld ld-liv" /> Livraison <i className="ld ld-qrf" /> QRF <i className="ld ld-ctl" /> Contrôle</span>
            </span>
            <div className="segmented segmented-sm" role="group" aria-label="Colonnes affichées">
              <button type="button" className={!tech ? 'active' : ''} aria-pressed={!tech} onClick={() => setView('compact')}>Essentiel</button>
              <button type="button" className={tech ? 'active' : ''} aria-pressed={tech} onClick={() => setView('technique')}>+ Technique</button>
            </div>
          </div>
          <div className="table-wrap">
            <table className="flights-table">
              <thead>
                <tr>
                  <th className="col-expand" aria-label="Détails" />
                  <th>Heure</th><th>Vol</th><th>Drone</th><th>Destination</th><th className="num">Durée</th><th className="num">Colis</th>
                  {tech && <><th className="num">Altitude</th><th className="num">Vent</th><th className="num">Conso.</th><th className="num">Tension arr.</th></>}
                  <th>État</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <Fragment key={d.date}>
                    <tr className="day-row">
                      <td colSpan={colCount}>
                        <div className="day-head">
                          <span className="day-pill"><b>{d.date.slice(8, 10)}</b><i>{dayTitle(d.date).split(' ')[0].slice(0, 3)}</i></span>
                          <strong>{dayTitle(d.date)}</strong>
                          <span className="day-chips">
                            <span>{d.flights.length} vol{d.flights.length > 1 ? 's' : ''}</span>
                            <span>{minutes(d.flights.reduce((s, f) => s + Number(f.duration_min), 0))}</span>
                            {d.flights.some((f) => f.qrf) && <span className="chip-qrf">{d.flights.filter((f) => f.qrf).length} QRF</span>}
                            {d.flights.some((f) => f.status === 'ouvert') && <span className="chip-open">{d.flights.filter((f) => f.status === 'ouvert').length} à clôturer</span>}
                          </span>
                        </div>
                      </td>
                    </tr>
                    {d.flights.map((f) => {
                      const isOpen = open.has(f.id);
                      return (
                        <Fragment key={f.id}>
                          <tr className={`flight-row t-${f.qrf ? 'qrf' : f.flight_type}${isOpen ? ' is-open' : ''}`} onClick={(e) => {
                            if ((e.target as HTMLElement).closest('a,button')) return;
                            navigate(`/vols/${f.id}`);
                          }}>
                            <td className="col-expand">
                              <button type="button" className="expand-btn" aria-expanded={isOpen} aria-label={isOpen ? 'Masquer les détails' : 'Afficher les détails'}
                                onClick={() => toggle(f.id)}>{isOpen ? '▾' : '▸'}</button>
                            </td>
                            <td data-label="Heure" className="nowrap">
                              <Link to={`/vols/${f.id}`}><strong>{time(f.takeoff_time)}</strong></Link>
                              <span className="muted small"> → {time(f.landing_time)}</span>
                            </td>
                            <td data-label="Vol" className="nowrap">
                              <Badge level={f.flight_type === 'controle' ? 'neutral' : 'info'}>{f.flight_type === 'controle' ? 'Contrôle' : 'Livraison'}</Badge>
                              {f.qrf && <> <Badge level="danger">QRF</Badge></>}
                              {f.retry_of_flight_id && <span className="muted small" title="Nouvelle tentative après un vol précédent"> ↻</span>}
                              <div className="small muted ellipsis">{f.organization_label}</div>
                            </td>
                            <td data-label="Drone">
                              <span className="drone-tag"><Icon name="drone" size={13} /> {f.drone_code}</span>
                              {showPort && <div className="small muted">{f.drone_port_name ?? '—'}</div>}
                            </td>
                            <td data-label="Destination">
                              {f.destination_name ?? <span className="muted">—</span>}
                              {f.distance_km != null && <div className="small muted">{km(f.distance_km)}</div>}
                            </td>
                            <td data-label="Durée" className="num nowrap">{minutes(f.duration_min)}</td>
                            <td data-label="Colis" className="num nowrap">{f.payload_kg != null ? `${num(f.payload_kg)} kg` : '—'}</td>
                            {tech && <>
                              <td data-label="Altitude" className="num nowrap">{f.cruise_altitude_m != null ? `${num(f.cruise_altitude_m, 0)} m` : '—'}</td>
                              <td data-label="Vent" className="num nowrap">{f.avg_wind_ms != null ? `${num(f.avg_wind_ms)} m/s` : '—'}{f.wind_direction_deg != null && <span className="muted"> {cardinal(f.wind_direction_deg)}</span>}</td>
                              <td data-label="Conso." className="num nowrap">{f.consumption_mah != null ? `${num(f.consumption_mah, 0)} mAh` : '—'}</td>
                              <td data-label="Tension arr." className="num nowrap">{f.voltage_end_v != null
                                ? <><span className={`text-${cellLevel(f.cell_voltage_end, 'end')}`}>{volts(f.voltage_end_v)}</span><div className="small muted">{cellText(f.voltage_end_v)}</div></> : '—'}</td>
                            </>}
                            <td data-label="État" className="nowrap">
                              <FlightStatusBadge status={f.status} />
                              {f.open_report_count > 0 && <> <span title={`${f.open_report_count} rapport(s) ouvert(s)`}><Badge level="warn">⚠ {f.open_report_count}</Badge></span></>}
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className="detail-row"><td colSpan={colCount}><FlightDetails f={f} /></td></tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {(flights.data?.count ?? 0) > rows.length && (
            <div className="pad center">
              <button className="btn" onClick={() => setLimit(limit + PAGE)}>Afficher plus ({(flights.data?.count ?? 0) - rows.length} restants)</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
