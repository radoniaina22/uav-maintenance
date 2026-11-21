import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { useApp } from '../lib/app';
import type { Drone, FlightPlan, HealthFacility } from '../lib/types';
import { Badge, ErrorBox, Field, Modal } from '../components/ui';
import { Icon } from '../components/icons';
import {
  FlightNavState, HistoryFlight, historyStats, HistoryStats, PlanFile, PlanningLayout, PlanningNavState, planVerdict, SOURCE_LABEL,
  TransferField, transferFields, WindpathLive, WindpathResult, WindpathStatus,
} from '../lib/windpath';
import { useLiveTraffic } from '../lib/liveTraffic';

const WINDPATH_URL = './windpath/index.html';
const LAYOUT_KEY = 'uav.planning.layout';
/** dernier drone choisi sur ce laptop (un laptop sert en général au même drone) */
const DRONE_KEY = 'uav.planning.drone';
const LAYOUTS: { id: PlanningLayout; label: string; title: string }[] = [
  { id: 'map', label: 'Préparer', title: 'Préparer la route : carte en grand, tableau réduit (Alt+1)' },
  { id: 'balanced', label: 'Mixte', title: 'Carte, graphiques et tableau ; hauteur du tableau réglable en tirant son bord (Alt+2)' },
  { id: 'entry', label: 'Saisie', title: 'Après le vol : réglages rangés, tableau sur toute la largeur pour saisir les mAh et tensions réels (Alt+3, Entrée = point suivant)' },
];

type PlanMeta = Omit<FlightPlan, 'content'>;
const PLAN_COLS = 'id, drone_port_id, destination_id, name, file_name, waypoint_count, distance_km, notes, active, created_by, created_at, updated_at';

const fr = (v: number | null | undefined, d = 1) => (v == null ? '—' : v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }));
const mah = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v).toLocaleString('fr-FR')} mAh`);
const minutes = (v: number | null | undefined) => (v == null ? '—' : `${Math.floor(v / 60)} h ${String(Math.round(v % 60)).padStart(2, '0')}`);
const ago = (ts: number) => {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? 'à l\'instant' : m < 60 ? `il y a ${m} min` : m < 1440 ? `il y a ${Math.round(m / 60)} h` : `il y a ${Math.round(m / 1440)} j`;
};
const readLayout = (): PlanningLayout => {
  try { const v = localStorage.getItem(LAYOUT_KEY); return v === 'map' || v === 'entry' ? v : 'balanced'; } catch { return 'balanced'; }
};

export default function Planning() {
  const nav = useNavigate();
  const loc = useLocation();
  const { ports, portFilter, myPort, isAdmin, session } = useApp();
  const incoming = (loc.state ?? null) as PlanningNavState | null;
  const frame = useRef<HTMLIFrameElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [prefillInfo, setPrefillInfo] = useState<string[] | null>(null);
  const [restored, setRestored] = useState<{ missionName: string | null; savedAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fields, setFields] = useState<TransferField[] | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [keepEstimate, setKeepEstimate] = useState(true);
  const [result, setResult] = useState<WindpathResult | null>(null);
  const [status, setStatus] = useState<WindpathStatus | null>(null);
  const [layout, setLayout] = useState<PlanningLayout>(readLayout);
  const [details, setDetails] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  // drone port et destination de la planification
  const portId = incoming?.portId || portFilter || myPort?.id || '';
  const port = ports.find((p) => p.id === portId) ?? null;
  const [destinationId, setDestinationId] = useState<string>(incoming?.destinationId ?? '');
  const [facilities, setFacilities] = useState<HealthFacility[]>([]);
  const [plans, setPlans] = useState<PlanMeta[]>([]);
  const [planId, setPlanId] = useState('');
  const [library, setLibrary] = useState(false);
  const [saveDialog, setSaveDialog] = useState<PlanFile | null>(null);
  const [history, setHistory] = useState<HistoryStats | null>(null);
  const [historyRows, setHistoryRows] = useState<HistoryFlight[] | null>(null);

  const post = useCallback((msg: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ source: 'uav', ...msg }, window.location.origin);
  }, []);

  // ------------------------------------------------------------------
  // Drone du vol : partage de la position avec le drone port (trafic)
  // repris du formulaire de vol, sinon dernier drone choisi sur ce laptop
  // ------------------------------------------------------------------
  const [drones, setDrones] = useState<Pick<Drone, 'id' | 'code' | 'drone_port_id'>[]>([]);
  const [droneId, setDroneId] = useState<string>(() => {
    const fromFlight = incoming?.droneId || (incoming?.draft as { drone_id?: string } | undefined)?.drone_id;
    if (fromFlight) return fromFlight;
    try { return localStorage.getItem(DRONE_KEY) ?? ''; } catch { return ''; }
  });
  useEffect(() => {
    let q = supabase.from('drones').select('id, code, drone_port_id').neq('status', 'retire').order('code');
    if (portId) q = q.eq('drone_port_id', portId);
    void q.then(({ data }) => setDrones((data ?? []) as Pick<Drone, 'id' | 'code' | 'drone_port_id'>[]));
  }, [portId]);
  // drone mémorisé qui n'est plus dans ce drone port : non partagé
  useEffect(() => { if (drones.length && droneId && !drones.some((d) => d.id === droneId)) setDroneId(''); }, [drones, droneId]);
  const chooseDrone = (id: string) => {
    setDroneId(id);
    try { if (id) localStorage.setItem(DRONE_KEY, id); else localStorage.removeItem(DRONE_KEY); } catch { /* sans stockage */ }
  };
  const drone = drones.find((d) => d.id === droneId) ?? null;
  const live = useLiveTraffic({
    portId, droneId: drone ? droneId : '', dronePortId: drone?.drone_port_id ?? null, droneCode: drone?.code ?? null,
    userId: session.user.id, ready, post,
  });
  const shareLive = live.share;

  // ------------------------------------------------------------------
  // Données : destinations, plans, historique
  // ------------------------------------------------------------------
  useEffect(() => {
    let q = supabase.from('health_facilities').select('*').eq('active', true).order('name');
    if (portId) q = q.or(`drone_port_id.eq.${portId},drone_port_id.is.null`);
    q.then(({ data }) => setFacilities((data ?? []) as HealthFacility[]));
  }, [portId]);

  const loadPlans = useCallback(async () => {
    let q = supabase.from('flight_plans').select(PLAN_COLS).eq('active', true).order('name');
    if (portId) q = q.eq('drone_port_id', portId);
    const { data } = await q;
    setPlans((data ?? []) as PlanMeta[]);
  }, [portId]);
  useEffect(() => { void loadPlans(); }, [loadPlans]);

  const destPlans = useMemo(() => plans.filter((p) => !destinationId || p.destination_id === destinationId), [plans, destinationId]);
  useEffect(() => { if (planId && !destPlans.some((p) => p.id === planId)) setPlanId(''); }, [destPlans, planId]);

  useEffect(() => {
    setHistory(null); setHistoryRows(null);
    if (!destinationId) return;
    let alive = true;
    supabase.from('v_flights').select('consumption_mah, duration_min, avg_wind_ms, payload_kg, distance_km, voltage_end_v, flight_date')
      .eq('destination_id', destinationId).eq('qrf', false).not('consumption_mah', 'is', null)
      .order('flight_date', { ascending: false }).limit(300)
      .then(({ data }) => { if (alive) setHistoryRows((data ?? []) as HistoryFlight[]); });
    return () => { alive = false; };
  }, [destinationId]);
  useEffect(() => { setHistory(historyRows ? historyStats(historyRows, status?.payloadKg) : null); }, [historyRows, status?.payloadKg]);

  // ------------------------------------------------------------------
  // Messages de WindPath
  // ------------------------------------------------------------------
  const onLoad = useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (!doc) { setError('WindPath n\'a pas pu être chargé.'); return; }
    const s = doc.createElement('script');
    s.src = new URL('windpath-bridge.js', document.baseURI).href;
    doc.body.appendChild(s);
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== frame.current?.contentWindow) return;
      const msg = e.data as { source?: string; type?: string; applied?: string[]; data?: unknown; ok?: boolean; error?: string; name?: string; count?: number; missionName?: string | null; savedAt?: number };
      if (msg?.source !== 'windpath') return;
      if (msg.type === 'ready') {
        setReady(true);
        post({ type: 'layout', mode: layout });
        const center: [number, number] | null = port?.latitude != null && port.longitude != null ? [Number(port.latitude), Number(port.longitude)] : null;
        const prefill = { ...(incoming?.prefill ?? {}), center: incoming?.prefill?.center ?? center };
        if (incoming?.prefill || center) post({ type: 'prefill', payload: prefill });
      }
      if (msg.type === 'layout') { const m = (msg as { mode?: PlanningLayout }).mode; if (m) { setLayout(m); try { localStorage.setItem(LAYOUT_KEY, m); } catch { /* sans stockage */ } } }
      if (msg.type === 'restored') setRestored({ missionName: msg.missionName ?? null, savedAt: msg.savedAt ?? Date.now() });
      if (msg.type === 'prefilled') setPrefillInfo((msg.applied ?? []).filter((a) => a !== 'carte centrée sur le drone port' || !!incoming?.prefill));
      if (msg.type === 'status') setStatus(msg.data as WindpathStatus);
      if (msg.type === 'live') void shareLive((msg.data ?? null) as WindpathLive | null);
      if (msg.type === 'planLoaded') {
        if (msg.ok) { setNotice(`Plan « ${msg.name} » chargé (${msg.count} points). Pensez à vérifier le vent.`); setRestored(null); setError(null); }
        else setError(msg.error ?? 'Plan illisible.');
      }
      if (msg.type === 'planFile') {
        const f = msg.data as PlanFile;
        if (f.error) setError(f.error); else setSaveDialog(f);
      }
      if (msg.type === 'result' && msg.data) {
        const data = msg.data as WindpathResult;
        if (data.error) { setError(data.error); return; }
        const list = transferFields(data);
        const dest = facilities.find((f) => f.id === destinationId);
        const draftDest = (incoming?.draft as { destination_id?: string } | undefined)?.destination_id;
        if (dest && dest.id !== draftDest) list.unshift({ key: 'destination_id', label: 'Destination', value: dest.id, display: dest.name, source: 'plan' });
        if (!list.length) { setError('Aucune donnée exploitable dans WindPath pour le moment.'); return; }
        setResult(data);
        setFields(list);
        setKeepEstimate(Boolean(data.estimate && data.estimate.consumptionMah != null));
        // par défaut : tout est coché sauf les estimations d'heures, de consommation et de tension d'arrivée
        setChecked(Object.fromEntries(list.map((f) => [f.key,
          !(f.source === 'estime' && ['drop_time', 'landing_time', 'consumption_mah', 'voltage_end_v'].includes(f.key))])));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [incoming, port, post, facilities, destinationId, layout, shareLive]);

  // disposition carte / tableau : mémorisée et transmise à WindPath
  const chooseLayout = (mode: PlanningLayout) => {
    setLayout(mode);
    try { localStorage.setItem(LAYOUT_KEY, mode); } catch { /* sans stockage */ }
    post({ type: 'layout', mode });
  };

  // Alt+1 / Alt+2 / Alt+3 depuis la page (WindPath gère les mêmes raccourcis quand il a le focus)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const mode = ({ Digit1: 'map', Digit2: 'balanced', Digit3: 'entry' } as Record<string, PlanningLayout>)[e.code];
      if (mode) { e.preventDefault(); chooseLayout(mode); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // plein écran de la page (WindPath + barre), en gardant la passerelle
  useEffect(() => {
    const on = () => setFullscreen(document.fullscreenElement === shell.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void shell.current?.requestFullscreen?.().catch(() => setError('Plein écran refusé par le navigateur.'));
  };

  // panneau de détails : fermé au clic à l'extérieur, dans WindPath (la page perd le focus) ou avec Échap
  useEffect(() => {
    if (!details) return;
    const close = () => setDetails(false);
    const onDown = (e: MouseEvent) => { if (!detailsRef.current?.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('blur', close);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('blur', close); document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [details]);

  // messages brefs : disparaissent seuls
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(null), 6000); return () => clearTimeout(t); }, [notice]);
  useEffect(() => { if (!prefillInfo) return; const t = setTimeout(() => setPrefillInfo(null), 9000); return () => clearTimeout(t); }, [prefillInfo]);

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------
  function requestResult() { setError(null); post({ type: 'request' }); }

  async function loadPlan(id: string) {
    setError(null); setNotice(null);
    try {
      const p = unwrap(await supabase.from('flight_plans').select('*').eq('id', id).single()) as FlightPlan;
      setPlanId(p.id);
      if (p.destination_id && !destinationId) setDestinationId(p.destination_id);
      post({ type: 'loadPlan', plan: { id: p.id, name: p.name, fileName: p.file_name, content: p.content } });
      setLibrary(false);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  function transfer() {
    if (!fields) return;
    const chosen = fields.filter((f) => checked[f.key]);
    const state: FlightNavState = {
      draft: incoming?.draft,
      windpath: Object.fromEntries(chosen.map((f) => [f.key, f.value])),
      windpathLabels: chosen.map((f) => `${f.label} : ${f.display}${f.source === 'estime' ? ' (estimé)' : ''}`),
      estimate: keepEstimate && result?.estimate ? result.estimate : null,
    };
    nav(incoming?.returnTo ?? '/vols/nouveau', { state });
  }

  const verdict = planVerdict(status, history);
  const currentPlan = plans.find((p) => p.id === status?.planId) ?? null;
  const estimateVsHistory = history && status?.estimatedMah != null ? Math.round((status.estimatedMah / (history.similar?.medianMah ?? history.medianMah) - 1) * 100) : null;
  const hasMission = Boolean(status?.waypointCount);
  const level = verdict.level === 'none' ? 'none' : verdict.level;
  const warnCount = verdict.reasons.length;

  return (
    <div className={`planning${fullscreen ? ' is-fullscreen' : ''}`} ref={shell}>
      {/* Barre unique : contexte · route · verdict · disposition · actions */}
      <div className="pl-bar">
        {incoming?.returnTo && (
          <div className="pl-bar-title">
            <Link className="pl-icon-btn" to={incoming.returnTo} state={{ draft: incoming.draft } satisfies FlightNavState} title="Retour au vol sans reporter">←</Link>
            {incoming.context && <div><strong>{incoming.context}</strong></div>}
          </div>
        )}

        <div className={`pl-bar-route${incoming?.returnTo ? '' : ' is-first'}`}>
          <div className="pl-joined pl-drone" title={live.sharing ? `Position partagée avec le drone port${live.others.length ? ` · ${live.others.length} autre(s) vol(s) en cours` : ''}` : (live.reason ?? '')}>
            <span className={`pl-share${live.sharing ? ' on' : droneId ? ' warn' : ''}`} aria-hidden="true" />
            <select className="pl-select" value={drone ? droneId : ''} onChange={(e) => chooseDrone(e.target.value)} aria-label="Drone du vol (partage de la position)">
              <option value="">Drone…</option>
              {drones.map((d) => <option key={d.id} value={d.id}>{d.code}</option>)}
            </select>
          </div>
          <select className="pl-select" value={destinationId} onChange={(e) => setDestinationId(e.target.value)} aria-label="Destination" title="Destination (historique et plans)">
            <option value="">Destination…</option>
            {facilities.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <div className="pl-joined">
            <select className="pl-select" value={planId} onChange={(e) => setPlanId(e.target.value)} disabled={!destPlans.length} aria-label="Plan enregistré">
              <option value="">{destPlans.length ? `Plan (${destPlans.length})…` : 'Aucun plan'}</option>
              {destPlans.map((p) => <option key={p.id} value={p.id}>{p.name}{p.distance_km != null ? ` · ${fr(Number(p.distance_km))} km` : ''}</option>)}
            </select>
            <button className="pl-icon-btn" disabled={!planId || !ready} onClick={() => void loadPlan(planId)} title="Charger le plan dans WindPath">↧</button>
          </div>
          <button className="pl-icon-btn" disabled={!ready || !hasMission} onClick={() => post({ type: 'exportPlan' })} title="Enregistrer la mission affichée dans la bibliothèque">💾</button>
          <button className="pl-icon-btn pl-count" onClick={() => setLibrary(true)} title="Bibliothèque de plans"><Icon name="book" size={15} />{plans.length > 0 && <small>{plans.length}</small>}</button>
        </div>

        {/* verdict : pastille cliquable, détail dans le panneau déroulant */}
        <div className="pl-verdict-wrap" ref={detailsRef}>
          <button className={`pl-pill lv-${level}`} onClick={() => setDetails((v) => !v)} aria-expanded={details} title="Détail du verdict et de l'historique">
            <i />
            <b>{verdict.label}</b>
            {hasMission && status && (
              <span className="pl-pill-figs">
                {status.maxWindMs != null && <>{fr(status.maxWindMs)} m/s</>}
                {status.marginPct != null && <> · marge {Math.round(status.marginPct)} %</>}
                {status.maxWindMs == null && status.marginPct == null && <>{status.waypointCount} pts</>}
              </span>
            )}
            {warnCount > 0 && <span className="pl-pill-n">{warnCount}</span>}
            <span className="pl-caret">▾</span>
          </button>

          {details && (
            <div className="pl-pop" role="dialog" aria-label="Détail de la mission">
              <div className="pl-pop-head">
                <strong>{status?.missionName ?? 'Mission'}</strong>
                {status?.modified && <span className="small muted">modifiée</span>}
              </div>
              {hasMission && status ? (
                <dl className="pl-stats">
                  <div><dt>Route</dt><dd>{status.waypointCount} pts · {fr(status.distanceKm)} km</dd></div>
                  <div className={(status.maxWindMs ?? 0) > 12 ? 'danger' : (status.maxWindMs ?? 0) > 8 ? 'warn' : ''}><dt>Vent max</dt><dd>{status.maxWindMs == null ? '—' : `${fr(status.maxWindMs)} m/s`}{status.maxWindWp ? <small> pt {status.maxWindWp}</small> : null}</dd></div>
                  <div className={(status.maxGustMs ?? 0) > 15 ? 'danger' : ''}><dt>Rafale</dt><dd>{status.maxGustMs == null ? '—' : `${fr(status.maxGustMs)} m/s`}</dd></div>
                  <div className={status.marginPct != null && status.marginPct < 0 ? 'danger' : status.marginPct != null && status.marginPct < 10 ? 'warn' : ''}><dt>Consommation</dt><dd>{mah(status.estimatedMah)}</dd></div>
                  <div className={status.marginPct != null && status.marginPct < 0 ? 'danger' : status.marginPct != null && status.marginPct < 10 ? 'warn' : ''}><dt>Marge (réserve 20 %)</dt><dd>{status.marginPct == null ? '—' : `${Math.round(status.marginPct)} %`}</dd></div>
                  <div><dt>Durée</dt><dd>{minutes(status.durationMin)}</dd></div>
                  <div className={!status.windChecked || (status.windCheckAgeMin ?? 0) > 60 ? 'warn' : ''}><dt>Vent vérifié</dt><dd>{!status.windChecked ? 'non' : (status.windCheckAgeMin ?? 0) < 1 ? 'à l\'instant' : `il y a ${status.windCheckAgeMin} min`}</dd></div>
                  <div><dt>Valeurs réelles</dt><dd>{status.realCount ?? 0} / {status.waypointCount} pts</dd></div>
                </dl>
              ) : <p className="small muted">Importez un plan dans WindPath, chargez-en un de la bibliothèque ou cliquez sur la carte.</p>}
              {verdict.reasons.length > 0 && (
                <ul className="pl-reasons">{verdict.reasons.map((r, i) => <li key={i} className={`lv-${r.level}`}>{r.text}</li>)}</ul>
              )}

              <div className="pl-pop-sep"><Icon name="stats" size={14} /> Vos vols réels vers la destination</div>
              {!destinationId ? <p className="small muted">Choisissez la destination dans la barre pour comparer l'estimation à vos vols passés.</p>
                : historyRows == null ? <p className="small muted">Chargement…</p>
                : !history ? <p className="small muted">Aucun vol avec consommation vers cette destination.</p>
                : (
                  <>
                    <dl className="pl-stats pl-stats-4">
                      <div><dt>Médiane</dt><dd>{mah(history.similar?.medianMah ?? history.medianMah)}</dd></div>
                      <div title="90 % des vols ont consommé au plus cette valeur"><dt>90 % ≤</dt><dd>{mah(history.p90Mah)}</dd></div>
                      <div><dt>Durée</dt><dd>{minutes(history.medianDurationMin)}</dd></div>
                      <div><dt>Vent</dt><dd>{history.medianWindMs == null ? '—' : `${fr(history.medianWindMs)} m/s`}</dd></div>
                    </dl>
                    <p className="small muted">
                      {history.n} vol(s){history.similar ? ` · médiane sur ${history.similar.n} vols à ${fr(history.similar.payloadKg, 1)} kg ± 0,5` : ''} · dernier le {history.lastDate.split('-').reverse().join('/')}
                      {estimateVsHistory != null && (
                        <> · WindPath <b className={estimateVsHistory < -15 ? 'text-warn' : ''}>{estimateVsHistory > 0 ? '+' : ''}{estimateVsHistory} %</b></>
                      )}
                    </p>
                  </>
                )}
            </div>
          )}
        </div>

        <div className="pl-bar-end">
          <div className="pl-seg" role="group" aria-label="Disposition">
            {LAYOUTS.map((l) => (
              <button key={l.id} className={layout === l.id ? 'on' : ''} onClick={() => chooseLayout(l.id)} title={l.title} aria-pressed={layout === l.id}>
                {l.label}{l.id === 'entry' && hasMission && status?.realCount ? <small>{status.realCount}/{status.waypointCount}</small> : null}
              </button>
            ))}
          </div>
          <button className="pl-icon-btn" onClick={toggleFullscreen} title={fullscreen ? 'Quitter le plein écran' : 'Plein écran (Échap pour sortir)'}>{fullscreen ? '⤡' : '⤢'}</button>
          <button className="btn btn-primary btn-sm pl-go" onClick={requestResult} disabled={!ready || !hasMission}>
            {incoming?.returnTo ? 'Reporter dans le vol →' : 'Créer un vol →'}
          </button>
        </div>
      </div>

      <div className="pl-stage">
        {/* messages flottants : ne décalent pas WindPath */}
        <div className="pl-toasts" aria-live="polite">
          {restored && (
            <div className="pl-toast">
              <span>↺ Mission retrouvée{restored.missionName ? <> : <strong>{restored.missionName}</strong></> : null} <span className="muted">({ago(restored.savedAt)})</span></span>
              <button className="btn btn-ghost btn-sm" onClick={() => setRestored(null)}>Garder</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { post({ type: 'clear' }); setRestored(null); }}>Repartir de zéro</button>
            </div>
          )}
          {prefillInfo && prefillInfo.length > 0 && (
            <div className="pl-toast">
              <span>✓ Repris du vol : {prefillInfo.join(' · ')}</span>
              <button className="pl-x" onClick={() => setPrefillInfo(null)} aria-label="Fermer">✕</button>
            </div>
          )}
          {notice && (
            <div className="pl-toast ok"><span>{notice}</span><button className="pl-x" onClick={() => setNotice(null)} aria-label="Fermer">✕</button></div>
          )}
          {error && (
            <div className="pl-toast danger"><span>{error}</span><button className="pl-x" onClick={() => setError(null)} aria-label="Fermer">✕</button></div>
          )}
        </div>
        <iframe ref={frame} className={`planning-frame${ready ? ' is-ready' : ''}`} src={WINDPATH_URL} title="WindPath – planificateur de vent et d'énergie" onLoad={onLoad} />
      </div>

      {fields && result && (
        <Modal title={incoming?.returnTo ? 'Reporter dans le vol' : 'Créer un vol avec les données WindPath'} onClose={() => setFields(null)}
          footer={<>
            <button className="btn" onClick={() => setFields(null)}>Annuler</button>
            <button className="btn btn-primary" onClick={transfer} disabled={!Object.values(checked).some(Boolean) && !keepEstimate}>
              Reporter {Object.values(checked).filter(Boolean).length} valeur(s)
            </button>
          </>}>
          <p className="small muted">
            {result.missionName ? <>Mission <strong>{result.missionName}</strong> · </> : null}
            {result.waypointCount} point(s) de passage
            {!result.windChecked && <> · <span className="text-warn">vent non encore calculé (« Check waypoint winds »)</span></>}
          </p>
          <div className="transfer-list">
            {fields.map((f) => (
              <label key={f.key} className={`transfer-row${checked[f.key] ? ' active' : ''}`}>
                <input type="checkbox" checked={!!checked[f.key]} onChange={(e) => setChecked({ ...checked, [f.key]: e.target.checked })} />
                <span className="transfer-label">{f.label}</span>
                <strong>{f.display}</strong>
                <Badge level={f.source === 'reel' ? 'ok' : f.source === 'estime' ? 'warn' : 'info'}>{SOURCE_LABEL[f.source]}</Badge>
              </label>
            ))}
          </div>
          {result.estimate && (result.estimate.consumptionMah != null ? (
            <label className={`transfer-row pl-keep${keepEstimate ? ' active' : ''}`}>
              <input type="checkbox" checked={keepEstimate} onChange={(e) => setKeepEstimate(e.target.checked)} />
              <span className="transfer-label">Enregistrer l'estimation avec le vol</span>
              <strong>{mah(result.estimate.consumptionMah)} · {minutes(result.estimate.durationMin)}</strong>
              <Badge level="info">prévu / réel</Badge>
            </label>
          ) : (
            <p className="small text-warn">Pas encore d'estimation d'énergie : lancez « Check waypoint winds » dans WindPath pour pouvoir la comparer au réel après le vol.</p>
          ))}
          <p className="small muted">
            Les estimations (heures prévues, consommation, tension) sont décochées par défaut : un vol enregistre des valeurs réelles.
            L'estimation complète est conservée à part et comparée au réel sur la fiche du vol.
          </p>
        </Modal>
      )}

      {library && (
        <PlanLibrary plans={plans} facilities={facilities} destinationId={destinationId} canLoad={ready}
          onLoad={(id) => void loadPlan(id)} onClose={() => setLibrary(false)} onChanged={() => void loadPlans()} />
      )}

      {saveDialog && (
        <SavePlanDialog file={saveDialog} facilities={facilities} ports={ports} isAdmin={isAdmin}
          defaultPort={portId} defaultDestination={destinationId} current={currentPlan}
          onClose={() => setSaveDialog(null)}
          onSaved={(p) => { setSaveDialog(null); setNotice(`Plan « ${p.name} » enregistré dans la bibliothèque.`); setPlanId(p.id); if (p.destination_id) setDestinationId(p.destination_id); void loadPlans(); }} />
      )}
    </div>
  );
}


// ---------------------------------------------------------------------
// Bibliothèque de plans
// ---------------------------------------------------------------------
function PlanLibrary({ plans, facilities, destinationId, canLoad, onLoad, onClose, onChanged }: {
  plans: PlanMeta[]; facilities: HealthFacility[]; destinationId: string; canLoad: boolean;
  onLoad: (id: string) => void; onClose: () => void; onChanged: () => void;
}) {
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const name = (id: string | null) => facilities.find((f) => f.id === id)?.name ?? 'Sans destination';
  const list = plans
    .filter((p) => !q || `${p.name} ${name(p.destination_id)} ${p.file_name}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number(b.destination_id === destinationId) - Number(a.destination_id === destinationId) || name(a.destination_id).localeCompare(name(b.destination_id)) || a.name.localeCompare(b.name));
  async function retire(p: PlanMeta) {
    if (!window.confirm(`Retirer le plan « ${p.name} » de la bibliothèque ?`)) return;
    const { error: e } = await supabase.from('flight_plans').update({ active: false }).eq('id', p.id);
    if (e) setError(e.message); else onChanged();
  }
  return (
    <Modal title="Bibliothèque de plans de vol" onClose={onClose}>
      <div className="pl-lib">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un plan ou une destination" aria-label="Rechercher" autoFocus />
        <ErrorBox error={error} />
        {!list.length ? <div className="small muted">Aucun plan enregistré. Chargez une mission dans WindPath puis « 💾 Enregistrer ».</div> : (
          <ul className="pl-lib-list">
            {list.map((p) => (
              <li key={p.id} className={p.destination_id === destinationId && destinationId ? 'is-dest' : ''}>
                <div>
                  <strong>{p.name}</strong>
                  <span className="small muted">{name(p.destination_id)} · {p.waypoint_count ?? '?'} pts{p.distance_km != null ? ` · ${fr(Number(p.distance_km))} km` : ''} · {p.file_name}</span>
                  {p.notes && <span className="small">{p.notes}</span>}
                </div>
                <div className="pl-inline">
                  <button className="btn btn-sm btn-primary" disabled={!canLoad} onClick={() => onLoad(p.id)}>Charger</button>
                  <button className="btn btn-sm btn-ghost" onClick={() => void retire(p)} title="Retirer de la bibliothèque">✕</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Enregistrer la mission affichée
// ---------------------------------------------------------------------
function SavePlanDialog({ file, facilities, ports, isAdmin, defaultPort, defaultDestination, current, onClose, onSaved }: {
  file: PlanFile; facilities: HealthFacility[]; ports: { id: string; name: string }[]; isAdmin: boolean;
  defaultPort: string; defaultDestination: string; current: PlanMeta | null;
  onClose: () => void; onSaved: (p: PlanMeta) => void;
}) {
  const dest0 = defaultDestination || current?.destination_id || '';
  const [mode, setMode] = useState<'update' | 'new'>(current ? 'update' : 'new');
  const [name, setName] = useState(current?.name ?? (file.missionName ?? '').replace(/\.(waypoints|plan|txt)$/i, '') ?? '');
  const [destinationId, setDestinationId] = useState(dest0);
  const [portId, setPortId] = useState(current?.drone_port_id ?? (facilities.find((f) => f.id === dest0)?.drone_port_id || defaultPort));
  const [notes, setNotes] = useState(current?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const f = facilities.find((x) => x.id === destinationId);
    if (f?.drone_port_id) setPortId(f.drone_port_id);
  }, [destinationId, facilities]);

  async function save() {
    if (!name.trim()) { setError('Donnez un nom au plan.'); return; }
    if (!portId) { setError('Choisissez le drone port du plan.'); return; }
    setBusy(true); setError(null);
    const row = {
      name: name.trim(), drone_port_id: portId, destination_id: destinationId || null, notes: notes.trim() || null,
      file_name: file.fileName, content: file.content, waypoint_count: file.waypointCount, distance_km: file.distanceKm,
    };
    try {
      const saved = mode === 'update' && current
        ? unwrap(await supabase.from('flight_plans').update(row).eq('id', current.id).select(PLAN_COLS).single())
        : unwrap(await supabase.from('flight_plans').insert(row).select(PLAN_COLS).single());
      onSaved(saved as unknown as PlanMeta);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }

  return (
    <Modal title="Enregistrer le plan de vol" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Annuler</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Enregistrement…' : mode === 'update' ? 'Mettre à jour le plan' : 'Enregistrer'}</button>
      </>}>
      <div className="bm-form">
        <p className="small muted">
          {file.waypointCount} points{file.distanceKm != null ? ` · ${fr(file.distanceKm)} km` : ''} · fichier <code>{file.fileName}</code>
          {file.generated ? ' (généré depuis la mission affichée : vérifiez-le dans Mission Planner / QGroundControl avant de l\'envoyer au drone)' : ' (fichier d\'origine)'}
        </p>
        {current && (
          <div className="pl-inline">
            <button type="button" className={`btn btn-sm${mode === 'update' ? ' btn-primary' : ''}`} onClick={() => setMode('update')}>Mettre à jour « {current.name} »</button>
            <button type="button" className={`btn btn-sm${mode === 'new' ? ' btn-primary' : ''}`} onClick={() => setMode('new')}>Nouveau plan</button>
          </div>
        )}
        <Field label="Nom du plan" required><input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. Ranomafana → Maromiandra (aller-retour)" autoFocus /></Field>
        <Field label="Destination">
          <select value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>
            <option value="">— Sans destination —</option>
            {facilities.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </Field>
        {isAdmin && (
          <Field label="Drone port" required>
            <select value={portId} onChange={(e) => setPortId(e.target.value)}>
              <option value="">— Choisir —</option>
              {ports.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Note"><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="ex. contourne le relief au nord, altitude 850 m" /></Field>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}
