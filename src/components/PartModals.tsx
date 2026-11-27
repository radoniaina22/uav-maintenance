import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { supabase, unwrap } from '../lib/supabase';
import { useApp } from '../lib/app';
import type { PartRow, PartType } from '../lib/types';
import { hours, num, toNum, toStr, type Level } from '../lib/format';
import { cycles, fetchMountWarnings, nowLocal, pctLevel, potentialLevel, remainingCycles, remainingHours, TANGO4_ZONES, zoneLabel } from '../lib/parts';
import { ErrorBox, Field, Modal, PortSelect, Progress } from './ui';
import { Icon } from './icons';
import { ChoiceCards, ContextBanner, FormSection, QuickChips, RouteView } from './FormKit';
import { GaugeRing } from './BatteryVisuals';

type PotentialPart = Pick<PartRow, 'total_hours' | 'max_hours_effective' | 'potential_pct'>
  & Partial<Pick<PartRow, 'total_cycles' | 'max_cycles_effective' | 'hours_pct' | 'cycle_pct'>>;

/** Barre de potentiel : heures consommées / potentiel, et cycles / potentiel en cycles s'il est défini */
export function PotentialBar({ part, compact }: { part: PotentialPart; compact?: boolean }) {
  const hasHours = part.max_hours_effective != null;
  const hasCycles = part.max_cycles_effective != null && part.total_cycles != null;
  if (!hasHours && !hasCycles) {
    return <div className="small muted">{hours(part.total_hours)}{part.total_cycles != null ? ` · ${cycles(part.total_cycles)}` : ''} · <span className="text-warn">potentiel à définir</span></div>;
  }
  const restH = remainingHours(part);
  const restC = hasCycles ? remainingCycles(part as Pick<PartRow, 'total_cycles' | 'max_cycles_effective'>) : null;
  const hPct = part.hours_pct ?? (hasHours ? (100 * Number(part.total_hours)) / Number(part.max_hours_effective) : null);
  const cPct = part.cycle_pct ?? (hasCycles ? (100 * Number(part.total_cycles)) / Number(part.max_cycles_effective) : null);
  return (
    <div className="potential">
      {hasHours && restH != null && <>
        <div className="row-between small">
          <span>{hours(part.total_hours)} / {hours(part.max_hours_effective)}</span>
          <strong className={`text-${pctLevel(hPct)}`}>{restH <= 0 ? `dépassé de ${hours(-restH)}` : compact ? `${num(hPct)} %` : `reste ${hours(restH)}`}</strong>
        </div>
        <Progress value={Number(part.total_hours)} max={Number(part.max_hours_effective)} level={pctLevel(hPct) as Level} />
      </>}
      {hasCycles && restC != null && <>
        <div className="row-between small">
          <span>{num(part.total_cycles, 0)} / {cycles(part.max_cycles_effective)}</span>
          <strong className={`text-${pctLevel(cPct)}`}>{restC <= 0 ? `dépassé de ${cycles(-restC)}` : compact ? `${num(cPct)} %` : `reste ${cycles(restC)}`}</strong>
        </div>
        <Progress value={Number(part.total_cycles)} max={Number(part.max_cycles_effective)} level={pctLevel(cPct) as Level} />
      </>}
      {!hasCycles && part.total_cycles != null && !compact && <div className="small muted">{cycles(part.total_cycles)}</div>}
    </div>
  );
}

function useAction(onDone: () => void) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return { error, busy, run };
}

function Footer({ form, busy, onClose, label = 'Valider', danger, disabled }: { form: string; busy: boolean; onClose: () => void; label?: string; danger?: boolean; disabled?: boolean }) {
  return <>
    <button type="button" className="btn" onClick={onClose}>Annuler</button>
    <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} form={form} disabled={busy || disabled}>{busy ? 'En cours…' : label}</button>
  </>;
}

/** Motifs fréquents proposés en un clic */
export const FAILURES = ['Vibrations anormales', 'Roulement bruyant', 'Fissure / casse', 'Surchauffe', 'Choc ou chute', 'Faux contact / connecteur', 'Perte de signal'];
export const GOOD_REASONS =['Échange préventif', 'Inspection', 'Potentiel atteint', 'Réorganisation du stock', 'Pièce cannibalisée pour un autre drone'];

/** Carte d'identité compacte d'une pièce */
function PartChip({ p, label }: { p: PartRow; label?: string }) {
  return (
    <div className={`fk-part lv-${potentialLevel(p)}`}>
      {label && <span className="pd-kicker">{label}</span>}
      <strong className="slot-code">{p.code}</strong>
      <span className="small muted">{p.type_name}{p.serial_number ? ` · S/N ${p.serial_number}` : ''}</span>
      <PotentialBar part={p} compact />
    </div>
  );
}

/** Mini-photo du drone avec la zone de montage */
function ZoneSpot({ zone }: { zone: string | null }) {
  const pos = TANGO4_ZONES.find((z) => z.code === zone);
  return (
    <div className="ph-mini-drone fk-zone">
      <img src="./tango4.png" alt="" />
      {pos && <i style={{ left: `${pos.x}%`, top: `${pos.y}%` }} />}
    </div>
  );
}

/** Avertissements non bloquants (montage croisé, marque différente…) pour la pièce choisie */
export function MountWarnings({ partId, droneId, slot }: { partId: string | null | undefined; droneId: string | null | undefined; slot: string | null | undefined }) {
  const [list, setList] = useState<string[]>([]);
  useEffect(() => {
    setList([]);
    if (!partId || !droneId || !slot) return;
    let alive = true;
    fetchMountWarnings(partId, droneId, slot).then((w) => { if (alive) setList(w); });
    return () => { alive = false; };
  }, [partId, droneId, slot]);
  if (!list.length) return null;
  return <>{list.map((w) => <div key={w} className="fk-note warn"><Icon name="alert" size={14} /> {w}</div>)}</>;
}

function CandidateList({ candidates, value, onChange, empty, slotType }: {
  candidates: PartRow[]; value: string; onChange: (id: string) => void; empty: ReactNode; slotType?: string;
}) {
  if (!candidates.length) return <div className="alert alert-warn">{empty}</div>;
  // les pièces avec le plus de potentiel restant en premier
  const sorted = [...candidates].sort((a, b) => (remainingHours(b) ?? 1e9) - (remainingHours(a) ?? 1e9) || a.code.localeCompare(b.code));
  return (
    <div className="pick-list" role="radiogroup">
      {sorted.map((p, i) => {
        const lvl = potentialLevel(p);
        return (
          <label key={p.id} className={`pick${value === p.id ? ' active' : ''}`}>
            <input type="radio" name="pick" checked={value === p.id} onChange={() => onChange(p.id)} />
            <div className="pick-body">
              <div className="row-between"><strong>{p.code}</strong>
                {lvl === 'danger' ? <span className="text-danger small">potentiel dépassé</span> : i === 0 && sorted.length > 1 ? <span className="fk-best">★ plus de potentiel</span> : null}</div>
              <div className="small muted">{p.serial_number ? `S/N ${p.serial_number}` : 'Sans n° de série'}{p.manufacturer ? ` · ${p.manufacturer}` : ''}
                {slotType && p.type_code !== slotType && <span className="text-warn"> · {p.type_name} (montage croisé)</span>}</div>
              <PotentialBar part={p} compact />
            </div>
          </label>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------
// Monter une pièce (emplacement précis, ou zone pour connecteurs / fils)
// ---------------------------------------------------------------------
export function MountModal({ droneId, droneCode, slot, slotLabel, zone, typeName, slotType, candidates, onClose, onDone }: {
  droneId: string; droneCode: string; slot: string | null; slotLabel: string; zone: string; typeName: string; slotType?: string;
  candidates: PartRow[]; onClose: () => void; onDone: () => void;
}) {
  const sortedFirst = [...candidates].sort((a, b) => (remainingHours(b) ?? 1e9) - (remainingHours(a) ?? 1e9))[0];
  const [partId, setPartId] = useState(sortedFirst?.id ?? '');
  const [at, setAt] = useState(nowLocal());
  const [notes, setNotes] = useState('');
  const { error, busy, run } = useAction(onDone);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!partId) return;
    run(async () => unwrap(await supabase.rpc('mount_part', { p_part: partId, p_drone: droneId, p_slot: slot, p_zone: zone, p_at: at, p_notes: toStr(notes) })));
  };
  return (
    <Modal title={`Monter une pièce sur ${droneCode}`} onClose={onClose} footer={<Footer form="mount-form" busy={busy} disabled={!partId} onClose={onClose} label="⤓ Monter la pièce" />}>
      <form id="mount-form" className="bm-form fk-form" onSubmit={submit}>
        <div className="fk-mount-head">
          <ZoneSpot zone={zone} />
          <div><span className="pd-kicker">{droneCode} · {zoneLabel(zone)}</span><strong>{slotLabel}</strong><span className="small muted">{typeName}</span></div>
        </div>
        <FormSection n={1} icon="box" title="Pièce à monter" hint={`${candidates.length} en stock dans ce drone port`}>
          <CandidateList candidates={candidates} value={partId} onChange={setPartId} slotType={slotType}
            empty={<>Aucune pièce « {typeName} » en stock dans ce drone port. Faites d'abord une <strong>entrée en stock</strong> ou un transfert.</>} />
          <MountWarnings partId={partId} droneId={droneId} slot={slot} />
        </FormSection>
        <FormSection n={2} icon="clock" title="Montage">
          <div className="form-grid">
            <Field label="Date et heure du montage" required hint="Les vols du drone après cette date compteront pour la pièce">
              <input type="datetime-local" required value={at} onChange={(e) => setAt(e.target.value)} />
            </Field>
            <Field label="Note"><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="ex. montage initial" /></Field>
          </div>
          <QuickChips replace items={['Montage initial', 'Remplacement préventif', 'Après réparation']} value={notes} onChange={setNotes} />
        </FormSection>
        <ErrorBox error={error} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Démonter (vers stock ou quarantaine)
// ---------------------------------------------------------------------
export function UnmountModal({ part, defaultTo = 'stock', onClose, onDone }: { part: PartRow; defaultTo?: 'stock' | 'quarantaine'; onClose: () => void; onDone: () => void }) {
  const [to, setTo] = useState<'stock' | 'quarantaine'>(defaultTo);
  const [at, setAt] = useState(nowLocal());
  const [reason, setReason] = useState('');
  const { error, busy, run } = useAction(onDone);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => unwrap(await supabase.rpc('unmount_part', { p_part: part.id, p_to: to, p_at: at, p_reason: toStr(reason) })));
  };
  return (
    <Modal title={`Démonter ${part.code}`} onClose={onClose}
      footer={<Footer form="unmount-form" busy={busy} onClose={onClose} label={to === 'quarantaine' ? '⚠ Démonter et mettre en quarantaine' : '⤒ Démonter'} danger={to === 'quarantaine'} />}>
      <form id="unmount-form" className="bm-form fk-form" onSubmit={submit}>
        <div className="fk-mount-head">
          <ZoneSpot zone={part.zone} />
          <PartChip p={part} label={`${part.drone_code} · ${part.slot_label ?? zoneLabel(part.zone)}`} />
        </div>
        <FormSection n={1} icon="box" title="Destination de la pièce">
          <ChoiceCards label="Destination" value={to} onChange={setTo} options={[
            { value: 'stock', label: 'Retour en stock', desc: 'La pièce est bonne et réutilisable', icon: 'box', tone: 'ok' },
            { value: 'quarantaine', label: 'Quarantaine', desc: 'Défaillance : expertise avant décision', icon: 'alert', tone: 'danger' },
          ]} />
        </FormSection>
        <FormSection n={2} icon="pen" title={to === 'quarantaine' ? 'Défaillance constatée' : 'Motif'}>
          <QuickChips replace items={to === 'quarantaine' ? FAILURES : GOOD_REASONS} value={reason} onChange={setReason} />
          <textarea rows={2} required={to === 'quarantaine'} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Motif"
            placeholder={to === 'quarantaine' ? 'Décrivez le symptôme : phase de vol, bruit, valeurs…' : 'ex. inspection, échange préventif…'} />
          <Field label="Date et heure du démontage" required hint="Les vols après cette date ne compteront plus pour la pièce">
            <input type="datetime-local" required value={at} onChange={(e) => setAt(e.target.value)} />
          </Field>
        </FormSection>
        {to === 'quarantaine' && <div className="fk-note warn"><Icon name="alert" size={14} /> L'emplacement restera vide : pensez à monter une pièce de remplacement (ou utilisez « Remplacer »).</div>}
        <ErrorBox error={error} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Remplacer la pièce montée par une pièce du stock
// ---------------------------------------------------------------------
export function ReplaceModal({ part, candidates, onClose, onDone }: { part: PartRow; candidates: PartRow[]; onClose: () => void; onDone: () => void }) {
  const sortedFirst = [...candidates].sort((a, b) => (remainingHours(b) ?? 1e9) - (remainingHours(a) ?? 1e9))[0];
  const [newId, setNewId] = useState(sortedFirst?.id ?? '');
  const [oldTo, setOldTo] = useState<'stock' | 'quarantaine'>(potentialLevel(part) === 'danger' ? 'stock' : 'quarantaine');
  const [at, setAt] = useState(nowLocal());
  const [reason, setReason] = useState(potentialLevel(part) === 'danger' ? 'Potentiel atteint' : '');
  const { error, busy, run } = useAction(onDone);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!newId) return;
    run(async () => unwrap(await supabase.rpc('replace_part', { p_old: part.id, p_new: newId, p_old_to: oldTo, p_at: at, p_reason: toStr(reason) })));
  };
  const chosen = candidates.find((c) => c.id === newId);
  return (
    <Modal title={`Remplacer ${part.code} – ${part.slot_label ?? zoneLabel(part.zone)}`} onClose={onClose}
      footer={<Footer form="replace-form" busy={busy} disabled={!newId} onClose={onClose} label="⇆ Remplacer" />}>
      <form id="replace-form" className="bm-form fk-form" onSubmit={submit}>
        <div className="fk-swap">
          <PartChip p={part} label="Démontée" />
          <span className="fk-swap-arrow">⇆</span>
          {chosen ? <PartChip p={chosen} label="Montée" /> : <div className="fk-part empty"><span className="pd-kicker">Montée</span><span className="small muted">choisissez une pièce ci-dessous</span></div>}
        </div>
        <FormSection n={1} icon="box" title={`Nouvelle pièce (${part.type_name}, en stock)`}>
          <CandidateList candidates={candidates} value={newId} onChange={setNewId} slotType={part.type_code}
            empty={<>Aucune pièce « {part.type_name} » en stock dans ce drone port.</>} />
          <MountWarnings partId={newId} droneId={part.drone_id} slot={part.slot} />
        </FormSection>
        <FormSection n={2} icon="alert" title={`Que devient ${part.code} ?`}>
          <ChoiceCards label="Destination de l'ancienne pièce" value={oldTo} onChange={setOldTo} options={[
            { value: 'quarantaine', label: 'Quarantaine', desc: 'Défaillance constatée', icon: 'alert', tone: 'danger' },
            { value: 'stock', label: 'Retour en stock', desc: 'Pièce bonne (échange préventif…)', icon: 'box', tone: 'ok' },
          ]} />
          <QuickChips replace items={oldTo === 'quarantaine' ? FAILURES : GOOD_REASONS} value={reason} onChange={setReason} />
          <div className="form-grid">
            <Field label={oldTo === 'quarantaine' ? 'Défaillance constatée' : 'Motif'} required={oldTo === 'quarantaine'}>
              <input required={oldTo === 'quarantaine'} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <Field label="Date et heure" required><input type="datetime-local" required value={at} onChange={(e) => setAt(e.target.value)} /></Field>
          </div>
        </FormSection>
        <ErrorBox error={error} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Statut d'une pièce non montée : quarantaine, remise en stock, rebut
// ---------------------------------------------------------------------
export function StatusModal({ part, to, onClose, onDone }: { part: PartRow; to: 'stock' | 'quarantaine' | 'rebut'; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const { error, busy, run } = useAction(onDone);
  const titles = { stock: 'Remettre en stock', quarantaine: 'Mettre en quarantaine', rebut: 'Mettre au rebut' };
  const chips = { stock: ['Contrôle OK', 'Essai au banc OK', 'Réparée', 'Fausse alerte'], quarantaine: FAILURES, rebut: ['Irréparable', 'Potentiel épuisé', 'Casse', 'Obsolète'] };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => unwrap(await supabase.rpc('set_part_status', { p_part: part.id, p_status: to, p_reason: toStr(reason) })));
  };
  return (
    <Modal title={`${titles[to]} : ${part.code}`} onClose={onClose}
      footer={<Footer form="status-form" busy={busy} onClose={onClose} label={titles[to]} danger={to !== 'stock'} />}>
      <form id="status-form" className="bm-form fk-form" onSubmit={submit}>
        <ContextBanner icon={to === 'stock' ? 'box' : to === 'rebut' ? 'wrench' : 'alert'} tone={to === 'stock' ? 'ok' : to === 'rebut' ? 'danger' : 'warn'}
          title={<>{part.code} · {part.type_name}</>} sub={<>{part.serial_number ? `S/N ${part.serial_number} · ` : ''}{hours(part.total_hours)} de vol · {part.drone_port_name ?? '—'}</>} />
        {to === 'rebut' && <div className="fk-note danger"><Icon name="alert" size={14} /> La pièce sera définitivement retirée du service et n'apparaîtra plus dans le stock.</div>}
        <FormSection icon="pen" title={to === 'stock' ? 'Contrôle effectué / conclusion' : to === 'rebut' ? 'Motif du rebut' : 'Défaillance constatée'}>
          <QuickChips replace items={chips[to]} value={reason} onChange={setReason} />
          <textarea rows={3} required={to !== 'stock'} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Motif" />
        </FormSection>
        <ErrorBox error={error} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Transfert d'une pièce de rechange vers un autre drone port
// ---------------------------------------------------------------------
export function TransferPartModal({ part, onClose, onDone }: { part: PartRow; onClose: () => void; onDone: () => void }) {
  const { ports } = useApp();
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const { error, busy, run } = useAction(onDone);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => unwrap(await supabase.rpc('transfer_part', { p_part: part.id, p_to_port: to, p_reason: toStr(reason) })));
  };
  const dest = ports.filter((p) => p.id !== part.drone_port_id && p.active);
  return (
    <Modal title={`Transférer ${part.code}`} onClose={onClose} footer={<Footer form="tp-form" busy={busy} disabled={!to} onClose={onClose} label="⇄ Transférer" />}>
      <form id="tp-form" className="bm-form fk-form" onSubmit={submit}>
        <RouteView from={part.drone_port_name ?? '—'} to={ports.find((p) => p.id === to)?.name} />
        <FormSection icon="pin" title="Drone port de destination">
          <div className="bm-packs">
            {dest.map((p) => (
              <button key={p.id} type="button" className={`bm-pack${to === p.id ? ' active' : ''}`} onClick={() => setTo(p.id)}><strong>{p.name}</strong></button>
            ))}
          </div>
        </FormSection>
        <FormSection icon="pen" title="Motif">
          <QuickChips replace items={['Réapprovisionnement', 'Rupture de stock', 'Expertise / réparation']} value={reason} onChange={setReason} />
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="ex. réapprovisionnement" aria-label="Motif" />
        </FormSection>
        <ErrorBox error={error} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Entrée en stock : création de pièces neuves (codes générés automatiquement)
// ---------------------------------------------------------------------
export function CreatePartsModal({ types, defaultType, onClose, onDone }: {
  types: PartType[]; defaultType?: string; onClose: () => void; onDone: (codes: string[]) => void;
}) {
  const { ports, portFilter, myPort, isAdmin } = useApp();
  const [f, setF] = useState({
    type: defaultType ?? '', port: portFilter || myPort?.id || '', qty: '1', serials: '', manufacturer: '',
    initial_hours: '0', max_hours: '', acquired_on: '', notes: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((cur) => ({ ...cur, [k]: v }));
  const serials = f.serials.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const type = types.find((t) => t.code === f.type);
  const categories = Array.from(new Set(types.filter((t) => t.active).map((t) => t.category)));
  const [cat, setCat] = useState(type?.category ?? categories[0] ?? '');
  const qty = serials.length || Math.max(0, Math.min(200, Number(f.qty) || 0));
  const dupes = serials.filter((s, i) => serials.indexOf(s) !== i);
  const potential = toNum(f.max_hours) ?? type?.default_max_hours ?? null;
  const initial = toNum(f.initial_hours) ?? 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const codes = unwrap(await supabase.rpc('create_parts', {
        p_type: f.type, p_qty: qty, p_port: f.port || null,
        p_serials: serials.length ? serials : null, p_manufacturer: toStr(f.manufacturer),
        p_initial_hours: initial, p_max_hours: toNum(f.max_hours),
        p_acquired_on: toStr(f.acquired_on), p_notes: toStr(f.notes),
      })) as string[];
      onDone(codes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Entrée en stock" onClose={onClose} footer={<Footer form="create-form" busy={busy} disabled={!f.type || !f.port || !qty || dupes.length > 0} onClose={onClose}
      label={`Créer ${qty} pièce(s)`} />}>
      <div className="bm">
        <form id="create-form" className="bm-form" onSubmit={submit}>
          <FormSection n={1} icon="chip" title="Type de pièce">
            <div className="rf-quick">
              {categories.map((c) => <button key={c} type="button" className={`rf-chip${cat === c ? ' active' : ''}`} onClick={() => setCat(c)}>{c}</button>)}
            </div>
            <div className="fk-types">
              {types.filter((t) => t.active && t.category === cat).map((t) => (
                <button key={t.code} type="button" className={`fk-type${f.type === t.code ? ' active' : ''}`} onClick={() => set('type', t.code)}>
                  <span className="pk-code">{t.code}</span>
                  <strong>{t.name}</strong>
                  <small>{t.default_max_hours ? `potentiel ${num(t.default_max_hours)} h` : 'potentiel à définir'}{t.multi ? ' · plusieurs par drone' : ''}</small>
                </button>
              ))}
            </div>
          </FormSection>

          <FormSection n={2} icon="box" title="Quantité & stockage">
            <div className="form-grid">
              <Field label="Drone port de stockage" required>
                {isAdmin ? <PortSelect value={f.port} onChange={(v) => set('port', v)} ports={ports} emptyLabel="— Choisir —" />
                  : <select disabled value={myPort?.id}><option value={myPort?.id}>{myPort?.name}</option></select>}
              </Field>
              <Field label="Quantité" hint={serials.length ? 'déduite des n° de série saisis' : undefined}>
                <div className="fk-stepper">
                  <button type="button" disabled={serials.length > 0 || qty <= 1} onClick={() => set('qty', String(Math.max(1, qty - 1)))}>−</button>
                  <input type="number" min="1" max="200" value={serials.length || f.qty} disabled={serials.length > 0} onChange={(e) => set('qty', e.target.value)} />
                  <button type="button" disabled={serials.length > 0 || qty >= 200} onClick={() => set('qty', String(Math.min(200, qty + 1)))}>+</button>
                </div>
              </Field>
              <Field label="N° de série (un par ligne, facultatif)" wide hint="Une pièce est créée par ligne. Les codes (ex. MOV0012) sont générés automatiquement.">
                <textarea rows={3} className="mono" value={f.serials} onChange={(e) => set('serials', e.target.value)} placeholder={'SN-123456\nSN-123457'} />
              </Field>
            </div>
            {dupes.length > 0 && <div className="fk-note danger"><Icon name="alert" size={14} /> N° de série en double : {Array.from(new Set(dupes)).join(', ')}</div>}
          </FormSection>

          <FormSection n={3} icon="clock" title="Potentiel & origine">
            <div className="form-grid">
              <Field label="Heures déjà effectuées" hint="0 pour une pièce neuve">
                <input type="number" step="0.1" min="0" value={f.initial_hours} onChange={(e) => set('initial_hours', e.target.value)} />
              </Field>
              <Field label="Potentiel propre (h)" hint={type?.default_max_hours ? `vide = potentiel du type (${num(type.default_max_hours)} h)` : 'vide = potentiel du type (non défini)'}>
                <input type="number" step="1" min="1" value={f.max_hours} onChange={(e) => set('max_hours', e.target.value)} />
              </Field>
              <Field label="Fabricant / référence"><input value={f.manufacturer} onChange={(e) => set('manufacturer', e.target.value)} /></Field>
              <Field label="Date d'acquisition"><input type="date" value={f.acquired_on} onChange={(e) => set('acquired_on', e.target.value)} /></Field>
              <Field label="Notes" wide><input value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder="ex. bon de livraison n°…" /></Field>
            </div>
          </FormSection>
          <ErrorBox error={error} />
        </form>

        <aside className="bm-aside">
          <span className="pd-kicker">Récapitulatif</span>
          <div className="fk-summary">
            <strong className="fk-qty">{qty}<small>× {type?.name ?? 'type à choisir'}</small></strong>
            <span className="small muted">{ports.find((p) => p.id === f.port)?.name ?? myPort?.name ?? 'drone port à choisir'}</span>
          </div>
          <div className="fk-codes">
            {Array.from({ length: Math.min(qty, 6) }, (_, i) => (
              <span key={i} className="fk-code-tag"><b>{type?.code ?? '???'}····</b>{serials[i] && <em>{serials[i]}</em>}</span>
            ))}
            {qty > 6 && <span className="small muted">+ {qty - 6} autre(s)</span>}
          </div>
          <div className="bm-meter">
            <div className="row-between small"><span>Potentiel</span><b>{potential ? `${num(potential)} h` : <span className="text-warn">à définir</span>}</b></div>
            {potential ? <>
              <div className="pb-bar"><i style={{ width: `${Math.min(100, (100 * initial) / potential)}%` }} /></div>
              <span className="small muted">{initial ? `${hours(initial)} déjà effectuées · reste ${hours(Math.max(0, potential - initial))}` : 'pièce neuve'}</span>
            </> : <span className="small muted">Sans potentiel, aucune alerte ni prévision de remplacement.</span>}
          </div>
          <p className="small muted">Les étiquettes QR pourront être imprimées juste après la création.</p>
        </aside>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Modifier les informations descriptives d'une pièce
// ---------------------------------------------------------------------
export function EditPartModal({ part, onClose, onDone }: { part: PartRow; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({
    serial_number: part.serial_number ?? '', manufacturer: part.manufacturer ?? '',
    initial_hours: String(part.initial_hours), max_hours: part.max_hours?.toString() ?? '',
    initial_cycles: String(part.initial_cycles ?? 0), max_cycles: part.max_cycles?.toString() ?? '',
    acquired_on: part.acquired_on ?? '', notes: part.notes ?? '',
  });
  const { error, busy, run } = useAction(onDone);
  const set = (k: keyof typeof f, v: string) => setF((cur) => ({ ...cur, [k]: v }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => unwrap(await supabase.from('parts').update({
      serial_number: toStr(f.serial_number), manufacturer: toStr(f.manufacturer), initial_hours: toNum(f.initial_hours) ?? 0,
      max_hours: toNum(f.max_hours), initial_cycles: Math.round(toNum(f.initial_cycles) ?? 0), max_cycles: toNum(f.max_cycles),
      acquired_on: toStr(f.acquired_on), notes: toStr(f.notes),
    }).eq('id', part.id).select()));
  };

  // aperçu : heures et potentiel recalculés
  const typeDefault = part.max_hours == null ? part.max_hours_effective : null;
  const own = toNum(f.max_hours);
  const potential = own ?? (part.max_hours == null ? part.max_hours_effective : null);
  const flown = Number(part.total_hours) - Number(part.initial_hours);
  const total = flown + (toNum(f.initial_hours) ?? 0);
  const pct = potential ? (100 * total) / Number(potential) : null;
  const lvl = pct == null ? 'unknown' : pct >= 100 ? 'danger' : pct >= 90 ? 'warn' : 'ok';
  // cycles : 1 vol suivi = 1 cycle (décollage + atterrissage)
  const typeCycles = part.max_cycles == null ? part.max_cycles_effective : null;
  const potentialC = toNum(f.max_cycles) ?? typeCycles;
  const flownC = Number(part.total_cycles) - Number(part.initial_cycles ?? 0);
  const totalC = flownC + Math.round(toNum(f.initial_cycles) ?? 0);
  const changed = total !== Number(part.total_hours) || (potential ?? null) !== (part.max_hours_effective ?? null)
    || totalC !== Number(part.total_cycles) || (potentialC ?? null) !== (part.max_cycles_effective ?? null);

  return (
    <Modal title={`Modifier ${part.code}`} onClose={onClose} footer={<Footer form="edit-part" busy={busy} onClose={onClose} label="Enregistrer" />}>
      <div className="bm">
        <form id="edit-part" className="bm-form" onSubmit={submit}>
          <FormSection n={1} icon="search" title="Identification">
            <div className="form-grid">
              <Field label="N° de série"><input className="mono" value={f.serial_number} onChange={(e) => set('serial_number', e.target.value)} /></Field>
              <Field label="Fabricant / référence"><input value={f.manufacturer} onChange={(e) => set('manufacturer', e.target.value)} /></Field>
              <Field label="Date d'acquisition"><input type="date" value={f.acquired_on} onChange={(e) => set('acquired_on', e.target.value)} /></Field>
            </div>
          </FormSection>
          <FormSection n={2} icon="clock" title="Heures & potentiel">
            <ChoiceCards label="Potentiel" value={f.max_hours.trim() ? 'own' : 'type'} onChange={(v) => set('max_hours', v === 'type' ? '' : String(potential ?? typeDefault ?? 100))} options={[
              { value: 'type', label: 'Potentiel du type', desc: typeDefault ? `${num(typeDefault)} h, commun au type ${part.type_code}` : `celui du type ${part.type_code}`, icon: 'chip' },
              { value: 'own', label: 'Potentiel propre', desc: 'spécifique à cette pièce (ex. pièce reconditionnée)', icon: 'pen' },
            ]} />
            <div className="form-grid">
              <Field label="Heures avant suivi" hint="heures effectuées avant l'utilisation du logiciel"><input type="number" step="0.1" min="0" value={f.initial_hours} onChange={(e) => set('initial_hours', e.target.value)} /></Field>
              {f.max_hours.trim() !== '' && <Field label="Potentiel propre (h)" required><input type="number" step="1" min="1" required value={f.max_hours} onChange={(e) => set('max_hours', e.target.value)} /></Field>}
            </div>
          </FormSection>
          <FormSection n={3} icon="flight" title="Cycles" hint="1 cycle = 1 décollage + 1 atterrissage, compté à chaque vol pendant le montage">
            <div className="form-grid">
              <Field label="Cycles avant suivi" hint="cycles effectués avant l'utilisation du logiciel"><input type="number" step="1" min="0" value={f.initial_cycles} onChange={(e) => set('initial_cycles', e.target.value)} /></Field>
              <Field label="Potentiel propre (cycles)" hint={typeCycles ? `vide = potentiel du type (${num(typeCycles, 0)} cycles)` : 'vide = potentiel du type (non défini)'}>
                <input type="number" step="1" min="1" value={f.max_cycles} onChange={(e) => set('max_cycles', e.target.value)} />
              </Field>
            </div>
          </FormSection>
          <Field label="Notes" wide><textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
          <ErrorBox error={error} />
        </form>

        <aside className="bm-aside">
          <span className="pd-kicker">Aperçu</span>
          <div className="fk-aside-ring">
            <GaugeRing value={pct ?? 0} level={lvl} size={130}
              center={pct == null ? hours(total) : pct >= 100 ? 'Dépassé' : `${num(Math.max(0, Number(potential) - total), 0)} h`}
              sub={pct == null ? 'potentiel à définir' : pct >= 100 ? `de ${hours(total - Number(potential))}` : `restantes · ${num(pct, 0)} %`} />
          </div>
          <div className="fk-kv"><span>Heures totales</span><b>{hours(total)}</b></div>
          <div className="fk-kv"><span>dont vols suivis</span><b>{hours(flown)}</b></div>
          <div className="fk-kv"><span>Potentiel</span><b>{potential ? `${num(potential)} h` : '—'}</b></div>
          <div className="fk-kv"><span>Cycles</span><b>{num(totalC, 0)}{potentialC ? ` / ${num(potentialC, 0)}` : ''}</b></div>
          {changed && <div className="fk-note info"><Icon name="bolt" size={14} /> Avant : {hours(part.total_hours)}{part.max_hours_effective ? ` / ${num(part.max_hours_effective)} h` : ''}. Les alertes et prévisions seront recalculées.</div>}
        </aside>
      </div>
    </Modal>
  );
}
