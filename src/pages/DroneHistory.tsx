import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { useData } from '../lib/useData';
import type { DroneStatusRow, ReportRow } from '../lib/types';
import { date, hours, LABELS, num } from '../lib/format';
import { addDays, daysBetween, download, iso, parseIso, toCsv } from '../lib/stats';
import { TANGO4_ZONES, zoneLabel } from '../lib/parts';
import { Badge, Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { Icon, IconName } from '../components/icons';
import UavLogo from '../components/UavLogo';

interface HistoryRow {
  at: string; category: 'piece' | 'rapport' | 'mesure' | 'visite'; event: string; title: string; detail: string | null; note: string | null;
  severity: 'mineur' | 'majeur' | 'critique' | null; status: 'ouvert' | 'en_cours' | 'clos' | null; actor: string | null; link: string | null;
  part_code: string | null; slot_label: string | null; hours: number | null;
}
interface SlotRow { code: string; zone: string; label: string }
type Filter = 'tout' | 'piece' | 'rapport' | 'visite';

const CAT: Record<HistoryRow['category'], { label: string; icon: IconName }> = {
  piece: { label: 'Pièce', icon: 'chip' },
  rapport: { label: 'Compte rendu', icon: 'alert' },
  mesure: { label: 'Mesure corrective', icon: 'shield' },
  visite: { label: 'Visite', icon: 'wrench' },
};
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const MONTHS_SHORT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const SEV_RANK = { mineur: 1, majeur: 2, critique: 3 } as const;
const sevLevel = (s: HistoryRow['severity']) => (s === 'critique' ? 'danger' : s === 'majeur' ? 'warn' : 'neutral');
const fmtDateTime = (at: string, dateOnly: boolean) => {
  const d = new Date(at);
  return dateOnly ? d.toLocaleDateString('fr-FR') : `${d.toLocaleDateString('fr-FR')} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
};
const localDay = (at: string) => iso(new Date(at));

/** Composant (texte libre des rapports) → zone du Tango 4. L'ordre compte : le plus précis d'abord. */
const COMP_ZONE: [RegExp, string][] = [
  [/vtol\s*1|avant gauche/i, 'vtol_avg'],
  [/vtol\s*2|avant droit/i, 'vtol_avd'],
  [/vtol\s*3|arri[eè]re gauche/i, 'vtol_arg'],
  [/vtol\s*4|arri[eè]re droit/i, 'vtol_ard'],
  [/moteur principal|propulsion|horizontal|pouss[ée]e|\besc\b/i, 'propulsion'],
  [/largage|trappe|soute|parachute/i, 'soute'],
  [/gouverne|empennage/i, 'empennage'],
  [/aile(ron)? gauche/i, 'aile_g'],
  [/aile(ron)? droit/i, 'aile_d'],
  [/gps|autopilote|capteur|t[ée]l[ée]m[ée]trie|radio|avionique|cam[ée]ra|lidar|ads|batter|pi zero|\bbec\b|sonde/i, 'avionique'],
];
const componentZone = (c: string | null | undefined) => (c ? COMP_ZONE.find(([re]) => re.test(c))?.[1] ?? null : null);
const titleComponent = (title: string) => title.split(' · ').slice(1).join(' · ') || null;

/** « 24.6 h » → « 24,6 h » (titres calculés en SQL) */
const frNum = (s: string) => s.replace(/(\d)\.(\d)/g, '$1,$2');
const CAT_SHORT: Record<HistoryRow['category'], string> = { piece: 'Pièce', rapport: 'CR', mesure: 'Mesure', visite: 'Visite' };

/** Version imprimable : registre technique A4 (identification, synthèse, points ouverts, registre chronologique, visas) */
function HistoryRegister({ d, rows, reports, zoneOf, todayIso, stats }: {
  d: DroneStatusRow; rows: HistoryRow[]; reports: ReportRow[]; zoneOf: (r: HistoryRow) => string | null; todayIso: string;
  stats: { montages: number; demontages: number; quarantaines: number; rapports: number; incidents: number; ouverts: number; mesures: number; visites: number;
    daysSafe: number | null; lastIncident: string | null; mtbr: number | null; avgDelay: number | null; closeRate: number };
}) {
  const open = reports.filter((r) => r.status !== 'clos').sort((a, b) => a.created_at.localeCompare(b.created_at));
  const toNext = Number(d.hours_to_next_visit);
  // registre : du plus ancien au plus récent, regroupé par mois
  const chrono = [...rows].reverse();
  const months: { key: string; label: string; items: HistoryRow[] }[] = [];
  for (const r of chrono) {
    const key = r.at.slice(0, 7);
    const last = months[months.length - 1];
    if (last?.key === key) last.items.push(r);
    else { const [y, m] = key.split('-').map(Number); months.push({ key, label: `${MONTHS[m - 1]} ${y}`, items: [r] }); }
  }
  return (
    <div className="hp print-only">
      {/* 1 · identification */}
      <section className="hp-block">
        <h2 className="hp-h"><span>1</span> Identification de l'aéronef</h2>
        <table className="hp-id">
          <tbody>
            <tr>
              <th>Immatriculation</th><td className="hp-big">{d.code}</td>
              <th>Modèle</th><td>{d.model}</td>
              <th>N° de série</th><td>{d.serial_number ?? '—'}</td>
            </tr>
            <tr>
              <th>Drone port</th><td>{d.drone_port_name ?? 'Non affecté'}</td>
              <th>Statut</th><td>{LABELS.droneStatus[d.status]}</td>
              <th>Vols</th><td>{d.flight_count}</td>
            </tr>
            <tr>
              <th>Heures totales</th><td className="hp-strong">{hours(d.total_hours)}</td>
              <th>Dernière visite</th><td>{d.last_visit_date ? `${date(d.last_visit_date)} · ${hours(d.last_visit_hours ?? 0)}` : 'Aucune'}</td>
              <th>Prochaine visite</th><td className={toNext <= 0 ? 'hp-danger' : toNext <= 25 ? 'hp-warn' : ''}>à {hours(d.next_visit_hours)} · {toNext <= 0 ? 'DÉPASSÉE' : `reste ${hours(toNext)}`}</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* 2 · synthèse */}
      <section className="hp-block">
        <h2 className="hp-h"><span>2</span> Synthèse de la période</h2>
        <table className="hp-kpi">
          <tbody>
            <tr>
              <td><b>{stats.montages}</b>montages</td>
              <td><b>{stats.demontages}</b>démontages{stats.quarantaines ? ` · ${stats.quarantaines} en quarantaine` : ''}</td>
              <td><b>{stats.rapports}</b>comptes rendus · {stats.incidents} incident(s)</td>
              <td className={stats.ouverts ? 'hp-warn' : ''}><b>{stats.ouverts}</b>ouvert(s)</td>
              <td><b>{stats.mesures}</b>mesures correctives</td>
              <td><b>{stats.visites}</b>visites</td>
            </tr>
            <tr className="hp-kpi-2">
              <td colSpan={2}>Jours sans incident : <b>{stats.daysSafe ?? '—'}</b>{stats.lastIncident ? ` (dernier le ${date(stats.lastIncident)})` : ''}</td>
              <td colSpan={2}>Heures de vol par compte rendu (MTBR) : <b>{stats.mtbr != null ? `${num(stats.mtbr, 1)} h` : '—'}</b></td>
              <td colSpan={2}>Clôture : <b>{Math.round(stats.closeRate * 100)} %</b> · délai moyen <b>{stats.avgDelay != null ? `${num(stats.avgDelay, 1)} j` : '—'}</b></td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* 3 · points ouverts */}
      <section className="hp-block">
        <h2 className="hp-h"><span>3</span> Points ouverts {open.length ? `(${open.length})` : ''}</h2>
        {open.length === 0 ? <p className="hp-ok">✓ Aucun compte rendu technique ou incident ouvert.</p> : (
          <table className="hp-table">
            <thead><tr><th>Ouvert le</th><th>Type</th><th>Composant</th><th>Constat</th><th>Gravité</th><th>Depuis</th></tr></thead>
            <tbody>
              {open.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">{date(r.created_at.slice(0, 10))}</td>
                  <td>{LABELS.reportType[r.report_type]}</td>
                  <td>{r.component ?? '—'}</td>
                  <td>{r.description}</td>
                  <td className={r.severity === 'critique' ? 'hp-danger' : r.severity === 'majeur' ? 'hp-warn' : ''}>{LABELS.severity[r.severity]}</td>
                  <td className="nowrap">{daysBetween(r.created_at.slice(0, 10), todayIso)} j</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 4 · registre chronologique */}
      <section className="hp-block hp-register">
        <h2 className="hp-h"><span>4</span> Registre chronologique ({rows.length} événement{rows.length > 1 ? 's' : ''})</h2>
        {rows.length === 0 ? <p className="hp-ok">Aucun événement pour la sélection.</p> : (
          <table className="hp-table hp-reg">
            <colgroup><col style={{ width: '15%' }} /><col style={{ width: '8%' }} /><col style={{ width: '24%' }} /><col /><col style={{ width: '11%' }} /><col style={{ width: '13%' }} /></colgroup>
            <thead><tr><th>Date</th><th>Type</th><th>Événement</th><th>Détail · mesure · motif</th><th>Gravité / statut</th><th>Intervenant</th></tr></thead>
            {months.map((m) => (
              <tbody key={m.key}>
                <tr className="hp-month"><td colSpan={6}>{m.label} · {m.items.length} événement{m.items.length > 1 ? 's' : ''}</td></tr>
                {m.items.map((r, i) => {
                  const z = zoneOf(r);
                  return (
                    <tr key={i} className={`hp-row c-${r.category}${r.category === 'rapport' && r.event === 'incident' ? ' is-incident' : ''}`}>
                      <td className="nowrap">{fmtDateTime(r.at, r.category === 'visite' || r.category === 'mesure')}</td>
                      <td><span className={`hp-tag c-${r.category}`}>{CAT_SHORT[r.category]}</span></td>
                      <td><strong>{frNum(r.title)}</strong>{z && <div className="hp-sub">{zoneLabel(z)}</div>}</td>
                      <td>{r.detail ?? '—'}{r.note && <div className="hp-sub">{r.category === 'piece' ? `Motif : ${r.note}` : r.note}</div>}
                        {r.category === 'piece' && r.hours != null && <div className="hp-sub">{hours(Number(r.hours))} de vol sur {d.code}</div>}</td>
                      <td>{r.severity ? LABELS.severity[r.severity] : ''}{r.category === 'rapport' && r.status ? <div className={r.status === 'clos' ? 'hp-sub' : 'hp-sub hp-warn'}>{LABELS.reportStatus[r.status]}</div> : null}</td>
                      <td>{r.actor ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        )}
      </section>

      {/* 5 · visas */}
      <section className="hp-block hp-visas">
        <h2 className="hp-h"><span>5</span> Visas</h2>
        <div className="hp-signs">
          {['Établi par', 'Responsable maintenance'].map((t) => (
            <div key={t} className="hp-sign">
              <span>{t}</span>
              <div>Nom :</div>
              <div>Date :</div>
              <div className="hp-sign-area">Signature</div>
            </div>
          ))}
        </div>
        <p className="hp-cert">Document extrait de UAV Maintenance. Il reprend les montages et démontages de pièces, les comptes rendus techniques et incidents, les mesures correctives et les visites de maintenance enregistrés pour cet aéronef.</p>
      </section>
    </div>
  );
}

/** Historique technique d'un drone : carte des interventions, bilan de fiabilité, ruban de vie et journal. */
export default function DroneHistory() {
  const { id } = useParams() as { id: string };
  const [filter, setFilter] = useState<Filter>('tout');
  const [zone, setZone] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [year, setYear] = useState('');

  const { data, error, loading } = useData(async () => {
    const d = unwrap(await supabase.from('v_drone_status').select('*').eq('id', id).single()) as DroneStatusRow;
    const [h, s, r, f] = await Promise.all([
      supabase.rpc('drone_history', { p_drone: id }),
      supabase.from('drone_slots').select('code, zone, label').eq('model', d.model),
      supabase.from('v_reports').select('*').eq('drone_id', id).limit(2000),
      supabase.from('v_flights').select('flight_date, duration_min').eq('drone_id', id).limit(10000),
    ]);
    return {
      drone: d, rows: unwrap(h) as HistoryRow[], slots: (unwrap(s) ?? []) as SlotRow[],
      reports: (unwrap(r) ?? []) as ReportRow[], flights: (unwrap(f) ?? []) as { flight_date: string; duration_min: number | null }[],
    };
  }, [id]);

  /** zone de chaque événement */
  const zoneOf = useMemo(() => {
    const byLabel = new Map((data?.slots ?? []).map((s) => [s.label, s.zone]));
    const byCode = new Map((data?.slots ?? []).map((s) => [s.code, s.zone]));
    return (r: HistoryRow): string | null => {
      if (r.category === 'piece') return (r.slot_label && (byLabel.get(r.slot_label) ?? byCode.get(r.slot_label))) || componentZone(r.slot_label);
      if (r.category === 'rapport' || r.category === 'mesure') return componentZone(titleComponent(r.title));
      return null;
    };
  }, [data]);

  const rows = useMemo(() => (data?.rows ?? []).filter((r) =>
    (filter === 'tout' || (filter === 'rapport' ? r.category === 'rapport' || r.category === 'mesure' : r.category === filter)) &&
    (!zone || zoneOf(r) === zone) &&
    (!year || r.at.startsWith(year)) &&
    (!q || `${r.title} ${r.detail ?? ''} ${r.note ?? ''} ${r.actor ?? ''}`.toLowerCase().includes(q.toLowerCase()))), [data, filter, zone, zoneOf, q, year]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const { drone: d, reports, flights } = data;
  const all = data.rows;
  const todayIso = iso(new Date());
  const years = Array.from(new Set(all.map((r) => r.at.slice(0, 4)))).sort().reverse();
  const n = (fn: (r: HistoryRow) => boolean) => all.filter(fn).length;
  const openReports = reports.filter((r) => r.status !== 'clos').length;

  // ---- carte des interventions : activité par zone ----
  const zoneStats = new Map<string, { count: number; open: number; sev: number }>();
  let unlocated = 0;
  for (const r of all) {
    if (r.category === 'mesure' || r.category === 'visite') continue;
    const z = zoneOf(r);
    if (!z) { unlocated++; continue; }
    const s = zoneStats.get(z) ?? { count: 0, open: 0, sev: 0 };
    s.count++;
    if (r.category === 'rapport' && r.status !== 'clos') s.open++;
    if (r.severity) s.sev = Math.max(s.sev, SEV_RANK[r.severity]);
    zoneStats.set(z, s);
  }
  const topZone = [...zoneStats.entries()].sort((a, b) => b[1].count - a[1].count)[0];

  // ---- bilan de fiabilité ----
  const incidents = reports.filter((r) => r.report_type === 'incident');
  const lastIncident = incidents.map((r) => localDay(r.created_at)).sort().pop() ?? null;
  const firstFlight = flights.map((f) => f.flight_date).sort()[0] ?? null;
  const daysSafe = lastIncident ? daysBetween(lastIncident, todayIso) : firstFlight ? daysBetween(firstFlight, todayIso) : null;
  const closed = reports.filter((r) => r.status === 'clos' && r.resolved_on);
  const delays = closed.map((r) => Math.max(0, daysBetween(localDay(r.created_at), r.resolved_on!)));
  const avgDelay = delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null;
  const mtbr = reports.length ? Number(d.total_hours) / reports.length : null;
  const closeRate = reports.length ? closed.length / reports.length : 1;

  // ---- ruban de vie ----
  const starts = [...all.map((r) => localDay(r.at)), ...reports.map((r) => localDay(r.created_at)), ...flights.map((f) => f.flight_date)].sort();
  let from = starts[0] && starts[0] < addDays(todayIso, -120) ? starts[0] : addDays(todayIso, -120);
  from = from.slice(0, 8) + '01';
  const to = addDays(todayIso, 12);
  const span = Math.max(1, daysBetween(from, to));
  const pos = (s: string) => Math.min(100, Math.max(0, (daysBetween(from, s) / span) * 100));
  const ticks: { at: string; label: string }[] = [];
  for (let m = parseIso(from); iso(m) <= to; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
    ticks.push({ at: iso(m), label: m.getMonth() === 0 ? `${MONTHS_SHORT[0]} ${String(m.getFullYear()).slice(2)}` : MONTHS_SHORT[m.getMonth()] });
  }
  // activité : heures de vol par semaine
  const weeks = new Map<number, number>();
  for (const f of flights) {
    if (f.flight_date < from) continue;
    const w = Math.floor(daysBetween(from, f.flight_date) / 7);
    weeks.set(w, (weeks.get(w) ?? 0) + Number(f.duration_min ?? 0) / 60);
  }
  const maxWeek = Math.max(0.1, ...weeks.values());
  const weekPct = (7 / span) * 100;

  // délai de résolution d'un compte rendu (pour le journal)
  const reportDelay = (r: HistoryRow) => {
    const m = reports.find((x) => x.description === r.detail && `/vols/${x.flight_id}` === r.link);
    if (!m) return null;
    return m.status === 'clos' && m.resolved_on
      ? `résolu en ${Math.max(0, daysBetween(localDay(m.created_at), m.resolved_on))} j`
      : `ouvert depuis ${daysBetween(localDay(m.created_at), todayIso)} j`;
  };

  // regroupement par mois
  const groups: { key: string; label: string; items: HistoryRow[] }[] = [];
  for (const r of rows) {
    const key = r.at.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last?.key === key) last.items.push(r);
    else { const [y, m] = key.split('-').map(Number); groups.push({ key, label: `${MONTHS[m - 1]} ${y}`, items: [r] }); }
  }

  function exportCsv() {
    download(`historique_${d.code}.csv`, toCsv(rows.map((r) => ({
      date: fmtDateTime(r.at, r.category === 'visite'), categorie: CAT[r.category].label, zone: zoneOf(r) ? zoneLabel(zoneOf(r)) : null,
      intitule: r.title, detail: r.detail, complement: r.note,
      gravite: r.severity ? LABELS.severity[r.severity] : null, statut: r.status ? LABELS.reportStatus[r.status] : null,
      heures_sur_drone: r.category === 'piece' ? r.hours : null, par: r.actor,
    }))));
  }

  const tabs: { k: Filter; label: string; count: number }[] = [
    { k: 'tout', label: 'Tout', count: all.length },
    { k: 'piece', label: 'Pièces', count: n((r) => r.category === 'piece') },
    { k: 'rapport', label: 'Rapports & mesures', count: n((r) => r.category === 'rapport' || r.category === 'mesure') },
    { k: 'visite', label: 'Visites', count: n((r) => r.category === 'visite') },
  ];

  const filterLabel = [tabs.find((t) => t.k === filter)!.label, zone ? zoneLabel(zone) : null, year || 'toutes années', q ? `« ${q} »` : null].filter(Boolean).join(' · ');
  const now = new Date();
  const ringC = 2 * Math.PI * 26;

  return (
    <div className="history-page hp-doc">
      {/* En-tête imprimé uniquement */}
      <header className="doc-head print-only">
        <UavLogo className="doc-logo doc-logo-uav" width="56mm" />
        <div className="doc-title">
          <div className="doc-org">UNFPA Madagascar · Livraison par drones</div>
          <h1>Historique technique</h1>
          <div className="doc-sub">Drone <strong>{d.code}</strong> · {d.model}{d.serial_number ? ` · S/N ${d.serial_number}` : ''} · {d.drone_port_name ?? 'Non affecté'}</div>
        </div>
        <dl className="doc-ref">
          <div><dt>Heures de vol</dt><dd>{hours(d.total_hours)}</dd></div>
          <div><dt>Sélection</dt><dd>{filterLabel}</dd></div>
          <div><dt>Événements</dt><dd>{rows.length}</dd></div>
          <div><dt>Édité le</dt><dd>{now.toLocaleDateString('fr-FR')}</dd></div>
        </dl>
      </header>

      <PageHeader
        title={<>Historique technique · {d.code}</>}
        subtitle={<>{d.model}{d.serial_number ? ` · S/N ${d.serial_number}` : ''} · {d.drone_port_name ?? 'Non affecté'} · {hours(d.total_hours)} de vol</>}
        actions={<>
          <Link className="btn" to={`/drones/${d.id}`}>← Fiche drone</Link>
          <button className="btn" onClick={exportCsv} disabled={!rows.length}>⇩ CSV</button>
          <button className="btn" onClick={() => window.print()}>⎙ Imprimer</button>
        </>}
      />

      {/* registre technique (impression) */}
      <HistoryRegister d={d} rows={rows} reports={reports} zoneOf={zoneOf} todayIso={todayIso}
        stats={{
          montages: n((r) => r.event === 'montage'), demontages: n((r) => r.event === 'demontage'), quarantaines: n((r) => r.event === 'quarantaine'),
          rapports: reports.length, incidents: incidents.length, ouverts: openReports, mesures: n((r) => r.category === 'mesure'), visites: n((r) => r.category === 'visite'),
          daysSafe, lastIncident, mtbr, avgDelay, closeRate,
        }} />

      {/* ===== Carte des interventions + bilan de fiabilité ===== */}
      <section className="th-hero no-print">
        <div className="th-map">
          <div className="th-map-head">
            <div>
              <h2>Carte des interventions</h2>
              <p>Pièces changées et comptes rendus, localisés sur le drone. Cliquez sur une zone pour filtrer le journal.</p>
            </div>
            {zone && <button type="button" className="btn btn-sm" onClick={() => setZone(null)}>✕ {zoneLabel(zone)}</button>}
          </div>
          <div className="th-plane">
            <img src="./tango4.png" alt={`Drone ${d.code}`} />
            {TANGO4_ZONES.map((z) => {
              const s = zoneStats.get(z.code);
              const cls = !s ? 'idle' : s.open ? 'open' : s.sev >= 2 ? 'warn' : 'used';
              const size = s ? 26 + Math.min(s.count, 6) * 5 : 14;
              return (
                <button key={z.code} type="button" className={`th-spot sp-${cls}${zone === z.code ? ' active' : ''}${zone && zone !== z.code ? ' dim' : ''}`}
                  style={{ left: `${z.x}%`, top: `${z.y}%`, width: size, height: size }}
                  onClick={() => setZone(zone === z.code ? null : z.code)}
                  aria-label={`${z.label} : ${s?.count ?? 0} intervention(s)`}>
                  {s && <b>{s.count}</b>}
                  <span className="th-tip"><strong>{z.label}</strong>{s ? `${s.count} intervention(s)${s.open ? ` · ${s.open} ouvert(s)` : ''}` : 'aucune intervention'}</span>
                </button>
              );
            })}
          </div>
          <div className="th-map-legend">
            <span><i className="sp-used" /> intervention(s)</span>
            <span><i className="sp-warn" /> gravité majeure ou critique</span>
            <span><i className="sp-open" /> compte rendu ouvert</span>
            {unlocated > 0 && <span className="muted">· {unlocated} non localisé(s)</span>}
          </div>
        </div>

        <div className="th-health">
          <div className={`th-safe${lastIncident && daysSafe != null && daysSafe < 7 ? ' recent' : ''}`}>
            <span className="th-safe-label">Jours sans incident</span>
            <div className="th-digits" aria-label={daysSafe != null ? `${daysSafe} jours` : 'aucun vol'}>
              {(daysSafe != null ? String(daysSafe).padStart(3, '0') : '---').split('').map((c, i) => <span key={i}>{c}</span>)}
            </div>
            <span className="th-safe-sub">{lastIncident ? `dernier incident le ${parseIso(lastIncident).toLocaleDateString('fr-FR')}` : firstFlight ? 'aucun incident depuis le premier vol' : 'aucun vol enregistré'}</span>
          </div>
          <div className="th-metrics">
            <div className="th-metric">
              <svg viewBox="0 0 64 64" className="th-ring" aria-hidden>
                <circle cx="32" cy="32" r="26" className="tr-track" />
                <circle cx="32" cy="32" r="26" className="tr-value" strokeDasharray={`${ringC * closeRate} ${ringC}`} transform="rotate(-90 32 32)" />
                <text x="32" y="37" textAnchor="middle">{Math.round(closeRate * 100)}%</text>
              </svg>
              <div><strong>Taux de clôture</strong><span>{closed.length} / {reports.length} compte(s) rendu(s)</span></div>
            </div>
            <div className="th-metric">
              <span className="th-metric-icon"><Icon name="flight" size={18} /></span>
              <div><strong>{mtbr != null ? `${num(mtbr, 1)} h` : '—'}</strong><span>{mtbr != null ? 'de vol par compte rendu (MTBR)' : 'aucun compte rendu'}</span></div>
            </div>
            <div className="th-metric">
              <span className="th-metric-icon"><Icon name="clock" size={18} /></span>
              <div><strong>{avgDelay != null ? `${num(avgDelay, avgDelay < 10 ? 1 : 0)} j` : '—'}</strong><span>délai moyen de résolution</span></div>
            </div>
            <div className="th-metric">
              <span className="th-metric-icon"><Icon name="pin" size={18} /></span>
              <div><strong>{topZone ? zoneLabel(topZone[0]).replace(/\s*\(.*\)$/, '') : '—'}</strong><span>{topZone ? `zone la plus sollicitée · ${topZone[1].count} intervention(s)` : 'aucune intervention localisée'}</span></div>
            </div>
          </div>
        </div>
      </section>

      {/* ===== Ruban de vie ===== */}
      <section className="card lifeline no-print">
        <div className="ll-head">
          <h2>Ruban de vie</h2>
          <p className="muted small">Activité de vol, pièces, comptes rendus (durée jusqu'à la résolution) et visites, du {parseIso(from).toLocaleDateString('fr-FR')} à aujourd'hui.</p>
        </div>
        <div className="ll-grid">
          <div className="ll-months">
            {ticks.map((t) => <span key={t.at} style={{ left: `${pos(t.at)}%` }}>{t.label}</span>)}
          </div>
          {([
            ['Activité', 'flight', 'act'], ['Pièces', 'chip', 'piece'], ['Comptes rendus', 'alert', 'rapport'], ['Visites', 'wrench', 'visite'],
          ] as [string, IconName, string][]).map(([label, icon, lane]) => (
            <div key={lane} className="ll-row">
              <span className="ll-label"><Icon name={icon} size={14} /> {label}</span>
              <div className={`ll-track ll-${lane}`}>
                {ticks.map((t) => <i key={t.at} className="ll-tick" style={{ left: `${pos(t.at)}%` }} />)}
                <i className="ll-today" style={{ left: `${pos(todayIso)}%` }} />
                {lane === 'act' && [...weeks.entries()].map(([w, h]) => (
                  <span key={w} className="ll-week" style={{ left: `${(w * weekPct)}%`, width: `calc(${weekPct}% - 2px)`, height: `${Math.max(10, Math.sqrt(h / maxWeek) * 100)}%` }}
                    title={`Semaine du ${parseIso(addDays(from, w * 7)).toLocaleDateString('fr-FR')} : ${num(h, 1)} h de vol`} />
                ))}
                {lane === 'piece' && all.filter((r) => r.category === 'piece').map((r, i) => (
                  <span key={i} className={`ll-dot ev-${r.event}`} style={{ left: `${pos(localDay(r.at))}%` }} title={`${fmtDateTime(r.at, false)} · ${r.title}${r.slot_label ? ` · ${r.slot_label}` : ''}`} />
                ))}
                {lane === 'rapport' && reports.map((r) => {
                  const start = localDay(r.created_at);
                  const end = r.status === 'clos' && r.resolved_on ? r.resolved_on : todayIso;
                  return (
                    <Link key={r.id} to={`/vols/${r.flight_id}`} className={`ll-bar sev-${r.severity}${r.status !== 'clos' ? ' is-open' : ''}${r.report_type === 'incident' ? ' is-incident' : ''}`}
                      style={{ left: `${pos(start)}%`, width: `max(10px, ${pos(end) - pos(start)}%)` }}
                      title={`${r.report_type === 'incident' ? 'Incident' : 'Report technique'}${r.component ? ` · ${r.component}` : ''} · ${LABELS.severity[r.severity]} · ${r.status === 'clos' ? `résolu en ${Math.max(0, daysBetween(start, end))} j` : `ouvert depuis ${daysBetween(start, todayIso)} j`}`} />
                  );
                })}
                {lane === 'visite' && all.filter((r) => r.category === 'visite').map((r, i) => (
                  <span key={i} className={`ll-diamond ev-${r.event}`} style={{ left: `${pos(localDay(r.at))}%` }} title={`${fmtDateTime(r.at, true)} · ${r.title}`} />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="ll-legend small muted">
          <span><i className="lg-montage" /> montage</span><span><i className="lg-demontage" /> démontage</span><span><i className="lg-quarantaine" /> quarantaine</span>
          <span><i className="lg-bar" /> compte rendu → résolution</span><span><i className="lg-open" /> encore ouvert</span><span><i className="lg-visit" /> visite</span>
        </div>
      </section>

      {/* ===== Journal ===== */}
      <div className="card filters no-print">
        <div className="segmented segmented-sm" role="tablist" aria-label="Type d'événement">
          {tabs.map((t) => (
            <button key={t.k} type="button" role="tab" aria-selected={filter === t.k} className={filter === t.k ? 'active' : ''} onClick={() => setFilter(t.k)}>
              {t.label} <span className="seg-count">{t.count}</span>
            </button>
          ))}
        </div>
        <label className="field"><span className="field-label">Zone</span>
          <select value={zone ?? ''} onChange={(e) => setZone(e.target.value || null)}>
            <option value="">Toutes</option>
            {TANGO4_ZONES.map((z) => <option key={z.code} value={z.code}>{z.label}</option>)}
          </select>
        </label>
        <label className="field"><span className="field-label">Année</span>
          <select value={year} onChange={(e) => setYear(e.target.value)}>
            <option value="">Toutes</option>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <label className="field field-grow"><span className="field-label">Recherche</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Code pièce, composant, mesure, technicien…" />
        </label>
      </div>

      {rows.length === 0 ? <Empty>Aucun événement{filter !== 'tout' || q || year || zone ? ' pour ces critères' : ' enregistré pour ce drone'}.</Empty> : (
        <section className="card history no-print">
          {groups.map((g) => (
            <div key={g.key} className="history-month">
              <h2 className="history-month-title">{g.label}<span className="muted small"> · {g.items.length} événement(s)</span></h2>
              <ol className="history-list">
                {g.items.map((r, i) => {
                  const dt = new Date(r.at);
                  const z = zoneOf(r);
                  const delay = r.category === 'rapport' ? reportDelay(r) : null;
                  return (
                    <li key={`${g.key}-${i}`} className={`history-item cat-${r.category} ev-${r.event}`}>
                      <span className="history-date" aria-hidden><b>{dt.getDate()}</b>{MONTHS_SHORT[dt.getMonth()]}</span>
                      <span className="history-dot" aria-hidden><Icon name={CAT[r.category].icon} size={15} /></span>
                      <div className="history-body">
                        <div className="history-head">
                          <span className="history-cat">{CAT[r.category].label}</span>
                          <strong>{r.link ? <Link to={r.link}>{frNum(r.title)}</Link> : frNum(r.title)}</strong>
                          {r.severity && <Badge level={sevLevel(r.severity)}>{LABELS.severity[r.severity]}</Badge>}
                          {r.category === 'rapport' && r.status && <Badge level={r.status === 'clos' ? 'ok' : 'warn'}>{LABELS.reportStatus[r.status]}</Badge>}
                          {delay && <span className={`history-delay${r.status !== 'clos' ? ' is-open' : ''}`}>{delay}</span>}
                        </div>
                        {r.detail && <div className="history-detail">{r.detail}</div>}
                        {r.note && <div className="small muted">{r.category === 'piece' ? `Motif : ${r.note}` : r.note}</div>}
                        <div className="history-meta small muted">
                          <span>{fmtDateTime(r.at, r.category === 'visite' || r.category === 'mesure')}</span>
                          {z && <button type="button" className="history-zone" onClick={() => setZone(z)}><Icon name="pin" size={11} /> {zoneLabel(z)}</button>}
                          {r.category === 'piece' && r.hours != null && <span>{hours(Number(r.hours))} de vol sur {d.code}</span>}
                          {r.actor && <span>{r.category === 'mesure' ? 'clôturé par ' : r.category === 'visite' ? 'technicien : ' : 'par '}{r.actor}</span>}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </section>
      )}
      <footer className="doc-foot print-only">
        <span>Historique technique · {d.code} · {d.model}</span>
        <span>UAV Maintenance · UNFPA Madagascar · édité le {now.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</span>
      </footer>
    </div>
  );
}
