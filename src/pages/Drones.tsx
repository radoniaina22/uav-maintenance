import { FormEvent, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { useData } from '../lib/useData';
import type { Drone, DroneStatus, DroneStatusRow, PackStatusRow, ReportRow } from '../lib/types';
import { date, hours, LABELS, num, toNum, toStr, visitLevel } from '../lib/format';
import { Badge, Empty, ErrorBox, Field, Loading, Modal, PageHeader, Progress } from '../components/ui';
import { byPort, useApp } from '../lib/app';
import { addDays, daysBetween, iso, parseIso } from '../lib/stats';
import { droneReadiness, FORECAST_WINDOW_DAYS, MountedPart, projection, READINESS_LABEL, READINESS_LEVEL } from '../lib/dashboard';
import { Icon } from '../components/icons';
import { DronePhoto, PotentialGauge } from '../components/DroneVisuals';
import { ChoiceCards, FormSection } from '../components/FormKit';

export function DroneModal({ drone, onClose, onSaved }: { drone: Drone | null; onClose: () => void; onSaved: () => void }) {
  const { ports, portFilter } = useApp();
  const [f, setF] = useState({
    drone_port_id: drone ? drone.drone_port_id ?? '' : portFilter,
    code: drone?.code ?? '',
    model: drone?.model ?? 'Tango 4',
    serial_number: drone?.serial_number ?? '',
    initial_hours: drone ? String(Number(drone.initial_flight_minutes) / 60) : '0',
    visit_interval_hours: String(drone?.visit_interval_hours ?? 250),
    status: drone?.status ?? 'operationnel',
    notes: drone?.notes ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const payload = {
      drone_port_id: toStr(f.drone_port_id),
      code: f.code.trim().toUpperCase(),
      model: f.model.trim() || 'Tango 4',
      serial_number: toStr(f.serial_number),
      initial_flight_minutes: Math.round((toNum(f.initial_hours) ?? 0) * 600) / 10,
      visit_interval_hours: toNum(f.visit_interval_hours) ?? 250,
      status: f.status as DroneStatus,
      notes: toStr(f.notes),
    };
    try {
      if (drone) unwrap(await supabase.from('drones').update(payload).eq('id', drone.id));
      else unwrap(await supabase.from('drones').insert(payload));
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  // ---- aperçu : compteur et potentiel recalculés
  const st = drone as (Drone & Partial<DroneStatusRow>) | null;
  const oldInitial = drone ? Number(drone.initial_flight_minutes) / 60 : 0;
  const newInitial = toNum(f.initial_hours) ?? 0;
  const total = Number(st?.total_hours ?? 0) - oldInitial + newInitial;
  const interval = toNum(f.visit_interval_hours) ?? 250;
  const lastVisit = Number(st?.last_visit_hours ?? 0);
  const toNext = interval - (total - lastVisit);
  const portName = ports.find((p) => p.id === f.drone_port_id)?.name;
  const warnings: string[] = [];
  if (drone && (drone.drone_port_id ?? '') !== f.drone_port_id) warnings.push(`Changement de drone port : les vols futurs seront rattachés à ${portName ?? 'aucun drone port'}. Les vols passés ne bougent pas.`);
  if (drone && Math.abs(newInitial - oldInitial) > 0.05) warnings.push(`Le compteur passe de ${hours(st?.total_hours ?? oldInitial)} à ${hours(total)} : potentiels et prévisions seront recalculés.`);
  if (toNext <= 0) warnings.push('La visite systématique est dépassée avec ces valeurs.');

  return (
    <Modal title={drone ? `Modifier ${drone.code}` : 'Nouveau drone'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Annuler</button><button className="btn btn-primary" form="drone-form" disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button></>}>
      <div className="bm">
        <form id="drone-form" className="bm-form" onSubmit={submit}>
          <FormSection n={1} icon="drone" title="Identité">
            <div className="form-grid">
              <Field label="Code" required><input className="fk-code-input" required value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase())} placeholder="MAL4" /></Field>
              <Field label="Modèle" required><input required value={f.model} onChange={(e) => set('model', e.target.value)} /></Field>
              <Field label="N° de série"><input className="mono" value={f.serial_number} onChange={(e) => set('serial_number', e.target.value)} /></Field>
            </div>
          </FormSection>
          <FormSection n={2} icon="pin" title="Drone port d'affectation" hint="les vols futurs y seront rattachés">
            <div className="bm-packs">
              <button type="button" className={`bm-pack${!f.drone_port_id ? ' active' : ''}`} onClick={() => set('drone_port_id', '')}><strong>Non affecté</strong></button>
              {ports.filter((p) => p.active !== false || p.id === f.drone_port_id).map((p) => (
                <button key={p.id} type="button" className={`bm-pack${f.drone_port_id === p.id ? ' active' : ''}`} onClick={() => set('drone_port_id', p.id)}><strong>{p.name}</strong></button>
              ))}
            </div>
          </FormSection>
          <FormSection n={3} icon="shield" title="Statut">
            <ChoiceCards label="Statut" value={f.status as DroneStatus} onChange={(v) => set('status', v)} cols={4} options={[
              { value: 'operationnel', label: LABELS.droneStatus.operationnel, desc: 'Peut voler', icon: 'flight', tone: 'ok' },
              { value: 'maintenance', label: LABELS.droneStatus.maintenance, desc: 'Intervention en cours', icon: 'wrench', tone: 'warn' },
              { value: 'immobilise', label: LABELS.droneStatus.immobilise, desc: 'Cloué au sol', icon: 'alert', tone: 'danger' },
              { value: 'retire', label: LABELS.droneStatus.retire, desc: 'Sorti de la flotte', icon: 'box', tone: 'neutral' },
            ]} />
          </FormSection>
          <FormSection n={4} icon="clock" title="Compteurs">
            <div className="form-grid">
              <Field label="Heures de vol initiales" hint="déjà effectuées avant l'utilisation du logiciel">
                <input type="number" step="0.1" min="0" value={f.initial_hours} onChange={(e) => set('initial_hours', e.target.value)} />
              </Field>
              <Field label="Intervalle visite systématique (h)" hint={<span className="rf-quick">{[100, 150, 250, 500].map((v) => <button key={v} type="button" className={`rf-chip${f.visit_interval_hours === String(v) ? ' active' : ''}`} onClick={() => set('visit_interval_hours', String(v))}>{v} h</button>)}</span>}>
                <input type="number" step="1" min="1" value={f.visit_interval_hours} onChange={(e) => set('visit_interval_hours', e.target.value)} />
              </Field>
            </div>
          </FormSection>
          <Field label="Notes" wide><textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
          <ErrorBox error={error} />
        </form>

        <aside className="bm-aside">
          <span className="pd-kicker">Aperçu</span>
          <DronePhoto state={f.status === 'operationnel' ? 'pret' : f.status === 'maintenance' ? 'reserve' : 'indisponible'} className="fk-drone-photo" />
          <div className="fk-drone-id">
            <strong>{f.code.trim() || 'CODE'}</strong>
            <span>{f.model} · {portName ?? 'non affecté'}</span>
            <span className={`fk-pill tone-${f.status === 'operationnel' ? 'ok' : f.status === 'maintenance' ? 'warn' : f.status === 'immobilise' ? 'danger' : 'neutral'}`}>{LABELS.droneStatus[f.status as DroneStatus]}</span>
          </div>
          <div className="fk-aside-ring"><PotentialGauge d={{ hours_to_next_visit: toNext, visit_interval_hours: interval }} size={130} /></div>
          <div className="fk-kv"><span>Compteur total</span><b>{hours(total)}</b></div>
          {drone && <div className="fk-kv"><span>Dernière visite</span><b>{st?.last_visit_hours != null ? hours(lastVisit) : 'aucune'}</b></div>}
          {warnings.length > 0 && <ul className="bm-warn">{warnings.map((w) => <li key={w}><Icon name="alert" size={13} /> {w}</li>)}</ul>}
        </aside>
      </div>
    </Modal>
  );
}

type MiniFlight = { drone_id: string; duration_min: number };
type VisitLite = { drone_id: string; visit_date: string; visit_type: string; hours_at_visit: number };
const MONTHS_SHORT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

export default function Drones() {
  const { portFilter, isAdmin } = useApp();
  const [modal, setModal] = useState<{ drone: Drone | null } | null>(null);
  const [view, setView] = useState<'hangar' | 'tableau'>(() => { try { return localStorage.getItem('uav.dronesView') === 'tableau' ? 'tableau' : 'hangar'; } catch { return 'hangar'; } });
  const pickView = (v: 'hangar' | 'tableau') => { setView(v); try { localStorage.setItem('uav.dronesView', v); } catch { /* sans stockage */ } };

  const { data, error, loading, reload } = useData(async () => {
    const todayIso = iso(new Date());
    const [drones, flights, parts, reports, packs, visits] = await Promise.all([
      byPort(supabase.from('v_drone_status').select('*'), portFilter).order('code'),
      byPort(supabase.from('v_flights').select('drone_id, duration_min'), portFilter).gte('flight_date', addDays(todayIso, -(FORECAST_WINDOW_DAYS - 1))).limit(5000),
      byPort(supabase.from('v_parts').select('id, code, drone_id, potential_pct, max_hours_effective, total_hours, type_name, status'), portFilter).eq('status', 'monte'),
      byPort(supabase.from('v_reports').select('*'), portFilter).neq('status', 'clos'),
      byPort(supabase.from('v_pack_status').select('*'), portFilter),
      supabase.from('maintenance_visits').select('drone_id, visit_date, visit_type, hours_at_visit').gte('visit_date', addDays(todayIso, -400)),
    ]);
    return {
      drones: unwrap(drones) as DroneStatusRow[], flights: unwrap(flights) as MiniFlight[], parts: unwrap(parts) as MountedPart[],
      reports: unwrap(reports) as ReportRow[], packs: unwrap(packs) as PackStatusRow[], visits: unwrap(visits) as VisitLite[],
    };
  }, [portFilter]);

  const fleet = useMemo(() => {
    if (!data) return null;
    const rate = new Map<string, number>();
    for (const f of data.flights) rate.set(f.drone_id, (rate.get(f.drone_id) ?? 0) + Number(f.duration_min) / 60 / FORECAST_WINDOW_DAYS);
    return data.drones.filter((d) => d.status !== 'retire').map((d) => {
      const r = droneReadiness(d, { parts: data.parts, reports: data.reports, packs: data.packs });
      const perDay = rate.get(d.id) ?? 0;
      return { d, ...r, perDay, next: projection(Number(d.hours_to_next_visit), perDay), visits: data.visits.filter((v) => v.drone_id === d.id) };
    });
  }, [data]);

  // ---- fenêtre du planning : 3 mois passés → 9 mois à venir
  const todayIso = iso(new Date());
  const winStart = (() => { const x = parseIso(todayIso); x.setMonth(x.getMonth() - 3, 1); return iso(x); })();
  const winEnd = (() => { const x = parseIso(todayIso); x.setMonth(x.getMonth() + 10, 0); return iso(x); })();
  const span = daysBetween(winStart, winEnd);
  const pos = (s: string) => Math.min(100, Math.max(0, (100 * daysBetween(winStart, s)) / span));
  const months: { label: string; left: number }[] = [];
  for (let x = parseIso(winStart); iso(x) <= winEnd; x.setMonth(x.getMonth() + 1)) months.push({ label: `${MONTHS_SHORT[x.getMonth()]}${x.getMonth() === 0 ? ` ${String(x.getFullYear()).slice(2)}` : ''}`, left: pos(iso(x)) });

  const ready = fleet?.filter((f) => f.state === 'pret').length ?? 0;
  const soonest = fleet?.filter((f) => f.next).sort((a, b) => a.next!.days - b.next!.days)[0];
  const totalHours = data?.drones.reduce((s, d) => s + Number(d.total_hours), 0) ?? 0;

  return (
    <div className="drones-page">
      <PageHeader title="Drones & visites" subtitle="Le hangar : disponibilité, potentiel avant visite et planning de maintenance"
        actions={<>
          <div className="segmented segmented-sm" role="tablist" aria-label="Présentation">
            <button type="button" role="tab" aria-selected={view === 'hangar'} className={view === 'hangar' ? 'active' : ''} onClick={() => pickView('hangar')}>Hangar</button>
            <button type="button" role="tab" aria-selected={view === 'tableau'} className={view === 'tableau' ? 'active' : ''} onClick={() => pickView('tableau')}>Tableau</button>
          </div>
          {!!data?.drones.length && <Link className="btn" to={`/pieces/etiquettes?drones=${data.drones.map((d) => d.id).join(',')}`} title="Étiquettes à coller sur les drones, lues par le mode atelier">🏷 Étiquettes QR</Link>}
          {isAdmin && <button className="btn" onClick={() => setModal({ drone: null })}>+ Ajouter un drone</button>}
        </>} />
      {!loading && data?.drones.length === 0 && <Empty>Aucun drone pour ce drone port.</Empty>}
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : data && fleet && (view === 'hangar' ? (
        <>
          <div className="flight-kpis drones-kpis">
            <div className={`fk${ready === fleet.length ? ' fk-ok' : ' fk-warn'}`}><span className="fk-icon"><Icon name="drone" size={18} /></span>
              <div><strong>{ready} / {fleet.length}</strong><span>drone(s) prêt(s) à voler</span></div></div>
            <div className="fk"><span className="fk-icon"><Icon name="clock" size={18} /></span>
              <div><strong>{hours(totalHours)}</strong><span>heures de vol de la flotte</span></div></div>
            <div className={`fk${soonest && soonest.next!.days <= 30 ? ' fk-warn' : ''}`}><span className="fk-icon"><Icon name="wrench" size={18} /></span>
              <div><strong>{soonest ? `${soonest.d.code} · ${soonest.next!.days === 0 ? 'échue' : `J-${soonest.next!.days}`}` : '—'}</strong>
                <span>{soonest ? `prochaine visite vers le ${date(soonest.next!.date)}` : 'pas assez de vols récents'}</span></div></div>
            <div className={`fk${data.reports.length ? ' fk-warn' : ' fk-ok'}`}><span className="fk-icon"><Icon name="alert" size={18} /></span>
              <div><strong>{data.reports.length}</strong><span>rapport(s) ouvert(s) sur la flotte</span></div></div>
          </div>

          {/* ---- planning prévisionnel ---- */}
          <section className="card plan">
            <div className="row-between">
              <div><h2 className="card-title">Planning de maintenance prévisionnel</h2>
                <span className="small muted">Visites passées ◆ et date estimée de la prochaine visite ● au rythme des {FORECAST_WINDOW_DAYS} derniers jours</span></div>
              <span className="plan-legend small muted"><i className="pl-ok" /> confortable <i className="pl-warn" /> à prévoir <i className="pl-danger" /> imminente ou dépassée</span>
            </div>
            <div className="plan-grid">
              <div className="plan-months">
                {months.map((m) => <span key={m.left} style={{ left: `${m.left}%` }}>{m.label}</span>)}
                <span className="plan-today-label" style={{ left: `${pos(todayIso)}%` }}>aujourd'hui</span>
              </div>
              {fleet.map(({ d, next, visits, perDay }) => {
                const lvl = !next ? 'none' : next.days <= 7 ? 'danger' : next.days <= 30 || visitLevel(d.hours_to_next_visit) !== 'ok' ? 'warn' : 'ok';
                const end = next ? pos(next.date) : null;
                return (
                  <div key={d.id} className="plan-row">
                    <Link to={`/drones/${d.id}`} className="plan-name"><strong>{d.code}</strong><span>{num(perDay * 7, 1)} h / sem.</span></Link>
                    <div className="plan-track">
                      {months.map((m) => <span key={m.left} className="plan-gridline" style={{ left: `${m.left}%` }} />)}
                      <span className="plan-today" style={{ left: `${pos(todayIso)}%` }} />
                      {next && end != null && (
                        <span className={`plan-bar pl-${lvl}`} style={{ left: `${pos(todayIso)}%`, width: `${Math.max(0.6, end - pos(todayIso))}%` }}
                          title={`Reste ${hours(d.hours_to_next_visit)} · visite estimée vers le ${date(next.date)}`} />
                      )}
                      {next && end != null && next.date <= winEnd && (
                        <span className={`plan-next pl-${lvl}`} style={{ left: `${end}%` }} title={`Visite ${num(d.visit_interval_hours, 0)} h estimée vers le ${date(next.date)}`}>
                          <i /><em>{next.days === 0 ? 'échue' : date(next.date).slice(0, 5)}</em>
                        </span>
                      )}
                      {next && next.date > winEnd && <span className="plan-beyond">→ vers le {date(next.date)}</span>}
                      {!next && <span className="plan-beyond muted">pas de vol récent : pas d'estimation</span>}
                      {visits.filter((v) => v.visit_date >= winStart).map((v) => (
                        <span key={v.visit_date + v.hours_at_visit} className={`plan-visit${v.visit_type === 'systematique' ? '' : ' corr'}`} style={{ left: `${pos(v.visit_date)}%` }}
                          title={`${LABELS.visitType[v.visit_type as keyof typeof LABELS.visitType] ?? v.visit_type} le ${date(v.visit_date)} à ${hours(v.hours_at_visit)}`}>◆</span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ---- hangar ---- */}
          <div className="hangar">
            {fleet.map(({ d, state, reasons, next }) => (
              <article key={d.id} className={`hcard state-${state}`}>
                <div className="hcard-top">
                  <div className="hcard-id">
                    <span className="hcard-kicker">{d.model}{d.serial_number ? ` · S/N ${d.serial_number}` : ''}</span>
                    <Link to={`/drones/${d.id}`} className="hcard-code">{d.code}</Link>
                    <span className="hcard-port">⌂ {d.drone_port_name ?? 'Non affecté'}</span>
                    <Badge level={READINESS_LEVEL[state]}>{READINESS_LABEL[state]}</Badge>
                  </div>
                  <PotentialGauge d={d} size={128} />
                </div>
                <DronePhoto state={state} />
                <dl className="hcard-stats">
                  <div><dt>Heures</dt><dd>{hours(d.total_hours)}</dd></div>
                  <div><dt>Vols</dt><dd>{num(d.flight_count, 0)}</dd></div>
                  <div><dt>Dernier vol</dt><dd>{d.last_flight_date ? date(d.last_flight_date) : '—'}</dd></div>
                  <div><dt>Visite estimée</dt><dd>{next ? (next.days === 0 ? 'échue' : date(next.date)) : '—'}</dd></div>
                </dl>
                {reasons.length > 0
                  ? <ul className="hcard-reasons">{reasons.map((r) => <li key={r}>{r}</li>)}</ul>
                  : <div className="hcard-ok">✓ Aucune restriction</div>}
                <div className="hcard-actions">
                  <Link className="btn btn-sm btn-primary" to={`/drones/${d.id}`}>Fiche</Link>
                  <Link className="btn btn-sm" to={`/drones/${d.id}/historique`}>🛠 Historique</Link>
                  <Link className="btn btn-sm" to={`/pieces?drone=${d.id}`}>⛭ Pièces</Link>
                </div>
              </article>
            ))}
          </div>
        </>
      ) : (
        <div className="card no-pad">
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Drone</th><th>Drone port</th><th>Statut</th><th>Heures totales</th><th>Vols</th><th>Dernière visite</th><th>Prochaine visite</th><th>Avancement</th><th>Rapports ouverts</th></tr>
              </thead>
              <tbody>
                {data.drones.map((d) => {
                  const lvl = visitLevel(d.hours_to_next_visit);
                  return (
                    <tr key={d.id}>
                      <td><Link to={`/drones/${d.id}`}><strong>{d.code}</strong></Link><div className="small muted">{d.model}</div></td>
                      <td>{d.drone_port_name ?? <span className="text-warn">Non affecté</span>}</td>
                      <td><Badge level={d.status === 'operationnel' ? 'ok' : d.status === 'maintenance' ? 'warn' : 'danger'}>{LABELS.droneStatus[d.status]}</Badge></td>
                      <td>{hours(d.total_hours)}</td>
                      <td>{num(d.flight_count, 0)}</td>
                      <td>{d.last_visit_date ? <>{date(d.last_visit_date)}<div className="small muted">à {hours(d.last_visit_hours)}</div></> : '—'}</td>
                      <td>{hours(d.next_visit_hours)}<div className={`small text-${lvl}`}>{d.hours_to_next_visit <= 0 ? 'DÉPASSÉE' : `reste ${hours(d.hours_to_next_visit)}`}</div></td>
                      <td style={{ minWidth: 140 }}><Progress value={d.visit_interval_hours - d.hours_to_next_visit} max={d.visit_interval_hours} level={lvl} /></td>
                      <td>{d.open_reports > 0 ? <Badge level="warn">{d.open_reports}</Badge> : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {modal && <DroneModal drone={modal.drone} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
    </div>
  );
}