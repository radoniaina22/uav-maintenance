import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Badge, ErrorBox, Modal } from '../components/ui';
import {
  FlightNavState, PlanningNavState, SOURCE_LABEL, TransferField, transferFields, WindpathResult,
} from '../lib/windpath';

const WINDPATH_URL = './windpath/index.html';

export default function Planning() {
  const nav = useNavigate();
  const loc = useLocation();
  const incoming = (loc.state ?? null) as PlanningNavState | null;
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [prefillInfo, setPrefillInfo] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<TransferField[] | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<WindpathResult | null>(null);

  // Injection de la passerelle dans WindPath (même origine) une fois la page chargée
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
      const msg = e.data as { source?: string; type?: string; applied?: string[]; data?: WindpathResult };
      if (msg?.source !== 'windpath') return;
      if (msg.type === 'ready') {
        setReady(true);
        if (incoming?.prefill) {
          frame.current?.contentWindow?.postMessage({ source: 'uav', type: 'prefill', payload: incoming.prefill }, window.location.origin);
        }
      }
      if (msg.type === 'prefilled') setPrefillInfo(msg.applied ?? []);
      if (msg.type === 'result' && msg.data) {
        if (msg.data.error) { setError(msg.data.error); return; }
        const list = transferFields(msg.data);
        if (!list.length) { setError('Aucune donnée exploitable dans WindPath pour le moment.'); return; }
        setResult(msg.data);
        setFields(list);
        // par défaut : tout est coché sauf les estimations d'heures, de consommation et de tension d'arrivée
        setChecked(Object.fromEntries(list.map((f) => [f.key,
          !(f.source === 'estime' && ['drop_time', 'landing_time', 'consumption_mah', 'voltage_end_v'].includes(f.key))])));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [incoming]);

  function requestResult() {
    setError(null);
    frame.current?.contentWindow?.postMessage({ source: 'uav', type: 'request' }, window.location.origin);
  }

  function transfer() {
    if (!fields) return;
    const chosen = fields.filter((f) => checked[f.key]);
    const state: FlightNavState = {
      draft: incoming?.draft,
      windpath: Object.fromEntries(chosen.map((f) => [f.key, f.value])),
      windpathLabels: chosen.map((f) => `${f.label} : ${f.display}${f.source === 'estime' ? ' (estimé)' : ''}`),
    };
    nav(incoming?.returnTo ?? '/vols/nouveau', { state });
  }

  return (
    <div className="planning">
      <div className="planning-bar">
        <div>
          <h1 className="planning-title">Planification <span className="muted">· WindPath</span></h1>
          <div className="small muted">
            Vent à l'altitude de chaque point de passage et estimation énergétique du Tango 4
            {incoming?.context && <> · <strong>{incoming.context}</strong></>}
          </div>
        </div>
        <div className="actions">
          {incoming?.returnTo && <Link className="btn" to={incoming.returnTo} state={{ draft: incoming.draft } satisfies FlightNavState}>← Retour au vol</Link>}
          <a className="btn" href={WINDPATH_URL} target="_blank" rel="noreferrer" title="Ouvrir WindPath seul dans un nouvel onglet">Plein écran ↗</a>
          <button className="btn btn-primary" onClick={requestResult} disabled={!ready}>
            {incoming?.returnTo ? 'Reporter dans le vol →' : 'Créer un vol avec ces données →'}
          </button>
        </div>
      </div>
      {prefillInfo && prefillInfo.length > 0 && (
        <div className="alert alert-info planning-alert">
          ✓ Repris du vol dans WindPath : {prefillInfo.join(' · ')}.
          <button className="btn btn-ghost btn-sm" onClick={() => setPrefillInfo(null)}>OK</button>
        </div>
      )}
      <ErrorBox error={error} />
      <iframe ref={frame} className={`planning-frame${ready ? ' is-ready' : ''}`} src={WINDPATH_URL} title="WindPath – planificateur de vent et d'énergie" onLoad={onLoad} />

      {fields && result && (
        <Modal title={incoming?.returnTo ? 'Reporter dans le vol' : 'Créer un vol avec les données WindPath'} onClose={() => setFields(null)}
          footer={<>
            <button className="btn" onClick={() => setFields(null)}>Annuler</button>
            <button className="btn btn-primary" onClick={transfer} disabled={!Object.values(checked).some(Boolean)}>
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
          <p className="small muted">
            Les estimations (heures prévues, consommation, tension) sont décochées par défaut : un vol enregistre des valeurs réelles.
            Vous pourrez tout vérifier dans le formulaire avant d'enregistrer.
          </p>
        </Modal>
      )}
    </div>
  );
}
