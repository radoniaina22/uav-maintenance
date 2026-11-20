import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { useData } from '../lib/useData';
import type { FlightRow, TechnicalReport } from '../lib/types';
import {
  cardinal, cellLevel, cellText, cellVolts, date, isTechCondition, isWeatherCondition, km, LABELS, minutes, num, orgText, time, volts,
} from '../lib/format';
import { Badge, Empty, ErrorBox, FlightStatusBadge, Loading, PageHeader } from '../components/ui';
import { useApp } from '../lib/app';
import ReportModal from '../components/ReportModal';
import { notifyCrmChanged } from '../lib/crmTasks';

type RelatedFlight = Pick<FlightRow, 'id' | 'flight_date' | 'takeoff_time' | 'qrf'> & { status?: FlightRow['status'] };

export default function FlightDetail() {
  const { id } = useParams() as { id: string };
  const nav = useNavigate();
  const { isAdmin } = useApp();
  const [modal, setModal] = useState<{ report: TechnicalReport | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, error: loadError, loading, reload } = useData(async () => {
    const [f, r, retries] = await Promise.all([
      supabase.from('v_flights').select('*').eq('id', id).single(),
      supabase.from('technical_reports').select('*').eq('flight_id', id).order('created_at'),
      supabase.from('v_flights').select('id, flight_date, takeoff_time, status, qrf').eq('retry_of_flight_id', id).order('flight_date').order('takeoff_time'),
    ]);
    const flight = unwrap(f) as FlightRow;
    const parent = flight.retry_of_flight_id
      ? ((await supabase.from('v_flights').select('id, flight_date, takeoff_time, qrf').eq('id', flight.retry_of_flight_id).maybeSingle()).data as RelatedFlight | null)
      : null;
    return { flight, reports: unwrap(r) as TechnicalReport[], retries: unwrap(retries) as RelatedFlight[], parent };
  }, [id]);

  async function deleteFlight() {
    if (!confirm('Supprimer définitivement ce vol et ses rapports ? Les heures de vol et cycles batteries seront recalculés.')) return;
    try {
      unwrap(await supabase.from('flights').delete().eq('id', id));
      nav('/vols');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function closeFlight() {
    if (!data) return;
    const f = data.flight;
    // eslint-disable-next-line no-restricted-globals
    if (!confirm(`Clôturer ce vol ?\n\n${minutes(f.duration_min)} seront ajoutées au carnet de vol de : ${f.pilot_names ?? '—'}.\nLe vol ne sera plus modifiable (les rapports techniques restent modifiables).`)) return;
    try {
      unwrap(await supabase.rpc('close_flight', { p_id: id }));
      notifyCrmChanged();
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function reopenFlight() {
    if (!confirm('Rouvrir ce vol ? Les heures correspondantes seront retirées du carnet de vol des pilotes jusqu\'à la prochaine clôture, et les visas du CRM seront annulés.')) return;
    try {
      unwrap(await supabase.rpc('reopen_flight', { p_id: id }));
      notifyCrmChanged();
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function deleteReport(r: TechnicalReport) {
    if (!confirm('Supprimer ce rapport ?')) return;
    try {
      unwrap(await supabase.from('technical_reports').delete().eq('id', r.id));
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (loading && !data) return <Loading />;
  if (loadError) return <ErrorBox error={loadError} />;
  if (!data) return null;
  const { flight: f, reports, retries, parent } = data;
  const consoPct = f.consumption_mah != null && f.pack_capacity_mah ? (f.consumption_mah / f.pack_capacity_mah) * 100 : null;

  return (
    <>
      <PageHeader
        title={<>
          {f.flight_type === 'controle' ? 'Vol de contrôle' : 'Livraison'} {f.drone_code}{f.destination_name ? ` → ${f.destination_name}` : ''}{' '}
          {f.qrf && <Badge level="danger">QRF</Badge>} <FlightStatusBadge status={f.status} />
        </>}
        subtitle={<>{date(f.flight_date)} · décollage {time(f.takeoff_time)} · {minutes(f.duration_min)} de vol{f.drone_port_name ? ` · ${f.drone_port_name}` : ''}</>}
        actions={<>
          <Link className="btn" to="/vols">← Retour</Link>
          {f.qrf && <Link className="btn" to={`/vols/nouveau?tentative=${f.id}`}>↻ Nouvelle tentative</Link>}
          {f.status === 'ouvert' ? <>
            <Link className="btn" to={`/vols/${id}/modifier`}>Modifier</Link>
            <button className="btn btn-danger" onClick={deleteFlight}>Supprimer</button>
            <button className="btn btn-primary" onClick={closeFlight}>✓ Clôturer le vol</button>
          </> : <>
            <Link className="btn btn-primary" to={`/vols/${id}/crm`}>⎙ CRM</Link>
            {isAdmin && <button className="btn" onClick={reopenFlight}>Rouvrir le vol</button>}
          </>}
        </>}
      />
      <ErrorBox error={error} />
      {f.status === 'cloture' ? (
        <div className="alert alert-ok">
          ✓ Vol clôturé le {f.closed_at ? new Date(f.closed_at).toLocaleString('fr-FR') : '—'} : {minutes(f.duration_min)} inscrites au carnet de vol de {f.pilot_names ?? '—'}.{' '}
          <Link to={`/vols/${id}/crm`}><strong>Imprimer le compte rendu matériel (CRM) →</strong></Link>
        </div>
      ) : (
        <div className="alert alert-warn">
          Vol ouvert : vérifiez les données puis clôturez-le pour inscrire les heures au carnet de vol des pilotes.
        </div>
      )}

      {f.qrf && (
        <section className="card card-qrf">
          <div className="row-between">
            <h2 className="card-title">⟲ QRF : retour au drone port avant largage</h2>
            <Badge level="danger">Colis non livré</Badge>
          </div>
          <dl className="dl">
            <dt>Cause</dt><dd><strong>{f.qrf_cause ? LABELS.qrfCause[f.qrf_cause] : '—'}</strong></dd>
            {f.qrf_conditions && f.qrf_conditions.length > 0 && <>
              <dt>Conditions</dt>
              <dd>
                <div className="chips">
                  {f.qrf_conditions.map((c) => (
                    <span key={c} className={`chip active${isTechCondition(c) ? ' chip-tech' : ''}`}>
                      {isTechCondition(c) ? '⚙ ' : isWeatherCondition(c) ? '☁ ' : ''}{LABELS.qrfConditions[c]}
                    </span>
                  ))}
                </div>
              </dd>
            </>}
            <dt>Demi-tour</dt>
            <dd>{f.qrf_time ? <>{time(f.qrf_time)}{f.time_to_qrf_min != null && <span className="muted"> (T+{minutes(f.time_to_qrf_min)} après le décollage)</span>}</> : '—'}</dd>
            <dt>Détails</dt><dd className="prewrap">{f.qrf_details ?? '—'}</dd>
            <dt>Nouvelle tentative</dt>
            <dd>
              {retries.length === 0
                ? <><span className="muted">Aucune pour l'instant. </span><Link to={`/vols/nouveau?tentative=${f.id}`}>Créer la nouvelle tentative →</Link></>
                : retries.map((r) => (
                  <div key={r.id}>
                    <Link to={`/vols/${r.id}`}>{date(r.flight_date)} à {time(r.takeoff_time)}</Link>
                    {r.qrf ? <> <Badge level="danger">QRF</Badge></> : <> <Badge level="ok">sans QRF</Badge></>}
                  </div>
                ))}
            </dd>
          </dl>
        </section>
      )}

      {parent && (
        <div className="alert alert-info">
          ↻ Nouvelle tentative du <Link to={`/vols/${parent.id}`}>vol du {date(parent.flight_date)} à {time(parent.takeoff_time)}</Link>
          {parent.qrf ? ' (interrompu par un QRF)' : ''}.
        </div>
      )}

      <div className="grid-2">
        <section className="card">
          <h2 className="card-title">Informations du vol</h2>
          <dl className="dl">
            <dt>Type de vol</dt><dd><Badge level={f.flight_type === 'controle' ? 'neutral' : 'info'}>{LABELS.flightType[f.flight_type]}</Badge></dd>
            <dt>Organisation</dt><dd>{orgText(f)}</dd>
            <dt>Drone</dt><dd><Link to={`/drones/${f.drone_id}`}>{f.drone_code}</Link></dd>
            <dt>Drone port</dt><dd>{f.drone_port_name ?? '—'}</dd>
            <dt>Destination</dt><dd>{f.destination_name ? `${f.destination_category} ${f.destination_name}` : <span className="muted">Aucune (vol local)</span>}</dd>
            <dt>Distance</dt>
            <dd>
              {km(f.distance_km)}
              {f.destination_distance_km != null && f.distance_km != null && Number(f.destination_distance_km) !== Number(f.distance_km) &&
                <span className="muted small"> (CSB : {km(f.destination_distance_km)})</span>}
            </dd>
            <dt>Pilote(s)</dt><dd>{f.pilot_names ?? '—'}</dd>
            <dt>Date</dt><dd>{date(f.flight_date)}</dd>
            <dt>Décollage</dt><dd>{time(f.takeoff_time)}</dd>
            <dt>Largage</dt><dd>{f.qrf ? <span className="text-danger">Non effectué (QRF)</span> : time(f.drop_time)}{f.time_to_drop_min != null && <span className="muted"> (T+{minutes(f.time_to_drop_min)})</span>}</dd>
            <dt>Atterrissage</dt><dd>{time(f.landing_time)}</dd>
            <dt>Durée</dt><dd><strong>{minutes(f.duration_min)}</strong></dd>
          </dl>
        </section>
        <section className="card">
          <h2 className="card-title">Charge, météo & énergie</h2>
          <dl className="dl">
            <dt>Poids du colis</dt><dd>{f.payload_kg != null ? `${num(f.payload_kg)} kg` : '—'}</dd>
            <dt>Altitude de croisière</dt>
            <dd>{f.cruise_altitude_m != null ? `${num(f.cruise_altitude_m, 0)} m AMSL` : '—'}</dd>
            <dt>Vent moyen</dt><dd>{f.avg_wind_ms != null ? `${num(f.avg_wind_ms)} m/s (${num(f.avg_wind_ms * 3.6)} km/h)` : '—'}</dd>
            <dt>Direction du vent</dt>
            <dd>
              {f.wind_direction_deg != null ? (
                <span className="wind">
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden style={{ transform: `rotate(${f.wind_direction_deg + 180}deg)` }}>
                    <path d="M12 2 L17 20 L12 16 L7 20 Z" fill="currentColor" />
                  </svg>
                  Vent du <strong>{cardinal(f.wind_direction_deg)}</strong> ({f.wind_direction_deg}°)
                </span>
              ) : '—'}
            </dd>
            <dt>Consommation</dt><dd>{f.consumption_mah != null ? `${num(f.consumption_mah, 0)} mAh` : '—'}{consoPct != null && <span className="muted"> ({num(consoPct)} % du pack)</span>}</dd>
            <dt>Pack</dt><dd>{f.pack_number ? <strong>Pack {f.pack_number}</strong> : '—'}</dd>
            <dt>Batteries</dt>
            <dd>
              {f.battery_1_id ? <Link to={`/batteries/${f.battery_1_id}`}>{f.battery_1_code}</Link> : '—'}
              {' + '}
              {f.battery_2_id ? <Link to={`/batteries/${f.battery_2_id}`}>{f.battery_2_code}</Link> : '—'}
              {(f.battery_1_serial || f.battery_2_serial) && <span className="muted small"> (S/N {[f.battery_1_serial, f.battery_2_serial].filter(Boolean).join(', ')})</span>}
            </dd>
            <dt>Capacité pack</dt><dd>{f.pack_capacity_mah ? `${num(f.pack_capacity_mah, 0)} mAh` : '—'}</dd>
            <dt>Tension départ</dt>
            <dd>{volts(f.voltage_start_v)}{f.voltage_start_v != null && <span className={`text-${cellLevel(cellVolts(f.voltage_start_v), 'start')}`}> · ≈ {cellText(f.voltage_start_v)}</span>}</dd>
            <dt>Tension arrivée</dt>
            <dd>{volts(f.voltage_end_v)}{f.voltage_end_v != null && <span className={`text-${cellLevel(cellVolts(f.voltage_end_v), 'end')}`}> · ≈ {cellText(f.voltage_end_v)}</span>}</dd>
            {f.voltage_start_v != null && f.voltage_end_v != null && <>
              <dt>Chute de tension</dt><dd>{volts(f.voltage_start_v - f.voltage_end_v)} <span className="muted">({cellText(f.voltage_start_v - f.voltage_end_v)})</span></dd>
            </>}
          </dl>
        </section>
      </div>

      <section className="card">
        <h2 className="card-title">Observation</h2>
        {f.observation ? <p className="prewrap">{f.observation}</p> : <p className="muted">Aucune observation.</p>}
      </section>

      <section className="card">
        <div className="row-between">
          <h2 className="card-title">Rapports techniques / incidents</h2>
          <button className="btn btn-primary btn-sm" onClick={() => setModal({ report: null })}>+ Ajouter un rapport</button>
        </div>
        {reports.length === 0 ? <Empty>Aucun rapport pour ce vol.</Empty> : reports.map((r) => (
          <div key={r.id} className={`subcard report report-${r.status}`}>
            <div className="row-between">
              <div className="badges">
                <Badge level={r.report_type === 'incident' ? 'danger' : 'info'}>{LABELS.reportType[r.report_type]}</Badge>
                <Badge level={r.severity === 'critique' ? 'danger' : r.severity === 'majeur' ? 'warn' : 'neutral'}>{LABELS.severity[r.severity]}</Badge>
                <Badge level={r.status === 'clos' ? 'ok' : 'warn'}>{LABELS.reportStatus[r.status]}{r.resolved_on ? ` le ${date(r.resolved_on)}` : ''}</Badge>
                {r.component && <span className="small muted">{r.component}</span>}
              </div>
              <div className="actions">
                {r.status === 'clos' && !isAdmin ? (
                  <span className="small muted" title="Seul un administrateur peut modifier un rapport clôturé">🔒 Verrouillé{r.resolved_by_name ? ` · clos par ${r.resolved_by_name}` : ''}</span>
                ) : <>
                  <button className="btn btn-sm" onClick={() => setModal({ report: r })}>Modifier</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => deleteReport(r)}>Supprimer</button>
                </>}
              </div>
            </div>
            <div className="report-body">
              <div><div className="field-label">Description</div><p className="prewrap">{r.description}</p></div>
              <div><div className="field-label">Mesures correctives</div><p className="prewrap">{r.corrective_action || <span className="muted">Aucune</span>}</p></div>
            </div>
          </div>
        ))}
      </section>

      {modal && (
        <ReportModal
          flightId={id}
          report={modal.report}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); reload(); }}
        />
      )}
    </>
  );
}
