import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { byPort, useApp } from '../lib/app';
import { useData } from '../lib/useData';
import { date, time } from '../lib/format';
import { addDays, iso } from '../lib/stats';
import { crmArchivePath, dayRanks } from '../lib/crmArchive';
import { archiveSupported, archivedOn, elementToPdf, getArchiveRoot, markArchived, rememberedFolder, saveToArchive } from '../lib/localArchive';
import { Badge, Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { Icon } from '../components/icons';
import FlightCrm, { CrmReadyInfo } from './FlightCrm';

interface Row {
  id: string; flight_date: string; takeoff_time: string; drone_id: string; drone_code: string; destination_name: string | null;
  flight_type: string; status: string; qrf: boolean; pilot_names: string | null; drone_port_name: string | null;
}

/** Lundi et dimanche de la semaine contenant `d` */
function weekOf(d: string) {
  const day = (new Date(`${d}T12:00:00`).getDay() + 6) % 7;
  const mon = addDays(d, -day);
  return { from: mon, to: addDays(mon, 6) };
}
function monthOf(d: string) {
  const [y, m] = d.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${y}-${String(m).padStart(2, '0')}-01`, to: `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}` };
}
const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

type Job = { total: number; done: number; ok: number; current: string | null; errors: { label: string; msg: string }[]; cancelled: boolean; finished: boolean; lastPath: string | null };

export default function CrmExport() {
  const { portFilter } = useApp();
  const todayIso = iso(new Date());
  const [period, setPeriod] = useState(() => weekOf(todayIso));
  const [drone, setDrone] = useState('');
  const [onlyClosed, setOnlyClosed] = useState(true);
  const [onlySigned, setOnlySigned] = useState(false);
  const [hideDone, setHideDone] = useState(false);
  const [sel, setSel] = useState<Set<string> | null>(null); // null = tout sélectionné par défaut
  const [job, setJob] = useState<Job | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const waiter = useRef<((v: { el: HTMLElement; info: CrmReadyInfo }) => void) | null>(null);
  const cancel = useRef(false);

  useEffect(() => { rememberedFolder().then(setFolder); }, [job?.finished]);

  const { data, error, loading } = useData(async () => {
    const [fl, all] = await Promise.all([
      byPort(supabase.from('v_flights').select('id, flight_date, takeoff_time, drone_id, drone_code, destination_name, flight_type, status, qrf, pilot_names, drone_port_name'), portFilter)
        .gte('flight_date', period.from).lte('flight_date', period.to).order('flight_date').order('takeoff_time').limit(2000),
      supabase.from('flights').select('id, drone_id, flight_date, takeoff_time, created_at').gte('flight_date', period.from).lte('flight_date', period.to).limit(5000),
    ]);
    const rows = unwrap(fl) as Row[];
    const ids = rows.map((r) => r.id);
    const sigs: { flight_id: string; kind: string }[] = [], crew: { flight_id: string; role: string }[] = [], reps: { flight_id: string }[] = [];
    for (const part of chunk(ids, 80)) {
      const [s, c, r] = await Promise.all([
        supabase.from('crm_signatures').select('flight_id, kind').in('flight_id', part),
        supabase.from('flight_pilots').select('flight_id, role').in('flight_id', part),
        supabase.from('technical_reports').select('flight_id').in('flight_id', part),
      ]);
      sigs.push(...(unwrap(s) as typeof sigs)); crew.push(...(unwrap(c) as typeof crew)); reps.push(...(unwrap(r) as typeof reps));
    }
    const visas = new Map<string, { signed: number; expected: number }>();
    for (const id of ids) {
      const expected = 1 + (crew.some((x) => x.flight_id === id && x.role === 'copilote') ? 1 : 0) + (reps.some((x) => x.flight_id === id) ? 1 : 0);
      visas.set(id, { signed: new Set(sigs.filter((x) => x.flight_id === id).map((x) => x.kind)).size, expected });
    }
    return { rows, ranks: dayRanks(unwrap(all) as { id: string; drone_id: string; flight_date: string; takeoff_time: string; created_at: string }[]), visas };
  }, [period.from, period.to, portFilter]);

  const drones = useMemo(() => Array.from(new Map((data?.rows ?? []).map((r) => [r.drone_id, r.drone_code])).entries()).sort((a, b) => a[1].localeCompare(b[1])), [data]);
  const rows = (data?.rows ?? []).filter((r) => (!drone || r.drone_id === drone) && (!onlyClosed || r.status === 'cloture')
    && (!onlySigned || (data!.visas.get(r.id)?.signed ?? 0) >= (data!.visas.get(r.id)?.expected ?? 1))
    && (!hideDone || !archivedOn(r.id)));
  const isSel = (id: string) => (sel ? sel.has(id) : true);
  const picked = rows.filter((r) => isSel(r.id));
  const toggle = (id: string) => setSel((cur) => { const s = new Set(cur ?? rows.map((r) => r.id)); if (s.has(id)) s.delete(id); else s.add(id); return s; });
  const toggleAll = () => setSel(picked.length === rows.length ? new Set() : null);

  const onReady = useCallback((el: HTMLElement, info: CrmReadyInfo) => { waiter.current?.({ el, info }); }, []);
  const renderCrm = (id: string) => new Promise<{ el: HTMLElement; info: CrmReadyInfo }>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('délai dépassé pour afficher le CRM')), 45000);
    waiter.current = (v) => { clearTimeout(t); waiter.current = null; resolve(v); };
    setCurrent(id);
  });

  async function run(forcePick = false) {
    if (!picked.length || !data) return;
    if (!archiveSupported() && !window.confirm(`Votre navigateur ne permet pas de créer les dossiers : les ${picked.length} PDF seront téléchargés un par un. Continuer ?`)) return;
    let root;
    try { root = archiveSupported() ? await getArchiveRoot(forcePick) : undefined; } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      throw e;
    }
    cancel.current = false;
    const list = [...picked];
    const state: Job = { total: list.length, done: 0, ok: 0, current: null, errors: [], cancelled: false, finished: false, lastPath: null };
    setJob({ ...state });
    for (const r of list) {
      if (cancel.current) { state.cancelled = true; break; }
      const label = `${r.drone_code} · ${date(r.flight_date)} ${time(r.takeoff_time)}`;
      state.current = label; setJob({ ...state });
      try {
        const { el, info } = await renderCrm(r.id);
        const { segments, fileName } = crmArchivePath({
          droneCode: r.drone_code, flightDate: r.flight_date, takeoff: r.takeoff_time, destination: r.destination_name,
          flightType: r.flight_type, rank: data.ranks.get(r.id) ?? 1, crmNo: info.crmNo, closed: info.closed,
        });
        const blob = await elementToPdf(el);
        const res = await saveToArchive(segments, fileName, blob, false, root);
        markArchived(r.id);
        state.ok++; state.lastPath = res.path;
      } catch (e) {
        state.errors.push({ label, msg: e instanceof Error ? e.message : String(e) });
      }
      state.done++; setJob({ ...state });
    }
    setCurrent(null);
    state.current = null; state.finished = true;
    setJob({ ...state });
  }

  const running = !!job && !job.finished;
  const quick: [string, { from: string; to: string }][] = [
    ['Semaine en cours', weekOf(todayIso)],
    ['Semaine dernière', weekOf(addDays(todayIso, -7))],
    ['Mois en cours', monthOf(todayIso)],
    ['Mois dernier', monthOf(addDays(monthOf(todayIso).from, -1))],
  ];
  const setRange = (r: { from: string; to: string }) => { setPeriod(r); setSel(null); setJob(null); };

  return (
    <div className="export-page">
      <PageHeader title="Export des CRM" subtitle="Enregistre plusieurs comptes rendus matériels en PDF, classés Drone / Année / Mois / Jour / Vol"
        actions={<Link className="btn" to="/vols">← Vols</Link>} />

      <section className="card export-period">
        <div className="export-quick">
          {quick.map(([l, r]) => (
            <button key={l} type="button" className={`rf-chip${period.from === r.from && period.to === r.to ? ' active' : ''}`} onClick={() => setRange(r)} disabled={running}>{l}</button>
          ))}
        </div>
        <div className="export-range">
          <label className="field"><span className="field-label">Du</span>
            <input type="date" value={period.from} max={period.to} disabled={running} onChange={(e) => e.target.value && setRange({ ...period, from: e.target.value })} /></label>
          <span className="export-arrow">→</span>
          <label className="field"><span className="field-label">Au</span>
            <input type="date" value={period.to} min={period.from} disabled={running} onChange={(e) => e.target.value && setRange({ ...period, to: e.target.value })} /></label>
          <label className="field"><span className="field-label">Drone</span>
            <select value={drone} onChange={(e) => { setDrone(e.target.value); setSel(null); }} disabled={running}>
              <option value="">Tous</option>
              {drones.map(([id, code]) => <option key={id} value={id}>{code}</option>)}
            </select></label>
          <div className="export-toggles">
            <label className="check"><input type="checkbox" checked={onlyClosed} onChange={(e) => { setOnlyClosed(e.target.checked); setSel(null); }} disabled={running} /> Vols clôturés uniquement</label>
            <label className="check"><input type="checkbox" checked={onlySigned} onChange={(e) => { setOnlySigned(e.target.checked); setSel(null); }} disabled={running} /> Entièrement signés uniquement</label>
            <label className="check"><input type="checkbox" checked={hideDone} onChange={(e) => { setHideDone(e.target.checked); setSel(null); }} disabled={running} /> Masquer les CRM déjà enregistrés</label>
          </div>
        </div>
      </section>

      <ErrorBox error={error} />

      <section className="card export-action">
        <div className="export-summary">
          <strong>{picked.length}</strong>
          <span>CRM sélectionné(s) sur {rows.length} · du {date(period.from)} au {date(period.to)}</span>
          <span className="small muted">{archiveSupported()
            ? folder ? <>Destination : <b>{folder}</b> › UAV Maintenance - CRM › Drone › Année › Mois › Jour › Vol</> : 'Vous choisirez le dossier de destination au premier enregistrement (par exemple un dossier « Archives » sur le Bureau).'
            : 'Navigateur sans création de dossiers : les PDF seront téléchargés (utilisez Chrome ou Edge sur ordinateur pour le classement automatique).'}</span>
        </div>
        <div className="export-buttons">
          {running
            ? <button className="btn btn-danger" onClick={() => { cancel.current = true; }}>Arrêter</button>
            : <>
              {archiveSupported() && folder && <button type="button" className="link-btn" onClick={() => run(true)} disabled={!picked.length}>changer de dossier</button>}
              <button className="btn btn-primary" onClick={() => run()} disabled={!picked.length}><Icon name="box" size={15} /> Enregistrer {picked.length} CRM</button>
            </>}
        </div>
        {job && (
          <div className={`export-progress${job.finished ? ' is-done' : ''}`}>
            <div className="export-bar"><i style={{ width: `${(100 * job.done) / Math.max(1, job.total)}%` }} /></div>
            <div className="small">
              {job.finished
                ? <>{job.cancelled ? 'Arrêté : ' : '✓ Terminé : '}<b>{job.ok}</b> CRM enregistré(s){job.errors.length ? `, ${job.errors.length} en erreur` : ''}.{job.lastPath && <> Dernier fichier : <code>{job.lastPath}</code></>}</>
                : <>{job.done} / {job.total} · en cours : <b>{job.current}</b></>}
            </div>
            {job.errors.length > 0 && <ul className="export-errors">{job.errors.map((e, i) => <li key={i}><b>{e.label}</b> : {e.msg}</li>)}</ul>}
          </div>
        )}
      </section>

      {loading && !data ? <Loading /> : rows.length === 0 ? <Empty>Aucun vol {onlyClosed ? 'clôturé ' : ''}sur cette période.</Empty> : (
        <div className="card no-pad">
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th className="col-check"><input type="checkbox" aria-label="Tout sélectionner" checked={picked.length === rows.length} onChange={toggleAll} disabled={running} /></th>
                <th>Date</th><th>Drone</th><th>Vol du jour</th><th>Destination</th><th>Équipage</th><th>Visas</th><th>Statut</th><th>Enregistré</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => {
                  const v = data!.visas.get(r.id) ?? { signed: 0, expected: 1 };
                  const done = archivedOn(r.id);
                  return (
                    <tr key={r.id} className={isSel(r.id) ? '' : 'row-muted'}>
                      <td className="col-check"><input type="checkbox" checked={isSel(r.id)} onChange={() => toggle(r.id)} disabled={running} aria-label={`Sélectionner le vol ${r.drone_code} du ${date(r.flight_date)}`} /></td>
                      <td className="nowrap"><Link to={`/vols/${r.id}/crm`}>{date(r.flight_date)}</Link> <span className="muted small">{time(r.takeoff_time)}</span></td>
                      <td><strong>{r.drone_code}</strong>{r.qrf && <> <Badge level="danger">QRF</Badge></>}</td>
                      <td>Vol {data!.ranks.get(r.id) ?? '—'}</td>
                      <td>{r.destination_name ?? <span className="muted">{r.flight_type === 'controle' ? 'Vol de contrôle' : '—'}</span>}</td>
                      <td className="ellipsis small">{r.pilot_names ?? '—'}</td>
                      <td><Badge level={v.signed >= v.expected ? 'ok' : 'warn'}>{v.signed}/{v.expected}</Badge></td>
                      <td>{r.status === 'cloture' ? <Badge level="ok">Clôturé</Badge> : <Badge level="warn">Provisoire</Badge>}</td>
                      <td className="small">{done ? <span className="text-ok">✓ {new Date(done).toLocaleDateString('fr-FR')}</span> : <span className="muted">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* rendu hors écran du CRM en cours d'export */}
      <div className="crm-export-host" aria-hidden>
        {current && <FlightCrm key={current} flightId={current} onReady={onReady} />}
      </div>
    </div>
  );
}
