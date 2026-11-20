import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { useData } from '../lib/useData';
import { byPort, useApp } from '../lib/app';
import type { Drone, ReportRow, ReportStatus, Severity } from '../lib/types';
import { date, LABELS } from '../lib/format';
import { Badge, Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { Icon } from '../components/icons';
import ReportModal from '../components/ReportModal';

type View = 'suivi' | 'liste';
const SEV_ORDER: Record<Severity, number> = { critique: 0, majeur: 1, mineur: 2 };
const COLUMNS: { key: ReportStatus; title: string; hint: string }[] = [
  { key: 'ouvert', title: 'Ouvert', hint: 'À prendre en charge' },
  { key: 'en_cours', title: 'En cours', hint: 'Mesure corrective en cours' },
  { key: 'clos', title: 'Clos', hint: 'Mesure corrective réalisée' },
];
const CLOSED_SHOWN = 8;
const daysSince = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
const ageText = (d: number) => (d === 0 ? "aujourd'hui" : d === 1 ? 'depuis 1 jour' : `depuis ${d} jours`);
const readView = (): View => { try { return localStorage.getItem('uav.reportsView') === 'liste' ? 'liste' : 'suivi'; } catch { return 'suivi'; } };

export default function Reports() {
  const { portFilter, isAdmin } = useApp();
  const [view, setViewState] = useState<View>(readView);
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem('uav.reportsView', v); } catch { /* sans stockage */ } };
  const [type, setType] = useState('');
  const [severity, setSeverity] = useState('');
  const [droneId, setDroneId] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('open'); // vue liste
  const [showAllClosed, setShowAllClosed] = useState(false);
  const [editing, setEditing] = useState<ReportRow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const drones = useData(async () => unwrap(await byPort(supabase.from('drones').select('*'), portFilter).order('code')) as Drone[], [portFilter]);
  const { data, error, loading, reload } = useData(async () => {
    let qq = byPort(supabase.from('v_reports').select('*'), portFilter).order('created_at', { ascending: false }).limit(1000);
    if (droneId) qq = qq.eq('drone_id', droneId);
    return unwrap(await qq) as ReportRow[];
  }, [portFilter, droneId]);

  const all = data ?? [];
  // filtres communs (type, gravité, recherche)
  const filtered = useMemo(() => all.filter((r) =>
    (!type || r.report_type === type) && (!severity || r.severity === severity) &&
    (!q || `${r.component ?? ''} ${r.description} ${r.corrective_action ?? ''} ${r.drone_code} ${r.destination_name ?? ''}`.toLowerCase().includes(q.toLowerCase()))), [all, type, severity, q]);

  // ---- chiffres clés (sur tous les rapports du périmètre)
  const k = useMemo(() => {
    const open = all.filter((r) => r.status !== 'clos');
    const closed = all.filter((r) => r.status === 'clos' && r.resolved_on);
    const delays = closed.map((r) => (new Date(`${r.resolved_on}T12:00:00`).getTime() - new Date(r.created_at).getTime()) / 86400000).filter((d) => d >= 0);
    const comp = new Map<string, number>();
    for (const r of all) if (r.component) comp.set(r.component, (comp.get(r.component) ?? 0) + 1);
    const topComp = [...comp].sort((a, b) => b[1] - a[1])[0];
    const oldest = open.reduce((m, r) => Math.max(m, daysSince(r.created_at)), 0);
    return {
      open: open.length, critical: open.filter((r) => r.severity === 'critique').length, majors: open.filter((r) => r.severity === 'majeur').length,
      incidents: all.filter((r) => r.report_type === 'incident').length, total: all.length,
      avgDelay: delays.length ? delays.reduce((s, d) => s + d, 0) / delays.length : null, closed: closed.length,
      topComp, oldest,
    };
  }, [all]);

  async function startProgress(r: ReportRow) {
    setActionError(null);
    try { unwrap(await supabase.from('technical_reports').update({ status: 'en_cours' }).eq('id', r.id)); reload(); }
    catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
  }

  const locked = (r: ReportRow) => r.status === 'clos' && !isAdmin;

  const card = (r: ReportRow) => {
    const age = daysSince(r.created_at);
    return (
      <article key={r.id} className={`rcard sev-${r.severity} rtype-${r.report_type}`}>
        <div className="rcard-head">
          <span className="rcard-type"><Icon name={r.report_type === 'incident' ? 'alert' : 'wrench'} size={14} /> {LABELS.reportType[r.report_type]}</span>
          <span className={`rcard-sev sev-${r.severity}`}>{LABELS.severity[r.severity]}</span>
        </div>
        <div className="rcard-meta">
          <strong><Icon name="drone" size={13} /> {r.drone_code}</strong>
          <Link to={`/vols/${r.flight_id}`}>vol du {date(r.flight_date)}</Link>
          {r.destination_name && <span className="muted">· {r.destination_name}</span>}
        </div>
        {r.component && <span className="rcard-comp">{r.component}</span>}
        <p className="rcard-text">{r.description}</p>
        {r.corrective_action && <p className="rcard-action"><Icon name="wrench" size={12} /> {r.corrective_action}</p>}
        <div className="rcard-foot">
          <span className={`rcard-age${r.status !== 'clos' && age > 7 ? ' is-old' : ''}`}>
            {r.status === 'clos' ? `Clos le ${date(r.resolved_on)}` : `Ouvert ${ageText(age)}`}
          </span>
          <span className="rcard-actions">
            {r.status === 'ouvert' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => startProgress(r)} title="Indiquer que la mesure corrective est en cours">→ En cours</button>}
            {locked(r)
              ? <span className="small muted" title="Seul un administrateur peut modifier un rapport clôturé">🔒</span>
              : <button type="button" className="btn btn-sm" onClick={() => setEditing(r)}>{r.status === 'clos' ? 'Modifier' : 'Traiter'}</button>}
          </span>
        </div>
      </article>
    );
  };

  const listRows = filtered.filter((r) => (status === 'open' ? r.status !== 'clos' : !status || r.status === status));

  return (
    <div className="reports-page">
      <PageHeader title="Rapports techniques & incidents" subtitle="Suivi des anomalies et des mesures correctives, tous vols confondus"
        actions={<div className="segmented segmented-sm" role="tablist" aria-label="Présentation">
          <button type="button" role="tab" aria-selected={view === 'suivi'} className={view === 'suivi' ? 'active' : ''} onClick={() => setView('suivi')}>Suivi</button>
          <button type="button" role="tab" aria-selected={view === 'liste'} className={view === 'liste' ? 'active' : ''} onClick={() => setView('liste')}>Liste</button>
        </div>} />

      {/* ---- chiffres clés ---- */}
      <div className="flight-kpis report-kpis">
        <div className={`fk${k.open ? ' fk-warn' : ' fk-ok'}`}><span className="fk-icon"><Icon name="alert" size={18} /></span>
          <div><strong>{k.open}</strong><span>{k.open ? `à traiter${k.oldest > 7 ? ` · le plus ancien ${k.oldest} j` : ''}` : 'tout est traité ✓'}</span></div></div>
        <div className={`fk${k.critical ? ' fk-danger' : ''}`}><span className="fk-icon"><Icon name="shield" size={18} /></span>
          <div><strong>{k.critical}</strong><span>critique(s) ouvert(s) · {k.majors} majeur(s)</span></div></div>
        <div className="fk"><span className="fk-icon"><Icon name="book" size={18} /></span>
          <div><strong>{k.total}</strong><span>rapport(s) · {k.incidents} incident(s)</span></div></div>
        <div className="fk"><span className="fk-icon"><Icon name="clock" size={18} /></span>
          <div><strong>{k.avgDelay != null ? `${k.avgDelay < 1 ? '< 1' : Math.round(k.avgDelay)} j` : '—'}</strong><span>délai moyen de clôture · {k.closed} clos</span></div></div>
        <div className="fk"><span className="fk-icon"><Icon name="wrench" size={18} /></span>
          <div><strong>{k.topComp?.[0] ?? '—'}</strong><span>{k.topComp ? `composant le plus touché · ${k.topComp[1]} rapport(s)` : 'aucun composant renseigné'}</span></div></div>
      </div>

      {/* ---- filtres ---- */}
      <div className="card filters report-filters">
        <div className="quick-filters" role="group" aria-label="Type">
          {[['', 'Tous'], ['technique', 'Reports techniques'], ['incident', 'Incidents']].map(([v, l]) => (
            <button key={v} type="button" className={`qf${type === v ? ' active' : ''}${v === 'incident' ? ' qf-qrf' : ''}`} aria-pressed={type === v} onClick={() => setType(v)}>{l}</button>
          ))}
        </div>
        <div className="quick-filters" role="group" aria-label="Gravité">
          {[['', 'Toutes gravités'], ['critique', 'Critique'], ['majeur', 'Majeur'], ['mineur', 'Mineur']].map(([v, l]) => (
            <button key={v} type="button" className={`qf qf-sev-${v || 'all'}${severity === v ? ' active' : ''}`} aria-pressed={severity === v} onClick={() => setSeverity(v)}>{l}</button>
          ))}
        </div>
        <label className="field"><span className="field-label">Drone</span>
          <select value={droneId} onChange={(e) => setDroneId(e.target.value)}>
            <option value="">Tous</option>
            {drones.data?.map((d) => <option key={d.id} value={d.id}>{d.code}</option>)}
          </select>
        </label>
        <label className="field field-grow"><span className="field-label">Recherche</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Composant, constat, mesure, CSB…" />
        </label>
      </div>

      <ErrorBox error={error ?? actionError} />
      {loading && !data ? <Loading /> : view === 'suivi' ? (
        <div className="board">
          {COLUMNS.map((c) => {
            let items = filtered.filter((r) => r.status === c.key);
            items = c.key === 'clos'
              ? items.sort((a, b) => (b.resolved_on ?? '').localeCompare(a.resolved_on ?? ''))
              : items.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.created_at.localeCompare(b.created_at));
            const total = items.length;
            if (c.key === 'clos' && !showAllClosed) items = items.slice(0, CLOSED_SHOWN);
            return (
              <section key={c.key} className={`board-col col-${c.key}`}>
                <header className="board-head">
                  <span className="board-dot" aria-hidden />
                  <strong>{c.title}</strong>
                  <span className="board-count">{total}</span>
                  <span className="small muted board-hint">{c.hint}</span>
                </header>
                <div className="board-list">
                  {items.length ? items.map(card) : <div className="board-empty">{c.key === 'clos' ? 'Aucun rapport clos.' : 'Rien ici. 👍'}</div>}
                  {c.key === 'clos' && total > CLOSED_SHOWN && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowAllClosed(!showAllClosed)}>
                      {showAllClosed ? 'Afficher les plus récents seulement' : `Afficher les ${total} rapports clos`}
                    </button>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <>
          <div className="quick-filters">
            {[['open', 'Non clos'], ['ouvert', 'Ouverts'], ['en_cours', 'En cours'], ['clos', 'Clos'], ['', 'Tous']].map(([v, l]) => (
              <button key={v} type="button" className={`qf${status === v ? ' active' : ''}`} aria-pressed={status === v} onClick={() => setStatus(v)}>{l}</button>
            ))}
          </div>
          {!listRows.length ? <Empty>Aucun rapport.</Empty> : (
            <div className="card no-pad">
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Vol</th><th>Drone</th><th>Type</th><th>Gravité</th><th>Composant</th><th>Constat</th><th>Mesure corrective</th><th>Statut</th><th></th></tr></thead>
                  <tbody>
                    {listRows.map((r) => (
                      <tr key={r.id}>
                        <td><Link to={`/vols/${r.flight_id}`}>{date(r.flight_date)}</Link><div className="small muted">{r.destination_name}</div></td>
                        <td><strong>{r.drone_code}</strong></td>
                        <td><Badge level={r.report_type === 'incident' ? 'danger' : 'info'}>{LABELS.reportType[r.report_type]}</Badge></td>
                        <td><Badge level={r.severity === 'critique' ? 'danger' : r.severity === 'majeur' ? 'warn' : 'neutral'}>{LABELS.severity[r.severity]}</Badge></td>
                        <td>{r.component ?? '—'}</td>
                        <td className="cell-text">{r.description}</td>
                        <td className="cell-text">{r.corrective_action ?? <span className="muted">—</span>}</td>
                        <td><Badge level={r.status === 'clos' ? 'ok' : 'warn'}>{LABELS.reportStatus[r.status]}</Badge>{r.resolved_on && <div className="small muted">{date(r.resolved_on)}</div>}</td>
                        <td>{locked(r)
                          ? <span className="small muted nowrap" title="Seul un administrateur peut modifier un rapport clôturé">🔒 Verrouillé</span>
                          : <button className="btn btn-sm" onClick={() => setEditing(r)}>Modifier</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
      <p className="muted small">Pour créer un rapport, ouvrez le vol concerné (fiche du vol ou CRM). Un rapport clôturé n'est plus modifiable que par un administrateur.</p>

      {editing && (
        <ReportModal flightId={editing.flight_id} report={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
      )}
    </div>
  );
}
