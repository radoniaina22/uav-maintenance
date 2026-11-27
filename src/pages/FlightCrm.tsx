import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { archiveSupported, archivedOn, crmDocumentToPdf, getArchiveRoot, markArchived, rememberedFolder, saveToArchive, SaveResult } from '../lib/localArchive';
import WindpathReport from '../components/WindpathReport';
import type { WindpathRecord } from '../lib/windpath';
import { crmArchivePath } from '../lib/crmArchive';
import { supabase, unwrap } from '../lib/supabase';
import { useData } from '../lib/useData';
import type { CrmSignature, CrmVisaKind, FlightPilot, FlightRow, TechnicalReport } from '../lib/types';
import ReportModal from '../components/ReportModal';
import UnfpaLogo from '../components/UnfpaLogo';
import { cardinal, cellText, date, km, LABELS, minutes, num, THRESHOLDS, time, volts } from '../lib/format';
import { POTENTIAL_WARN_PCT } from '../lib/parts';
import { ErrorBox, Loading, Modal } from '../components/ui';
import { useApp } from '../lib/app';
import { notifyCrmChanged } from '../lib/crmTasks';
import { Icon } from '../components/icons';

/** Données calculées par la fonction SQL crm_flight (état juste après le vol) */
interface CrmData {
  drone_code: string; drone_model: string; drone_serial: string | null;
  flight_seq: number; flight_minutes: number; hours_before: number; hours_after: number;
  visit_interval_hours: number; last_visit_hours: number | null; last_visit_date: string | null;
  next_visit_hours: number; hours_to_next_visit: number;
  batteries: { code: string; serial: string; capacity_mah: number; cycles_after: number; max_cycles: number; measured_mah: number | null }[];
  parts: { code: string; type_name: string; slot_label: string | null; hours_after: number; max_hours: number | null }[];
}

const h = (v: number | null | undefined) => (v == null ? '—' : `${num(Number(v), 2)} h`);
const hm = (hours: number) => { const m = Math.round(hours * 60); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };

function Box({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`crm-box ${className}`}>
      <h2 className="crm-box-title">{title}</h2>
      {children}
    </section>
  );
}

function Cells({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <div className="crm-cells">
      {items.map(([k, v]) => <div key={k} className="crm-cell"><span className="crm-label">{k}</span><span className="crm-value">{v}</span></div>)}
    </div>
  );
}

/** Infos transmises quand le CRM est rendu hors écran pour l'export */
export interface CrmReadyInfo { crmNo: string; closed: boolean; missingVisas: number }

export default function FlightCrm({ flightId, onReady }: { flightId?: string; onReady?: (el: HTMLElement, info: CrmReadyInfo) => void } = {}) {
  const params = useParams() as { id: string };
  const id = flightId ?? params.id;
  const sheetRef = useRef<HTMLElement>(null);
  /** dossier du vol : CRM + rapport WindPath (un seul PDF) */
  const docRef = useRef<HTMLDivElement>(null);
  /**
   * Export automatique demandé après une signature : nombre de signatures attendu une fois
   * les données rechargées (0 = rien à faire). Lancé seulement si le CRM est alors complet.
   */
  const [autoExport, setAutoExport] = useState(0);
  const [autoBlocked, setAutoBlocked] = useState(false);
  const { session, profile, pilot, myPort, isAdmin } = useApp();
  const [signing, setSigning] = useState<CrmVisaKind | null>(null);
  const [editReport, setEditReport] = useState<TechnicalReport | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SaveResult | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const lastArchive = archivedOn(id);
  useEffect(() => { rememberedFolder().then(setFolder); }, [saved]);
  const { data, error, loading, reload } = useData(async () => {
    const [f, r, c, s, fp, wr] = await Promise.all([
      supabase.from('v_flights').select('*').eq('id', id).single(),
      supabase.from('technical_reports').select('*').eq('flight_id', id).order('created_at'),
      supabase.rpc('crm_flight', { p_flight: id }),
      supabase.from('crm_signatures').select('*').eq('flight_id', id),
      supabase.from('flight_pilots').select('*, pilots(full_name)').eq('flight_id', id),
      supabase.from('flight_windpath_records').select('record').eq('flight_id', id).maybeSingle(),
    ]);
    return {
      f: unwrap(f) as FlightRow, reports: unwrap(r) as TechnicalReport[], crm: unwrap(c) as CrmData,
      signatures: unwrap(s) as CrmSignature[], crew: unwrap(fp) as (FlightPilot & { pilots: { full_name: string } | null })[],
      // mission WindPath : facultative (vol saisi sans planification), une erreur ne bloque pas le CRM
      windpath: ((wr.data as { record: WindpathRecord } | null)?.record ?? null),
    };
  }, [id]);

  // export groupé : prévient le parent une fois le CRM rendu (polices et mise en page prêtes)
  const notified = useRef<string | null>(null);
  useEffect(() => {
    if (!onReady || !data || !docRef.current || notified.current === id) return;
    notified.current = id;
    const el = docRef.current;
    const expected = 1 + (data.crew.some((c) => c.role === 'copilote') ? 1 : 0) + (data.reports.length ? 1 : 0);
    const info: CrmReadyInfo = {
      crmNo: `${data.crm.drone_code}-${String(data.crm.flight_seq).padStart(4, '0')}`,
      closed: data.f.status === 'cloture',
      missingVisas: Math.max(0, expected - new Set(data.signatures.map((s) => s.kind)).size),
    };
    document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => onReady(el, info))));
  }, [data, id, onReady]);

  // export automatique : après la dernière signature, le dossier du vol (CRM + WindPath) est enregistré
  const saveRef = useRef<((forcePick?: boolean, auto?: boolean) => Promise<void>) | null>(null);
  useEffect(() => {
    if (!autoExport || !data || onReady) return;
    if (data.signatures.length < autoExport) return; // données pas encore rechargées après la signature
    setAutoExport(0);
    if (data.f.status !== 'cloture' || missingVisas(data).length) return; // d'autres signatures sont attendues
    void saveRef.current?.(false, true);
  }, [autoExport, data, onReady]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const { f, reports, crm } = data;
  const crmNo = `${crm.drone_code}-${String(crm.flight_seq).padStart(4, '0')}`;
  const closed = f.status === 'cloture';
  const visitLevel = crm.hours_to_next_visit <= 0 ? 'danger' : crm.hours_to_next_visit <= THRESHOLDS.visitWarnHours ? 'warn' : 'ok';
  const pack = Number(f.pack_capacity_mah) || null;
  const pilots = (f.pilot_names ?? '').split(', ').filter(Boolean);
  const partState = (p: CrmData['parts'][number]) => {
    if (p.max_hours == null) return { pct: null, level: '' as const };
    const pct = (100 * p.hours_after) / p.max_hours;
    return { pct, level: pct >= 100 ? 'danger' as const : pct >= POTENTIAL_WARN_PCT ? 'warn' as const : '' as const };
  };
  const partAlerts = crm.parts.filter((p) => partState(p).level);

  // ---- visas : commandant de bord, copilote (s'il y en a un), mesures correctives (s'il y a des rapports)
  const pic = data.crew.find((c) => c.role === 'pilote');
  const copilot = data.crew.find((c) => c.role === 'copilote');
  const openReports = reports.filter((r) => r.status !== 'clos').length;
  const samePort = !!myPort && myPort.id === f.drone_port_id;
  const canTreat = isAdmin || samePort;
  const visas: { kind: CrmVisaKind; title: string; expected: string | null; canSign: boolean }[] = [
    { kind: 'pilote', title: 'Commandant de bord', expected: pic?.pilots?.full_name ?? null, canSign: closed && !!pic && pic.pilot_id === profile?.pilot_id },
    ...(copilot ? [{ kind: 'copilote' as const, title: 'Copilote', expected: copilot.pilots?.full_name ?? null, canSign: closed && copilot.pilot_id === profile?.pilot_id }] : []),
    ...(reports.length ? [{ kind: 'rapports' as const, title: 'Mesures correctives', expected: null,
      canSign: closed && samePort && !!profile?.pilot_id && openReports === 0 }] : []),
  ];
  const sig = (k: CrmVisaKind) => data.signatures.find((s) => s.kind === k) ?? null;
  const canUnsign = (s: CrmSignature | null) => !!s && (s.user_id === session.user.id || isAdmin);
  const missing = visas.filter((v) => !sig(v.kind)).map((v) => v.title.toLowerCase());
  const myTurn = closed && visas.some((v) => v.canSign && !sig(v.kind));

  function print() {
    if (missing.length && !window.confirm(`Le CRM n'est pas entièrement signé (manque : ${missing.join(', ')}).\nImprimer quand même ?`)) return;
    window.print();
  }

  /**
   * Enregistre le dossier du vol (CRM, puis rapport WindPath s'il existe, dans un seul PDF)
   * dans Drone / Année / Mois / jj-mm-aaaa / Vol N (CSB) / sur l'ordinateur.
   * `auto` : lancé après la dernière signature (pas de confirmation ; si le navigateur exige
   * un clic pour autoriser le dossier, un bouton est proposé).
   */
  async function saveLocal(forcePick = false, auto = false) {
    if (!auto && missing.length && !window.confirm(`Le CRM n'est pas entièrement signé (manque : ${missing.join(', ')}).\nEnregistrer quand même ?`)) return;
    const doc = docRef.current;
    if (!doc) return;
    setActionError(null);
    setSaved(null);
    setAutoBlocked(false);
    setSaving(true);
    try {
      // le dossier se choisit tout de suite (le navigateur exige que ce soit juste après le clic)
      const root = archiveSupported() ? await getArchiveRoot(forcePick) : undefined;
      // rang du vol dans la journée pour ce drone
      const same = unwrap(await supabase.from('flights').select('id, takeoff_time').eq('drone_id', f.drone_id).eq('flight_date', f.flight_date)
        .order('takeoff_time').order('created_at')) as { id: string; takeoff_time: string }[];
      const rank = Math.max(1, same.findIndex((x) => x.id === f.id) + 1);
      const { segments, fileName } = crmArchivePath({
        droneCode: crm.drone_code, flightDate: f.flight_date, takeoff: f.takeoff_time, destination: f.destination_name,
        flightType: f.flight_type, rank, crmNo, closed,
      });
      const blob = await crmDocumentToPdf(doc);
      const res = await saveToArchive(segments, fileName, blob, false, root);
      markArchived(f.id);
      setSaved(res);
    } catch (e) {
      // fenêtre de choix du dossier fermée par l'utilisateur : rien à signaler
      if (e instanceof DOMException && e.name === 'AbortError') return;
      // export automatique : le navigateur exige un clic pour ouvrir ou réautoriser le dossier
      if (auto && e instanceof DOMException && (e.name === 'SecurityError' || e.name === 'NotAllowedError')) { setAutoBlocked(true); return; }
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  saveRef.current = saveLocal;
  async function unsign(k: CrmVisaKind) {
    if (!window.confirm('Annuler cette signature ?')) return;
    setActionError(null);
    try { unwrap(await supabase.rpc('unsign_crm', { p_flight: id, p_kind: k })); notifyCrmChanged(); reload(); }
    catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <div className={`crm-page${onReady ? ' crm-offscreen' : ''}`}>
      <div className="crm-toolbar no-print">
        <Link className="btn" to={`/vols/${id}`}>← Fiche du vol</Link>
        <Link className="link-btn" to="/crm/export">Exporter plusieurs CRM…</Link>
        <span className="muted small">{closed ? 'Format A4 · pensez à activer « Graphiques d\'arrière-plan » si les cadres grisés n\'apparaissent pas.' : 'Vol non clôturé : le CRM est provisoire.'}</span>
        <span className="crm-archive">
          {lastArchive && !saved && <span className="archive-done" title="Sur ce poste">✓ enregistré le {new Date(lastArchive).toLocaleDateString('fr-FR')}</span>}
          <button className="btn" onClick={() => saveLocal()} disabled={saving}
            title={archiveSupported() ? 'Enregistre le PDF dans vos dossiers : Drone / Année / Mois / Jour / Vol' : 'Votre navigateur ne permet pas de créer des dossiers : le PDF sera téléchargé'}>
            {saving ? 'Création du PDF…' : '💾 Enregistrer sur l\'ordinateur'}
          </button>
          {archiveSupported() && folder && <button type="button" className="link-btn" onClick={() => saveLocal(true)} title={`Dossier actuel : ${folder}`}>changer de dossier</button>}
        </span>
        <button className="btn btn-primary" onClick={print}>⎙ Imprimer le CRM</button>
      </div>
      {saved && (
        <div className="archive-toast no-print">
          <span>✓</span>
          <span>{saved.mode === 'dossier'
            ? <>PDF enregistré : <code>{saved.path}</code></>
            : <>PDF téléchargé (<code>{saved.path}</code>). Votre navigateur ne permet pas de créer les dossiers automatiquement : utilisez Chrome ou Edge sur ordinateur pour le classement Drone / Année / Mois / Jour / Vol.</>}</span>
        </div>
      )}
      {autoBlocked && (
        <div className="alert alert-info no-print archive-blocked">
          <span>✍ CRM signé : le dossier du vol (CRM{data.windpath ? ' + rapport WindPath' : ''}) est prêt. Le navigateur demande votre accord pour écrire dans le dossier d'archive.</span>
          <button className="btn btn-primary btn-sm" onClick={() => void saveLocal(false, true)}>💾 Enregistrer le dossier du vol</button>
        </div>
      )}
      <ErrorBox error={actionError} />
      {myTurn && (
        <div className="alert alert-warn no-print">✍ Votre signature est attendue sur ce CRM : utilisez le bouton « Signer » dans la section Visas.</div>
      )}
      {closed && openReports > 0 && canTreat && (
        <div className="alert alert-info no-print">
          {openReports} compte(s) rendu(s) à traiter : renseignez la mesure corrective et clôturez-les (bouton « Traiter » en section 5), puis signez le visa « Mesures correctives ».
        </div>
      )}
      <div ref={docRef} className="crm-doc">
      <article ref={sheetRef} className={`crm-sheet${closed ? '' : ' is-draft'}`}>
        <header className="crm-head">
          <UnfpaLogo className="crm-logo" />
          <div className="crm-head-title">
            <div className="crm-org">UNFPA Madagascar · Livraison par drones</div>
            <h1>Compte rendu matériel</h1>
            <div className="crm-sub">CRM · Drone {crm.drone_model}</div>
          </div>
          <div className="crm-no">
            <span className="crm-label">N° CRM</span>
            <strong>{crmNo}</strong>
            <span className="crm-label">{closed ? `Clôturé le ${f.closed_at ? new Date(f.closed_at).toLocaleDateString('fr-FR') : '—'}` : 'PROVISOIRE'}</span>
          </div>
        </header>

        <Box title="1 · Aéronef">
          <Cells items={[
            ['Immatriculation', <strong key="d">{crm.drone_code}</strong>],
            ['Modèle', crm.drone_model],
            ['N° de série', crm.drone_serial ?? '—'],
            ['Drone port', f.drone_port_name ?? '—'],
            ['Vol n° (cellule)', String(crm.flight_seq)],
          ]} />
        </Box>

        <Box title="2 · Vol">
          <Cells items={[
            ['Date', date(f.flight_date)],
            ['Type', LABELS.flightType[f.flight_type]],
            ['Organisation', f.organization_label],
            ['Destination', f.destination_name ?? '—'],
            ['Distance', km(f.distance_km)],
            ['Décollage', time(f.takeoff_time)],
            [f.qrf ? 'Demi-tour (QRF)' : 'Largage', f.qrf ? time(f.qrf_time) : time(f.drop_time)],
            ['Atterrissage', time(f.landing_time)],
            ['Temps de vol', minutes(f.duration_min)],
            ['Charge utile', f.payload_kg != null ? `${num(f.payload_kg, 2)} kg` : '—'],
            ['Altitude croisière', f.cruise_altitude_m != null ? `${num(f.cruise_altitude_m, 0)} m AMSL` : '—'],
            ['Vent moyen', f.avg_wind_ms != null ? `${num(f.avg_wind_ms)} m/s${f.wind_direction_deg != null ? ` ${cardinal(f.wind_direction_deg)}` : ''}` : '—'],
          ]} />
          <div className="crm-crew">
            <span className="crm-label">Équipage</span>
            <span>
              {pilots.length ? pilots.map((p, i) => <span key={p}>{i ? ' · ' : ''}{p} <em>({i ? 'copilote' : 'pilote'})</em></span>) : '—'}
              {f.trainee_name && <span> · {f.trainee_name} <em>(pilote en formation)</em></span>}
            </span>
          </div>
          {f.qrf && (
            <div className="crm-qrf">
              <strong>QRF – retour au drone port</strong> · cause : {f.qrf_cause ? LABELS.qrfCause[f.qrf_cause] : '—'}
              {f.qrf_conditions?.length ? ` · ${f.qrf_conditions.map((c) => LABELS.qrfConditions[c]).join(', ')}` : ''}
              {f.qrf_details && <div>{f.qrf_details}</div>}
            </div>
          )}
        </Box>

        <div className="crm-grid-2">
          <Box title="3 · Potentiel cellule après le vol">
            <table className="crm-table">
              <tbody>
                <tr><th>Heures avant le vol</th><td>{h(crm.hours_before)}</td></tr>
                <tr><th>Temps de ce vol</th><td>+ {hm(Number(crm.flight_minutes) / 60)}</td></tr>
                <tr className="crm-strong"><th>Heures totales après le vol</th><td>{h(crm.hours_after)}</td></tr>
                <tr><th>Dernière visite systématique</th><td>{crm.last_visit_hours != null ? `${h(crm.last_visit_hours)} · ${date(crm.last_visit_date)}` : 'Aucune'}</td></tr>
                <tr><th>Prochaine visite ({num(crm.visit_interval_hours, 0)} h)</th><td>à {h(crm.next_visit_hours)}</td></tr>
                <tr className={`crm-strong crm-${visitLevel}`}><th>Potentiel restant</th>
                  <td>{h(crm.hours_to_next_visit)}{visitLevel === 'danger' ? ' · VISITE DÉPASSÉE' : visitLevel === 'warn' ? ' · visite à prévoir' : ''}</td></tr>
              </tbody>
            </table>
          </Box>

          <Box title="4 · Énergie">
            <table className="crm-table">
              <tbody>
                <tr><th>Pack</th><td>{f.pack_number ? `Pack ${f.pack_number}` : '—'}</td></tr>
                {crm.batteries.map((b) => (
                  <tr key={b.code}><th>Batterie {b.code}</th>
                    <td>{b.cycles_after} / {b.max_cycles} cycles{b.measured_mah ? ` · ${num(b.measured_mah, 0)} mAh mesurés` : ''}
                      {b.cycles_after >= b.max_cycles ? ' · LIMITE ATTEINTE' : ''}</td></tr>
                ))}
                <tr><th>Consommation</th><td>{f.consumption_mah != null ? `${num(f.consumption_mah, 0)} mAh${pack ? ` · ${num((100 * Number(f.consumption_mah)) / pack, 0)} % du pack` : ''}` : '—'}</td></tr>
                <tr><th>Tension départ</th><td>{volts(f.voltage_start_v)}{f.voltage_start_v != null && <span className="crm-muted"> · {cellText(f.voltage_start_v)}</span>}</td></tr>
                <tr><th>Tension arrivée</th><td>{volts(f.voltage_end_v)}{f.voltage_end_v != null && <span className="crm-muted"> · {cellText(f.voltage_end_v)}</span>}</td></tr>
              </tbody>
            </table>
          </Box>
        </div>

        <Box title="5 · Comptes rendus techniques et incidents">
          {reports.length === 0 ? (
            <div className="crm-ras">RAS <span>Rien à signaler</span></div>
          ) : (
            <table className="crm-table crm-reports">
              <thead><tr><th>N°</th><th>Type</th><th>Gravité</th><th>Composant</th><th>Constat</th><th>Mesure corrective</th><th>Statut</th>{canTreat && closed && <th className="no-print" />}</tr></thead>
              <tbody>
                {reports.map((r, i) => (
                  <tr key={r.id}>
                    <td>{i + 1}</td>
                    <td>{LABELS.reportType[r.report_type]}</td>
                    <td>{LABELS.severity[r.severity]}</td>
                    <td>{r.component ?? '—'}</td>
                    <td className="crm-text">{r.description}</td>
                    <td className="crm-text">{r.corrective_action ?? '—'}</td>
                    <td>{LABELS.reportStatus[r.status]}{r.status === 'clos' && <span className="crm-muted">{r.resolved_on ? ` le ${date(r.resolved_on)}` : ''}{r.resolved_by_name ? ` par ${r.resolved_by_name}` : ''}</span>}</td>
                    {canTreat && closed && (
                      <td className="no-print">{r.status === 'clos' && !isAdmin
                        ? <span className="small muted nowrap" title="Seul un administrateur peut modifier un rapport clôturé">🔒</span>
                        : <button type="button" className="btn btn-sm" onClick={() => setEditReport(r)}>{r.status === 'clos' ? 'Modifier' : '✎ Traiter'}</button>}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Box>

        <Box title={`6 · Pièces montées · heures après le vol${partAlerts.length ? ` · ${partAlerts.length} alerte(s) potentiel` : ''}`}>
          {crm.parts.length === 0 ? <p className="crm-muted">Aucune pièce suivie montée sur le drone au moment du vol.</p> : (
            <table className="crm-table crm-parts">
              <thead><tr><th>Code</th><th>Pièce</th><th>Emplacement</th><th className="num">Heures</th><th className="num">Potentiel</th><th className="num">Reste</th></tr></thead>
              <tbody>
                {crm.parts.map((p) => {
                  const s = partState(p);
                  return (
                    <tr key={p.code} className={s.level ? `crm-${s.level}` : ''}>
                      <td><strong>{p.code}</strong></td><td>{p.type_name}</td><td>{p.slot_label ?? '—'}</td>
                      <td className="num">{h(p.hours_after)}</td>
                      <td className="num">{p.max_hours != null ? h(p.max_hours) : 'non défini'}</td>
                      <td className="num">{p.max_hours != null ? `${h(p.max_hours - p.hours_after)}${s.level === 'danger' ? ' · DÉPASSÉ' : ''}` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Box>

        <Box title="7 · Observations">
          <p className="crm-text crm-obs">{f.observation?.trim() || 'Néant'}</p>
        </Box>

        <Box title="8 · Visas" className="crm-sign-box">
          <div className="crm-signs" style={{ gridTemplateColumns: `repeat(${visas.length}, minmax(0, 1fr))` }}>
            {visas.map((v) => {
              const s = sig(v.kind);
              const signedAt = s ? new Date(s.signed_at) : null;
              return (
                <div key={v.kind} className="crm-sign">
                  <span className="crm-label">{v.title}</span>
                  <div className="crm-sign-line">Nom : {s ? <strong>{s.signer_name}</strong> : v.expected ? <strong>{v.expected}</strong> : ''}</div>
                  <div className="crm-sign-line">Date : {signedAt ? <strong>{signedAt.toLocaleDateString('fr-FR')}</strong> : ''}</div>
                  <div className={`crm-sign-area${s ? ' is-signed' : ''}`}>
                    {s ? (
                      <>
                        <span className="crm-signature">{s.signer_name}</span>
                        <span className="crm-sign-meta">
                          Signé électroniquement le {signedAt!.toLocaleDateString('fr-FR')} à {signedAt!.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        {canUnsign(s) && <button type="button" className="crm-unsign no-print" onClick={() => unsign(v.kind)}>Annuler la signature</button>}
                      </>
                    ) : v.canSign ? (
                      <button type="button" className="btn btn-primary crm-sign-btn no-print" onClick={() => setSigning(v.kind)}>
                        <Icon name="pen" size={16} /> Signer
                      </button>
                    ) : (
                      <span className="crm-sign-placeholder">
                        Signature{!closed ? ' (après clôture du vol)' : v.kind === 'rapports' && openReports ? ` · en attente de la clôture de ${openReports} compte(s) rendu(s)` : ''}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="crm-muted crm-cert">
            {copilot ? 'Le commandant de bord et le copilote certifient' : 'Le commandant de bord certifie'} l'exactitude des informations du vol.
            {reports.length > 0 && ' Le pilote signataire des mesures correctives atteste que les comptes rendus ci-dessus ont été traités et clôturés.'}
          </p>
        </Box>
        <footer className="crm-foot">
          <span>CRM {crmNo} · {crm.drone_code} · vol du {date(f.flight_date)} à {time(f.takeoff_time)}</span>
          <span>Édité le {new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} · UAV Maintenance</span>
        </footer>
      </article>
      {/* annexe : rapport de vol WindPath (même PDF, nouvelle page) */}
      {data.windpath && (
        <WindpathReport record={data.windpath} flight={{
          crmNo, droneCode: crm.drone_code, flightDate: f.flight_date, takeoffTime: f.takeoff_time, destination: f.destination_name,
          pilots, portName: f.drone_port_name, consumptionMah: f.consumption_mah, voltageEndV: f.voltage_end_v,
        }} />
      )}
      </div>

      {signing && (
        <SignModal kind={signing} crmNo={crmNo} name={pilot?.full_name ?? session.user.email ?? ''} reportCount={reports.length}
          onClose={() => setSigning(null)}
          onSigned={() => { setSigning(null); notifyCrmChanged(); setAutoExport(data.signatures.length + 1); reload(); }}
          flightId={id} />
      )}
      {editReport && (
        <ReportModal flightId={id} report={editReport} onClose={() => setEditReport(null)}
          onSaved={() => { setEditReport(null); notifyCrmChanged(); reload(); }} />
      )}
    </div>
  );
}

/** Visas encore attendus : commandant de bord, copilote (s'il y en a un), mesures correctives (s'il y a des rapports) */
function missingVisas(d: { crew: { role: string }[]; reports: unknown[]; signatures: CrmSignature[] }): CrmVisaKind[] {
  const expected: CrmVisaKind[] = ['pilote', ...(d.crew.some((c) => c.role === 'copilote') ? ['copilote' as const] : []), ...(d.reports.length ? ['rapports' as const] : [])];
  const signed = new Set(d.signatures.map((s) => s.kind));
  return expected.filter((k) => !signed.has(k));
}

const VISA_TEXT: Record<CrmVisaKind, { title: string; text: (n: number) => string }> = {
  pilote: { title: 'commandant de bord', text: () => 'Je certifie l\'exactitude des informations de ce vol portées sur le compte rendu matériel.' },
  copilote: { title: 'copilote', text: () => 'Je certifie l\'exactitude des informations de ce vol portées sur le compte rendu matériel.' },
  rapports: { title: 'mesures correctives et clôture des comptes rendus',
    text: (n) => `J'atteste que ${n > 1 ? `les ${n} comptes rendus techniques et incidents de ce vol ont été traités` : 'le compte rendu technique ou incident de ce vol a été traité'}, que les mesures correctives indiquées ont été réalisées, et ${n > 1 ? 'qu\'ils sont clôturés' : 'qu\'il est clôturé'}.` },
};

/** Confirmation de signature : rappel de l'engagement du signataire. */
function SignModal({ kind, crmNo, name, reportCount, flightId, onClose, onSigned }: {
  kind: CrmVisaKind; crmNo: string; name: string; reportCount: number; flightId: string;
  onClose: () => void; onSigned: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sign() {
    setBusy(true); setError(null);
    try {
      unwrap(await supabase.rpc('sign_crm', { p_flight: flightId, p_kind: kind }));
      onSigned();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Signer le CRM ${crmNo}`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose} disabled={busy}>Annuler</button>
        <button className="btn btn-primary" onClick={sign} disabled={busy}><Icon name="pen" size={16} /> {busy ? 'Signature…' : 'Signer'}</button>
      </>}>
      <ErrorBox error={error} />
      <p>Visa <strong>{VISA_TEXT[kind].title}</strong></p>
      <p className="muted">{VISA_TEXT[kind].text(reportCount)}</p>
      <div className="crm-sign-preview">
        <span className="crm-label">Votre signature</span>
        <span className="crm-signature">{name}</span>
        <span className="small muted">Elle sera apposée avec la date et l'heure. Seuls vous et un administrateur pourrez l'annuler.</span>
      </div>
    </Modal>
  );
}