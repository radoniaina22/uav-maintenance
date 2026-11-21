import { FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { useData } from '../lib/useData';
import type { DroneStatusRow, FlightRow, MaintenanceVisit, VisitType } from '../lib/types';
import { date, hours, LABELS, minutes, num, time, today, toNum, toStr, visitLevel } from '../lib/format';
import { Badge, Empty, ErrorBox, Field, FlightStatusBadge, Loading, Modal, PageHeader } from '../components/ui';
import { DroneModal } from './Drones';
import { useApp } from '../lib/app';
import { addDays, iso } from '../lib/stats';
import { FORECAST_WINDOW_DAYS, projection } from '../lib/dashboard';
import { Icon } from '../components/icons';
import { DronePhoto, PotentialGauge } from '../components/DroneVisuals';
import { ChoiceCards, FormSection, QuickChips } from '../components/FormKit';

function VisitModal({ drone, visit, onClose, onSaved }: {
  drone: DroneStatusRow; visit: MaintenanceVisit | null; onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState({
    visit_type: visit?.visit_type ?? 'systematique',
    visit_date: visit?.visit_date ?? today(),
    hours_at_visit: String(visit?.hours_at_visit ?? drone.total_hours),
    technician: visit?.technician ?? '',
    work_done: visit?.work_done ?? '',
    notes: visit?.notes ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const payload = {
      drone_id: drone.id,
      visit_type: f.visit_type as VisitType,
      visit_date: f.visit_date,
      hours_at_visit: toNum(f.hours_at_visit) ?? 0,
      technician: toStr(f.technician),
      work_done: toStr(f.work_done),
      notes: toStr(f.notes),
    };
    try {
      if (visit) unwrap(await supabase.from('maintenance_visits').update(payload).eq('id', visit.id));
      else unwrap(await supabase.from('maintenance_visits').insert(payload));
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  // ---- aperçu de l'effet sur le décompte des heures
  const interval = Number(drone.visit_interval_hours);
  const atVisit = toNum(f.hours_at_visit) ?? 0;
  const isSys = f.visit_type === 'systematique';
  const after = isSys ? interval - (Number(drone.total_hours) - atVisit) : Number(drone.hours_to_next_visit);
  const warnings: string[] = [];
  if (atVisit > Number(drone.total_hours) + 0.05) warnings.push(`Le compteur saisi (${hours(atVisit)}) dépasse le compteur actuel du drone (${hours(drone.total_hours)}).`);
  if (f.visit_date > today()) warnings.push('La date de visite est dans le futur.');
  if (isSys && drone.last_visit_hours != null && atVisit < Number(drone.last_visit_hours) && !visit) warnings.push(`Une visite plus récente existe déjà (à ${hours(drone.last_visit_hours)}).`);

  return (
    <Modal title={visit ? 'Modifier la visite' : `Nouvelle visite – ${drone.code}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Annuler</button><button className="btn btn-primary" form="visit-form" disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer la visite'}</button></>}>
      <div className="bm">
        <form id="visit-form" className="bm-form" onSubmit={submit}>
          <FormSection n={1} icon="wrench" title="Type de visite">
            <ChoiceCards label="Type de visite" value={f.visit_type as VisitType} onChange={(v) => set('visit_type', v)} options={[
              { value: 'systematique', label: LABELS.visitType.systematique, desc: `toutes les ${num(interval, 0)} h · remet le décompte à zéro`, icon: 'shield', tone: 'ok' },
              { value: 'corrective', label: LABELS.visitType.corrective, desc: 'suite à une panne ou un rapport', icon: 'wrench', tone: 'warn' },
              { value: 'autre', label: LABELS.visitType.autre, desc: 'inspection, mise à jour…', icon: 'search', tone: 'neutral' },
            ]} />
          </FormSection>
          <FormSection n={2} icon="clock" title="Date & compteur">
            <div className="form-grid">
              <Field label="Date" required><input type="date" required value={f.visit_date} onChange={(e) => set('visit_date', e.target.value)} /></Field>
              <Field label="Compteur horaire à la visite (h)" required
                hint={<button type="button" className="rf-chip" onClick={() => set('hours_at_visit', String(drone.total_hours))}>↺ compteur actuel : {hours(drone.total_hours)}</button>}>
                <input type="number" step="0.1" min="0" required value={f.hours_at_visit} onChange={(e) => set('hours_at_visit', e.target.value)} />
              </Field>
              <Field label="Technicien(s)" wide><input value={f.technician} onChange={(e) => set('technician', e.target.value)} /></Field>
            </div>
          </FormSection>
          <FormSection n={3} icon="pen" title="Travaux réalisés" hint="cliquez pour ajouter une ligne">
            <QuickChips items={VISIT_TASKS} value={f.work_done} onChange={(v) => set('work_done', v)} />
            <textarea rows={5} value={f.work_done} onChange={(e) => set('work_done', e.target.value)} aria-label="Travaux réalisés"
              placeholder="Inspection moteurs VTOL et principal, hélices, connecteurs batteries, structure…" />
          </FormSection>
          <Field label="Notes" wide><textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
          <ErrorBox error={error} />
        </form>

        <aside className="bm-aside">
          <span className="pd-kicker">Effet sur le potentiel</span>
          <div className="fk-before-after">
            <div><span>Avant</span><PotentialGauge d={drone} size={104} /></div>
            <span className="fk-ba-arrow">→</span>
            <div><span>Après</span><PotentialGauge d={{ hours_to_next_visit: after, visit_interval_hours: interval }} size={104} /></div>
          </div>
          <p className="small muted">{isSys
            ? <>Prochaine visite systématique à <b>{hours(atVisit + interval)}</b> au compteur.</>
            : 'Une visite corrective ou autre ne modifie pas le décompte des heures.'}</p>
          <div className="fk-kv"><span>Compteur actuel</span><b>{hours(drone.total_hours)}</b></div>
          <div className="fk-kv"><span>Dernière visite</span><b>{drone.last_visit_hours != null ? hours(drone.last_visit_hours) : 'aucune'}</b></div>
          {warnings.length > 0 && <ul className="bm-warn">{warnings.map((w) => <li key={w}><Icon name="alert" size={13} /> {w}</li>)}</ul>}
        </aside>
      </div>
    </Modal>
  );
}

/** Travaux courants d'une visite (une ligne chacun) */
const VISIT_TASKS = ['Inspection moteurs VTOL', 'Moteur de propulsion', 'Contrôle des hélices', 'Serrage des fixations', 'Connecteurs batteries',
  'Structure / cellule', 'Servos et gouvernes', 'Système de largage', 'Calibration capteurs / GPS', 'Mise à jour firmware', 'Essai moteurs au sol'];

export default function DroneDetail() {
  const { id } = useParams() as { id: string };
  const [visitModal, setVisitModal] = useState<{ visit: MaintenanceVisit | null } | null>(null);
  const [editDrone, setEditDrone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isAdmin } = useApp();

  const { data, error: loadError, loading, reload } = useData(async () => {
    const [d, v, f, recent] = await Promise.all([
      supabase.from('v_drone_status').select('*').eq('id', id).single(),
      supabase.from('maintenance_visits').select('*').eq('drone_id', id).order('visit_date', { ascending: false }).order('hours_at_visit', { ascending: false }),
      supabase.from('v_flights').select('*').eq('drone_id', id).order('flight_date', { ascending: false }).order('takeoff_time', { ascending: false }).limit(15),
      supabase.from('v_flights').select('duration_min').eq('drone_id', id).gte('flight_date', addDays(iso(new Date()), -(FORECAST_WINDOW_DAYS - 1))),
    ]);
    const perDay = (unwrap(recent) as { duration_min: number }[]).reduce((s, x) => s + Number(x.duration_min), 0) / 60 / FORECAST_WINDOW_DAYS;
    return { drone: unwrap(d) as DroneStatusRow, visits: unwrap(v) as MaintenanceVisit[], flights: unwrap(f) as FlightRow[], perDay };
  }, [id]);

  async function deleteVisit(v: MaintenanceVisit) {
    if (!confirm('Supprimer cette visite ?')) return;
    try {
      unwrap(await supabase.from('maintenance_visits').delete().eq('id', v.id));
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (loading && !data) return <Loading />;
  if (loadError) return <ErrorBox error={loadError} />;
  if (!data) return null;
  const { drone: d, visits, flights } = data;
  const lvl = visitLevel(d.hours_to_next_visit);
  const forecast = projection(Number(d.hours_to_next_visit), data.perDay);

  return (
    <>
      <PageHeader
        title={<>{d.code} <Badge level={d.status === 'operationnel' ? 'ok' : d.status === 'maintenance' ? 'warn' : 'danger'}>{LABELS.droneStatus[d.status]}</Badge></>}
        subtitle={<>⌂ {d.drone_port_name ?? 'Non affecté'} · {d.model}{d.serial_number ? ` · S/N ${d.serial_number}` : ''} · VTOL fixed wing · 4 moteurs VTOL + 1 moteur principal</>}
        actions={<>
          <Link className="btn" to="/drones">← Retour</Link>
          <Link className="btn btn-primary" to={`/drones/${d.id}/historique`}>🛠 Historique technique</Link>
          <Link className="btn" to={`/ordres-travail?drone=${d.id}&nouveau=1`}>📋 Ouvrir un OT</Link>
          <Link className="btn" to={`/pieces?drone=${d.id}`}>⛭ Pièces montées</Link>
          <Link className="btn" to={`/pieces/etiquettes?drones=${d.id}`} title="Étiquette à coller sur le drone, lue par le mode atelier">🏷 Étiquette QR</Link>
          <Link className="btn" to={`/consommation?drone=${d.id}`}>⚡ Consommation</Link>
          {isAdmin && <button className="btn" onClick={() => setEditDrone(true)}>Modifier</button>}
          <button className="btn btn-primary" onClick={() => setVisitModal({ visit: null })}>+ Enregistrer une visite</button>
        </>}
      />
      <ErrorBox error={error} />

      {lvl !== 'ok' && (
        <div className={`alert alert-${lvl}`}>
          {lvl === 'danger'
            ? <>⛔ La visite systématique des {num(d.visit_interval_hours, 0)} h est <strong>dépassée de {hours(-d.hours_to_next_visit)}</strong>.</>
            : <>⚠ Visite systématique à prévoir : il reste <strong>{hours(d.hours_to_next_visit)}</strong> de vol.</>}
        </div>
      )}

      {/* ---- en-tête : photo, potentiel, chiffres clés ---- */}
      <section className={`dhero lvl-${lvl}`}>
        <DronePhoto state={lvl === 'danger' || d.status !== 'operationnel' ? 'indisponible' : lvl === 'warn' || d.open_reports ? 'reserve' : 'pret'} className="dhero-photo" />
        <div className="dhero-gauge">
          <PotentialGauge d={d} size={170} />
          <span className="small muted">{hours(d.visit_interval_hours - d.hours_to_next_visit)} effectuées sur {num(d.visit_interval_hours, 0)} h
            {d.last_visit_date ? ` depuis la visite du ${date(d.last_visit_date)}` : ' (aucune visite systématique enregistrée)'}</span>
        </div>
        <dl className="dhero-stats">
          <div><dt>Heures totales</dt><dd>{hours(d.total_hours)}</dd><em>dont {hours(Number(d.initial_flight_minutes) / 60)} initiales</em></div>
          <div><dt>Vols</dt><dd>{num(d.flight_count, 0)}</dd><em>dernier : {date(d.last_flight_date)}</em></div>
          <div><dt>Prochaine visite</dt><dd>à {hours(d.next_visit_hours)}</dd>
            <em>{forecast ? (forecast.days === 0 ? 'échue' : `estimée vers le ${date(forecast.date)} (J-${forecast.days})`) : 'pas de vol récent : pas d\'estimation'}</em></div>
          <div><dt>Rythme</dt><dd>{num(data.perDay * 7, 1)} h / sem.</dd><em>moyenne des {FORECAST_WINDOW_DAYS} derniers jours</em></div>
          <div className={d.open_reports ? 'is-warn' : ''}><dt>Rapports ouverts</dt><dd>{d.open_reports}</dd><em>{d.open_reports ? <Link to="/rapports">à traiter →</Link> : 'aucun'}</em></div>
        </dl>
      </section>

      <section className="card">
        <h2 className="card-title">Historique des visites</h2>
        {visits.length === 0 ? <Empty>Aucune visite enregistrée. Utilisez « + Enregistrer une visite » après chaque visite systématique ou corrective.</Empty> : (
          <ol className="visit-line">
            {visits.map((v) => (
              <li key={v.id} className={`vl-item vt-${v.visit_type}`}>
                <span className="vl-dot" aria-hidden><Icon name="wrench" size={14} /></span>
                <div className="vl-body">
                  <div className="vl-head">
                    <strong>{date(v.visit_date)}</strong>
                    <Badge level={v.visit_type === 'systematique' ? 'info' : 'neutral'}>{LABELS.visitType[v.visit_type]}</Badge>
                    <span className="vl-hours">à {hours(v.hours_at_visit)}</span>
                    {v.technician && <span className="small muted">· {v.technician}</span>}
                    <span className="vl-actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => setVisitModal({ visit: v })}>Modifier</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => deleteVisit(v)}>Supprimer</button>
                    </span>
                  </div>
                  {v.work_done && <p className="vl-text">{v.work_done}</p>}
                  {v.notes && <p className="small muted vl-text">{v.notes}</p>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="card">
        <div className="row-between">
          <h2 className="card-title">Derniers vols</h2>
          <Link className="small" to="/vols">Tous les vols →</Link>
        </div>
        {flights.length === 0 ? <Empty>Aucun vol.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Destination</th><th>Décollage</th><th>Durée</th><th>Colis</th><th>Conso.</th><th>Rapports</th><th>Statut</th></tr></thead>
              <tbody>
                {flights.map((f) => (
                  <tr key={f.id}>
                    <td><Link to={`/vols/${f.id}`}>{date(f.flight_date)}</Link></td>
                    <td>{f.destination_name}</td>
                    <td>{time(f.takeoff_time)}</td>
                    <td>{minutes(f.duration_min)}</td>
                    <td>{f.payload_kg != null ? `${num(f.payload_kg)} kg` : '—'}</td>
                    <td>{f.consumption_mah != null ? `${num(f.consumption_mah, 0)} mAh` : '—'}</td>
                    <td>{f.open_report_count > 0 ? <Badge level="warn">{f.open_report_count} ouvert(s)</Badge> : f.report_count || '—'}</td>
                    <td><FlightStatusBadge status={f.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {visitModal && <VisitModal drone={d} visit={visitModal.visit} onClose={() => setVisitModal(null)} onSaved={() => { setVisitModal(null); reload(); }} />}
      {editDrone && <DroneModal drone={d} onClose={() => setEditDrone(false)} onSaved={() => { setEditDrone(false); reload(); }} />}
    </>
  );
}
