import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import type { DroneSlot, PartRow } from '../lib/types';
import { hours } from '../lib/format';
import { nowLocal, PART_STATUS, potentialLevel, remainingHours, zoneLabel } from '../lib/parts';
import { extractDroneCode, extractPartCode, scanFeedback, useQrCamera } from '../components/QrScanner';
import { FAILURES, GOOD_REASONS, PotentialBar } from '../components/PartModals';
import { QuickChips } from '../components/FormKit';
import { Badge, ErrorBox } from '../components/ui';
import { Icon } from '../components/icons';

/**
 * Mode atelier (téléphone) : on scanne une pièce et on agit tout de suite
 * (monter, démonter, quarantaine, remplacer, remise en stock, rebut).
 * Scanner l'étiquette d'un drone le choisit comme « drone courant » pour les montages.
 * Toutes les règles (drone port, statut, emplacement compatible et libre) sont vérifiées en base.
 */

interface ScanDrone { id: string; code: string; model: string; drone_port_id: string | null }
type Flow =
  | { kind: 'mount' }
  | { kind: 'unmount'; to: 'stock' | 'quarantaine' }
  | { kind: 'status'; to: 'stock' | 'quarantaine' | 'rebut' }
  | { kind: 'replace' };
type Toast = { text: string; tone: 'ok' | 'warn' | 'danger' };

const DRONE_COLS = 'id, code, model, drone_port_id';

/** Pièce par son code, ou par son ancien code tant que les anciennes étiquettes sont en place */
async function loadPart(code: string) {
  const { data } = await supabase.from('v_parts').select('*').or(`code.eq.${code},legacy_code.eq.${code}`).limit(1).maybeSingle();
  return data as PartRow | null;
}
async function findDrone(code: string) {
  const { data } = await supabase.from('drones').select(DRONE_COLS).ilike('code', code.replace(/[%_]/g, '')).limit(1).maybeSingle();
  return data as ScanDrone | null;
}

/** Exécution d'une action avec état « en cours » et message d'erreur lisible */
function useRun(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); setBusy(false); onDone(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); scanFeedback(false); }
  };
  return { busy, error, run };
}

/** Date de l'opération : « maintenant » par défaut, modifiable */
function When({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  if (value == null) {
    return <button type="button" className="ss-when" onClick={() => onChange(nowLocal())}><Icon name="clock" size={14} /> Maintenant · <u>modifier la date</u></button>;
  }
  return (
    <label className="field"><span className="field-label">Date et heure de l'opération</span>
      <div className="ss-when-edit">
        <input type="datetime-local" required value={value} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(null)}>Maintenant</button>
      </div>
    </label>
  );
}

function FlowShell({ title, onCancel, onSubmit, busy, error, label, danger, disabled, children }: {
  title: string; onCancel: () => void; onSubmit: () => void; busy: boolean; error: string | null; label: string; danger?: boolean; disabled?: boolean; children: ReactNode;
}) {
  const submit = (e: FormEvent) => { e.preventDefault(); onSubmit(); };
  return (
    <form className="ss-flow" onSubmit={submit}>
      <div className="ss-flow-title">{title}</div>
      {children}
      <ErrorBox error={error} />
      <div className="ss-flow-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Retour</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy || disabled}>{busy ? 'En cours…' : label}</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------
// Monter : drone du drone port de la pièce, puis emplacement libre compatible
// ---------------------------------------------------------------------
function MountFlow({ part, ctxDrone, onDone, onCancel }: { part: PartRow; ctxDrone: ScanDrone | null; onDone: (msg: string) => void; onCancel: () => void }) {
  const ctxOk = ctxDrone && ctxDrone.drone_port_id === part.drone_port_id ? ctxDrone.id : '';
  const [drones, setDrones] = useState<ScanDrone[] | null>(null);
  const [droneId, setDroneId] = useState(ctxOk);
  const [places, setPlaces] = useState<{ value: string; label: string; zone: string; occupant: string | null }[] | null>(null);
  const [choice, setChoice] = useState('');
  const [notes, setNotes] = useState('');
  const [at, setAt] = useState<string | null>(null);
  const drone = drones?.find((d) => d.id === droneId);
  const { busy, error, run } = useRun(() => onDone(`${part.code} montée sur ${drone?.code ?? 'le drone'} · ${places?.find((p) => p.value === choice)?.label ?? ''}`));

  useEffect(() => { if (ctxOk) setDroneId(ctxOk); }, [ctxOk]);
  useEffect(() => {
    if (!part.drone_port_id) { setDrones([]); return; }
    supabase.from('drones').select(DRONE_COLS).eq('drone_port_id', part.drone_port_id).order('code').then(({ data }) => {
      const list = (data ?? []) as ScanDrone[];
      setDrones(list);
      if (!ctxOk && list.length === 1) setDroneId(list[0].id);
    });
  }, [part.drone_port_id, ctxOk]);
  useEffect(() => {
    setPlaces(null); setChoice('');
    if (!drone) return;
    let alive = true;
    Promise.all([
      supabase.from('drone_slots').select('*').eq('model', drone.model).order('sort'),
      supabase.from('v_parts').select('code, slot').eq('drone_id', drone.id).eq('status', 'monte'),
    ]).then(([s, m]) => {
      if (!alive) return;
      const slots = (s.data ?? []) as DroneSlot[];
      const mounted = (m.data ?? []) as { code: string; slot: string | null }[];
      const list = part.multi
        // connecteurs, fils… : pas d'emplacement unique, on choisit la zone
        ? [...new Set(slots.map((x) => x.zone))].map((z) => ({ value: z, label: zoneLabel(z), zone: z, occupant: null }))
        : slots.filter((x) => x.type_code === part.type_code).map((x) => ({ value: x.code, label: x.label, zone: x.zone, occupant: mounted.find((p) => p.slot === x.code)?.code ?? null }));
      setPlaces(list);
      const free = list.filter((x) => !x.occupant);
      if (free.length === 1) setChoice(free[0].value);
    });
    return () => { alive = false; };
  }, [drone?.id, drone?.model, part.multi, part.type_code]);

  const submit = () => {
    const place = places?.find((p) => p.value === choice);
    if (!drone || !place) return;
    run(async () => unwrap(await supabase.rpc('mount_part', {
      p_part: part.id, p_drone: drone.id, p_slot: part.multi ? null : place.value, p_zone: place.zone, p_at: at ?? nowLocal(), p_notes: notes.trim() || null,
    })));
  };

  return (
    <FlowShell title={`Monter ${part.code}`} onCancel={onCancel} onSubmit={submit} busy={busy} error={error} label="⤓ Monter la pièce" disabled={!drone || !choice}>
      <div className="ss-step"><span>1</span> Drone {ctxDrone && !ctxOk && <em className="small text-warn">(le drone scanné {ctxDrone.code} est dans un autre drone port)</em>}</div>
      {drones == null ? <div className="small muted">Chargement…</div> : !drones.length ? <div className="alert alert-warn">Aucun drone dans le drone port de cette pièce.</div> : (
        <div className="ss-pills">
          {drones.map((d) => <button key={d.id} type="button" className={`ss-pill${droneId === d.id ? ' active' : ''}`} onClick={() => setDroneId(d.id)}>{d.code}</button>)}
        </div>
      )}
      {drone && <>
        <div className="ss-step"><span>2</span> {part.multi ? 'Zone de montage' : 'Emplacement'}</div>
        {places == null ? <div className="small muted">Chargement…</div> : !places.length ? <div className="alert alert-warn">Aucun emplacement « {part.type_name} » sur un {drone.model}.</div> : (
          <div className="ss-places">
            {places.map((p) => (
              <button key={p.value} type="button" disabled={!!p.occupant} className={`ss-place${choice === p.value ? ' active' : ''}`} onClick={() => setChoice(p.value)}>
                <strong>{p.label}</strong>
                <span>{p.occupant ? `occupé · ${p.occupant}` : part.multi ? zoneLabel(p.zone) : 'libre'}</span>
              </button>
            ))}
          </div>
        )}
        {places && places.length > 0 && places.every((p) => p.occupant) && (
          <div className="fk-note warn"><Icon name="alert" size={14} /> Tous les emplacements sont occupés : scannez la pièce en place et utilisez « Remplacer ».</div>
        )}
      </>}
      <QuickChips replace items={['Montage initial', 'Remplacement préventif', 'Après réparation']} value={notes} onChange={setNotes} />
      <When value={at} onChange={setAt} />
    </FlowShell>
  );
}

// ---------------------------------------------------------------------
// Démontage, quarantaine, remise en stock, rebut : un motif (+ date pour un démontage)
// ---------------------------------------------------------------------
function ReasonFlow({ part, flow, onDone, onCancel }: { part: PartRow; flow: Extract<Flow, { kind: 'unmount' | 'status' }>; onDone: (msg: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const [at, setAt] = useState<string | null>(null);
  const to = flow.to;
  const unmount = flow.kind === 'unmount';
  const msg = unmount
    ? to === 'quarantaine' ? `${part.code} démontée et mise en quarantaine` : `${part.code} démontée et remise en stock`
    : to === 'quarantaine' ? `${part.code} mise en quarantaine` : to === 'rebut' ? `${part.code} mise au rebut` : `${part.code} remise en stock`;
  const { busy, error, run } = useRun(() => onDone(msg));
  const chips = to === 'quarantaine' ? FAILURES : to === 'rebut' ? ['Irréparable', 'Potentiel épuisé', 'Casse', 'Obsolète'] : unmount ? GOOD_REASONS : ['Contrôle OK', 'Essai au banc OK', 'Réparée', 'Fausse alerte'];
  const required = to !== 'stock';
  const title = unmount ? (to === 'quarantaine' ? `Défaillance : démonter ${part.code}` : `Démonter ${part.code}`)
    : to === 'quarantaine' ? `Quarantaine : ${part.code}` : to === 'rebut' ? `Rebut : ${part.code}` : `Remettre ${part.code} en stock`;
  const submit = () => run(async () => unwrap(unmount
    ? await supabase.rpc('unmount_part', { p_part: part.id, p_to: to, p_at: at ?? nowLocal(), p_reason: reason.trim() || null })
    : await supabase.rpc('set_part_status', { p_part: part.id, p_status: to, p_reason: reason.trim() || null })));
  return (
    <FlowShell title={title} onCancel={onCancel} onSubmit={submit} busy={busy} error={error} danger={to !== 'stock'}
      label={to === 'quarantaine' ? '⚠ Mettre en quarantaine' : to === 'rebut' ? '✕ Mettre au rebut' : unmount ? '⤒ Démonter' : '↺ Remettre en stock'}>
      <div className="ss-step"><span>✎</span> {to === 'quarantaine' ? 'Défaillance constatée' : to === 'rebut' ? 'Motif du rebut' : unmount ? 'Motif' : 'Contrôle effectué'}{required && <em className="req"> *</em>}</div>
      <QuickChips replace items={chips} value={reason} onChange={setReason} />
      <textarea rows={2} required={required} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Motif"
        placeholder={to === 'quarantaine' ? 'Symptôme : phase de vol, bruit, valeurs…' : 'Précisez si besoin'} />
      {unmount && <When value={at} onChange={setAt} />}
      {unmount && to === 'quarantaine' && <div className="fk-note warn"><Icon name="alert" size={14} /> L'emplacement restera vide : utilisez plutôt « Remplacer » si vous montez une pièce neuve.</div>}
      {to === 'rebut' && <div className="fk-note danger"><Icon name="alert" size={14} /> Retrait définitif du service.</div>}
    </FlowShell>
  );
}

// ---------------------------------------------------------------------
// Remplacer : la pièce neuve est scannée (ou choisie dans le stock)
// ---------------------------------------------------------------------
function ReplaceFlow({ part, scanned, onPick, onDone, onCancel }: {
  part: PartRow; scanned: PartRow | null; onPick: (p: PartRow | null) => void; onDone: (msg: string) => void; onCancel: () => void;
}) {
  const [candidates, setCandidates] = useState<PartRow[] | null>(null);
  const [oldTo, setOldTo] = useState<'stock' | 'quarantaine'>(potentialLevel(part) === 'danger' ? 'stock' : 'quarantaine');
  const [reason, setReason] = useState(potentialLevel(part) === 'danger' ? 'Potentiel atteint' : '');
  const [at, setAt] = useState<string | null>(null);
  const { busy, error, run } = useRun(() => onDone(`${part.code} remplacée par ${scanned?.code} (${oldTo === 'quarantaine' ? 'ancienne en quarantaine' : 'ancienne en stock'})`));
  useEffect(() => {
    if (!part.drone_port_id) { setCandidates([]); return; }
    supabase.from('v_parts').select('*').eq('type_code', part.type_code).eq('status', 'stock').eq('drone_port_id', part.drone_port_id).then(({ data }) => {
      setCandidates(((data ?? []) as PartRow[]).sort((a, b) => (remainingHours(b) ?? 1e9) - (remainingHours(a) ?? 1e9)));
    });
  }, [part.drone_port_id, part.type_code]);
  const submit = () => {
    if (!scanned) return;
    run(async () => unwrap(await supabase.rpc('replace_part', { p_old: part.id, p_new: scanned.id, p_old_to: oldTo, p_at: at ?? nowLocal(), p_reason: reason.trim() || null })));
  };
  return (
    <FlowShell title={`Remplacer ${part.code}`} onCancel={onCancel} onSubmit={submit} busy={busy} error={error} label="⇆ Remplacer" disabled={!scanned}>
      <div className="ss-step"><span>1</span> Pièce neuve ({part.type_name})</div>
      {scanned ? (
        <div className="ss-swap">
          <div><span className="pd-kicker">Démontée</span><strong>{part.code}</strong></div>
          <span className="ss-swap-arrow">⇆</span>
          <div><span className="pd-kicker">Montée</span><strong>{scanned.code}</strong><PotentialBar part={scanned} compact /></div>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onPick(null)}>Changer</button>
        </div>
      ) : (
        <>
          <div className="ss-aim"><Icon name="scan" size={18} /> Scannez l'étiquette de la pièce neuve…</div>
          {candidates && candidates.length > 0 && <>
            <div className="small muted">… ou choisissez dans le stock :</div>
            <div className="ss-pills">
              {candidates.slice(0, 8).map((c) => <button key={c.id} type="button" className="ss-pill" onClick={() => onPick(c)}>{c.code}{remainingHours(c) != null && <em> · {hours(remainingHours(c))}</em>}</button>)}
            </div>
          </>}
          {candidates && !candidates.length && <div className="alert alert-warn">Aucune pièce « {part.type_name} » en stock dans ce drone port.</div>}
        </>
      )}
      <div className="ss-step"><span>2</span> Que devient {part.code} ?</div>
      <div className="ss-pills">
        <button type="button" className={`ss-pill danger${oldTo === 'quarantaine' ? ' active' : ''}`} onClick={() => { setOldTo('quarantaine'); setReason(''); }}>⚠ Quarantaine</button>
        <button type="button" className={`ss-pill${oldTo === 'stock' ? ' active' : ''}`} onClick={() => { setOldTo('stock'); setReason(''); }}>Retour en stock</button>
      </div>
      <QuickChips replace items={oldTo === 'quarantaine' ? FAILURES : GOOD_REASONS} value={reason} onChange={setReason} />
      <input required={oldTo === 'quarantaine'} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Motif"
        placeholder={oldTo === 'quarantaine' ? 'Défaillance constatée *' : 'Motif (facultatif)'} />
      <When value={at} onChange={setAt} />
    </FlowShell>
  );
}

// ---------------------------------------------------------------------
// Fiche action d'une pièce scannée
// ---------------------------------------------------------------------
function ActionButton({ icon, label, sub, tone, onClick }: { icon: string; label: string; sub?: string; tone?: 'primary' | 'danger'; onClick: () => void }) {
  return (
    <button type="button" className={`ss-action${tone ? ` ${tone}` : ''}`} onClick={onClick}>
      <span className="ss-action-icon" aria-hidden>{icon}</span>
      <span><strong>{label}</strong>{sub && <small>{sub}</small>}</span>
    </button>
  );
}

function PartSheet({ part, drone, setFlow, onClose }: { part: PartRow; drone: ScanDrone | null; setFlow: (f: Flow) => void; onClose: () => void }) {
  const st = PART_STATUS[part.status];
  const where = part.status === 'monte' ? `${part.drone_code} · ${part.slot_label ?? zoneLabel(part.zone)}` : part.drone_port_name ?? '—';
  return (
    <div className={`ss-sheet st-${part.status}`}>
      <div className="ss-sheet-head">
        <div>
          <strong className="ss-code">{part.code}</strong>
          <span className="small muted">{part.type_name}{part.serial_number ? ` · S/N ${part.serial_number}` : ''}</span>
        </div>
        <Badge level={st.level}>{st.label}</Badge>
      </div>
      <div className="ss-where"><Icon name={part.status === 'monte' ? 'drone' : 'pin'} size={14} /> {where}</div>
      <PotentialBar part={part} />
      <div className="ss-actions">
        {part.status === 'stock' && <>
          <ActionButton icon="⤓" tone="primary" label={drone && drone.drone_port_id === part.drone_port_id ? `Monter sur ${drone.code}` : 'Monter sur un drone'} sub="choix de l'emplacement libre" onClick={() => setFlow({ kind: 'mount' })} />
          <ActionButton icon="⚠" tone="danger" label="Mettre en quarantaine" sub="défaut constaté en stock" onClick={() => setFlow({ kind: 'status', to: 'quarantaine' })} />
        </>}
        {part.status === 'monte' && <>
          <ActionButton icon="⇆" tone="primary" label="Remplacer" sub="scanner la pièce neuve" onClick={() => setFlow({ kind: 'replace' })} />
          <ActionButton icon="⤒" label="Démonter → stock" sub="pièce bonne, réutilisable" onClick={() => setFlow({ kind: 'unmount', to: 'stock' })} />
          <ActionButton icon="⚠" tone="danger" label="Défaillance → quarantaine" sub="démonter pour expertise" onClick={() => setFlow({ kind: 'unmount', to: 'quarantaine' })} />
        </>}
        {part.status === 'quarantaine' && <>
          <ActionButton icon="↺" tone="primary" label="Remettre en stock" sub="contrôle OK" onClick={() => setFlow({ kind: 'status', to: 'stock' })} />
          <ActionButton icon="✕" tone="danger" label="Mettre au rebut" sub="retrait définitif" onClick={() => setFlow({ kind: 'status', to: 'rebut' })} />
        </>}
        {part.status === 'rebut' && <div className="alert alert-warn">Pièce au rebut : aucune action possible.</div>}
      </div>
      <div className="ss-sheet-foot">
        <Link to={`/pieces/${part.id}`}>Fiche complète ›</Link>
        <button type="button" className="link-btn" onClick={onClose}>Scanner une autre pièce</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------
export default function Scan() {
  const video = useRef<HTMLVideoElement>(null);
  const [part, setPart] = useState<PartRow | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [newPart, setNewPart] = useState<PartRow | null>(null);
  const [drone, setDrone] = useState<ScanDrone | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [manual, setManual] = useState('');
  const [count, setCount] = useState(0);
  const last = useRef({ text: '', at: 0 });
  const looking = useRef(false);
  const toastTimer = useRef(0);

  const flash = (t: Toast) => {
    setToast(t);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), t.tone === 'ok' ? 4000 : 5000);
  };
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // téléphone : la fiche de la pièce (ou l'étape suivante) vient sous le pouce
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!part || !window.matchMedia('(max-width: 760px)').matches) return;
    panel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [part?.id, flow?.kind]);

  // la caméra lit en continu, sauf pendant la saisie d'un motif (pour ne pas perdre le formulaire)
  const listening = !flow || flow.kind === 'mount' || (flow.kind === 'replace' && !newPart);

  async function handle(raw: string, manualEntry = false) {
    const text = raw.trim();
    if (!text) return;
    const now = Date.now();
    // même étiquette encore dans le champ de la caméra : on l'ignore quelques secondes
    if (!manualEntry && text === last.current.text && now - last.current.at < 3000) return;
    last.current = { text, at: now };
    if (looking.current) return;
    looking.current = true;
    try {
      const dCode = extractDroneCode(text);
      const pCode = extractPartCode(text);
      if (dCode || (!pCode && manualEntry)) {
        const d = await findDrone(dCode ?? text);
        if (d) {
          scanFeedback();
          setDrone(d);
          flash({ text: `Drone ${d.code} sélectionné : scannez les pièces à y monter.`, tone: 'ok' });
          return;
        }
        if (dCode || manualEntry) { scanFeedback(false); flash({ text: `${dCode ? `Drone ${dCode}` : `« ${text.slice(0, 30)} »`} introuvable, ou hors de votre drone port.`, tone: 'danger' }); return; }
      }
      if (!pCode) { scanFeedback(false); flash({ text: `« ${text.slice(0, 40)} » n'est ni une pièce ni un drone.`, tone: 'warn' }); return; }
      const p = await loadPart(pCode);
      if (!p) { scanFeedback(false); flash({ text: `Pièce ${pCode} introuvable, ou hors de votre drone port.`, tone: 'danger' }); return; }
      if (flow?.kind === 'replace' && part) {
        const why = p.id === part.id ? 'C\'est la pièce à remplacer : scannez la pièce neuve.'
          : p.status !== 'stock' ? `${p.code} n'est pas en stock (${PART_STATUS[p.status].label.toLowerCase()}).`
          : p.type_code !== part.type_code ? `${p.code} est un(e) « ${p.type_name} » : il faut « ${part.type_name} ».`
          : p.drone_port_id !== part.drone_port_id ? `${p.code} est stockée dans un autre drone port.` : null;
        scanFeedback(!why);
        if (why) flash({ text: why, tone: 'warn' }); else setNewPart(p);
        return;
      }
      scanFeedback();
      setPart(p); setFlow(null); setNewPart(null); setToast(null);
    } finally { looking.current = false; }
  }

  const cam = useQrCamera(video, listening, (t) => { void handle(t); });

  const done = (msg: string) => {
    scanFeedback();
    flash({ text: `✓ ${msg}`, tone: 'ok' });
    setCount((c) => c + 1);
    setPart(null); setFlow(null); setNewPart(null);
    last.current.at = Date.now();
  };
  const submitManual = (e: FormEvent) => { e.preventDefault(); void handle(manual, true); setManual(''); };
  const cancelFlow = () => { setFlow(null); setNewPart(null); };

  return (
    <div className="ss">
      <div className="ss-top">
        <Link className="btn btn-sm" to="/pieces">← Pièces</Link>
        <div className="ss-title"><Icon name="scan" size={18} /> Mode atelier{count > 0 && <span className="ss-count">{count} opération{count > 1 ? 's' : ''}</span>}</div>
        {drone ? (
          <span className="ss-drone" title="Drone courant : les pièces en stock scannées y seront montées">
            <Icon name="drone" size={14} /> {drone.code}
            <button type="button" onClick={() => setDrone(null)} aria-label="Oublier le drone courant">✕</button>
          </span>
        ) : <span className="ss-drone ghost small">Scannez un drone pour le choisir</span>}
      </div>

      <div className={`ss-grid${part ? ' has-part' : ''}`}>
        <div className="ss-left">
          <div className={`ss-cam${cam.camOn ? ' on' : ''}${listening ? '' : ' paused'}`}>
            <video ref={video} muted playsInline />
            {cam.camOn ? <span className="scanner-frame" aria-hidden /> : <span className="small muted ss-cam-msg">{cam.camError ?? 'Ouverture de la caméra…'}</span>}
            {cam.camOn && <span className="ss-cam-hint">{listening ? (flow?.kind === 'replace' ? 'Visez la pièce neuve' : 'Visez le QR d\'une pièce ou d\'un drone') : 'Lecture en pause'}</span>}
            {cam.torchAvailable && (
              <button type="button" className={`ss-torch${cam.torch ? ' on' : ''}`} onClick={cam.toggleTorch} aria-pressed={cam.torch} aria-label="Lampe torche">
                <Icon name="bolt" size={18} />
              </button>
            )}
            {toast && <div className={`ss-toast ${toast.tone}`} role="status">{toast.text}</div>}
          </div>
          <form className="ss-manual" onSubmit={submitManual}>
            <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Code pièce ou drone" title="Saisie manuelle ou douchette USB" aria-label="Code pièce ou drone"
              autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
            <button className="btn btn-primary" type="submit" disabled={!manual.trim()}>OK</button>
          </form>
        </div>

        <div className="ss-right" ref={panel}>
          {!part ? (
            <div className="ss-empty">
              <Icon name="scan" size={30} />
              <strong>Scannez une étiquette</strong>
              <ol>
                <li><b>Pièce</b> : ses actions s'affichent selon son statut (monter, démonter, quarantaine…).</li>
                <li><b>Drone</b> (étiquette « DRONE ») : il devient le drone courant, les pièces en stock scannées ensuite y seront montées.</li>
                <li>Après chaque opération, la caméra reprend : enchaînez les pièces.</li>
              </ol>
            </div>
          ) : !flow ? (
            <PartSheet part={part} drone={drone} setFlow={setFlow} onClose={() => setPart(null)} />
          ) : flow.kind === 'mount' ? (
            <MountFlow part={part} ctxDrone={drone} onDone={done} onCancel={cancelFlow} />
          ) : flow.kind === 'replace' ? (
            <ReplaceFlow part={part} scanned={newPart} onPick={setNewPart} onDone={done} onCancel={cancelFlow} />
          ) : (
            <ReasonFlow part={part} flow={flow} onDone={done} onCancel={cancelFlow} />
          )}
        </div>
      </div>
    </div>
  );
}
