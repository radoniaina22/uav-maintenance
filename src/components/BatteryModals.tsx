import { FormEvent, ReactNode, useState } from 'react';
import { supabase, unwrap } from '../lib/supabase';
import { useApp } from '../lib/app';
import { useData } from '../lib/useData';
import type { Battery, BatteryPack, BatteryStatus, BatteryStatusRow } from '../lib/types';
import { batteryCode, batteryLevel, healthLevel, LABELS, num, THRESHOLDS, today, toNum, toStr } from '../lib/format';
import { ErrorBox, Field, Modal, PortSelect } from './ui';
import { Icon, IconName } from './icons';
import { BatteryCell } from './BatteryVisuals';

const errMsg = (err: unknown) => {
  const m = err instanceof Error ? err.message : String(err);
  if (m.includes('batteries_pack_slot')) return 'Cette position du pack est déjà occupée.';
  if (m.includes('batteries_serial_number_key')) return 'Ce numéro de série existe déjà.';
  if (m.includes('battery_packs_pack_number_key')) return 'Ce numéro de pack existe déjà.';
  return m;
};

function Footer({ form, busy, onClose, label = 'Enregistrer', disabled }: { form: string; busy: boolean; onClose: () => void; label?: string; disabled?: boolean }) {
  return <>
    <button className="btn" type="button" onClick={onClose}>Annuler</button>
    <button className="btn btn-primary" form={form} disabled={busy || disabled}>{busy ? 'Enregistrement…' : label}</button>
  </>;
}

/** En-tête de section numérotée */
function Section({ n, icon, title, hint, children }: { n: number; icon: IconName; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="bm-section">
      <div className="bm-sec-head">
        <span className="bm-sec-n">{n}</span>
        <Icon name={icon} size={15} />
        <strong>{title}</strong>
        {hint && <span className="bm-sec-hint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

const CAPACITIES = [{ v: '30000', label: '30 000 mAh', sub: 'Tattu 12S 30 Ah' }, { v: '33000', label: '33 000 mAh', sub: 'Tattu 12S 33 Ah' }];
const STATUS_INFO: Record<BatteryStatus, { icon: IconName; desc: string }> = {
  en_service: { icon: 'flight', desc: 'Utilisable pour les vols' },
  stock: { icon: 'box', desc: 'En réserve, non utilisée' },
  hors_service: { icon: 'alert', desc: 'Retirée définitivement' },
};

function StatusPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="bm-status" role="radiogroup" aria-label="Statut">
      {(Object.keys(LABELS.batteryStatus) as BatteryStatus[]).map((s) => (
        <button key={s} type="button" role="radio" aria-checked={value === s} className={`bm-st st-${s}${value === s ? ' active' : ''}`} onClick={() => onChange(s)}>
          <Icon name={STATUS_INFO[s].icon} size={16} />
          <strong>{LABELS.batteryStatus[s]}</strong>
          <span>{STATUS_INFO[s].desc}</span>
        </button>
      ))}
    </div>
  );
}

function CapacityPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="bm-caps" role="radiogroup" aria-label="Capacité nominale">
      {CAPACITIES.map((c) => (
        <button key={c.v} type="button" role="radio" aria-checked={value === c.v} className={`bm-cap${value === c.v ? ' active' : ''}`} onClick={() => onChange(c.v)}>
          <Icon name="battery" size={18} />
          <span><strong>{c.label}</strong><small>{c.sub}</small></span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------
// Batterie
// ---------------------------------------------------------------------
export function BatteryModal({ battery, packs, onClose, onSaved }: {
  battery: (Battery & Partial<BatteryStatusRow>) | null; packs: BatteryPack[]; onClose: () => void; onSaved: () => void;
}) {
  const { ports, portFilter } = useApp();
  const [f, setF] = useState({
    serial_number: battery?.serial_number ?? '',
    model: battery?.model ?? 'Tattu 12S',
    capacity_mah: String(battery?.capacity_mah ?? 30000),
    initial_cycles: String(battery?.initial_cycles ?? 0),
    max_cycles: String(battery?.max_cycles ?? 500),
    status: battery?.status ?? 'en_service',
    commissioned_on: battery?.commissioned_on ?? '',
    pack_id: battery?.pack_id ?? '',
    position: battery?.position ?? 'A',
    drone_port_id: battery ? battery.drone_port_id ?? '' : portFilter,
    notes: battery?.notes ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((cur) => ({ ...cur, [k]: v }));

  // occupation des positions de chaque pack (pour éviter les doublons A/B)
  const occ = useData(async () => unwrap(await supabase.from('batteries').select('id, serial_number, pack_id, position').not('pack_id', 'is', null)) as
    { id: string; serial_number: string | null; pack_id: string; position: 'A' | 'B' }[], []);
  const occupant = (packId: string, pos: 'A' | 'B') => occ.data?.find((x) => x.pack_id === packId && x.position === pos && x.id !== battery?.id);
  const freeIn = (packId: string) => (['A', 'B'] as const).filter((p) => !occupant(packId, p));

  function pickPack(id: string) {
    setF((cur) => {
      const free = id ? freeIn(id) : [];
      const position = id && !free.includes(cur.position as 'A' | 'B') && free.length ? free[0] : cur.position;
      return { ...cur, pack_id: id, position };
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const payload: Record<string, unknown> = {
      serial_number: toStr(f.serial_number),
      model: f.model.trim() || 'Tattu 12S',
      capacity_mah: Number(f.capacity_mah),
      initial_cycles: toNum(f.initial_cycles) ?? 0,
      max_cycles: toNum(f.max_cycles) ?? 500,
      status: f.status as BatteryStatus,
      commissioned_on: toStr(f.commissioned_on),
      pack_id: toStr(f.pack_id),
      position: f.pack_id ? f.position : null,
      notes: toStr(f.notes),
    };
    // Le drone port d'une batterie hors pack se fixe à la création ; ensuite on passe par un transfert
    if (!battery && !f.pack_id) payload.drone_port_id = toStr(f.drone_port_id);
    try {
      if (battery) unwrap(await supabase.from('batteries').update(payload).eq('id', battery.id));
      else unwrap(await supabase.from('batteries').insert(payload));
      onSaved();
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  }

  // ---- aperçu en direct
  const pack = packs.find((p) => p.id === f.pack_id);
  const flightCycles = Number(battery?.flight_cycles ?? 0);
  const initial = toNum(f.initial_cycles) ?? 0;
  const max = toNum(f.max_cycles) ?? 500;
  const total = initial + flightCycles;
  const cyclePct = max > 0 ? (100 * total) / max : 0;
  const capacity = Number(f.capacity_mah);
  const healthNow = battery?.last_measured_mah ? (100 * Number(battery.last_measured_mah)) / capacity : null;
  const code = pack ? `${pack.pack_number}${f.position}` : f.serial_number.trim() || '—';
  const posTaken = pack ? occupant(pack.id, f.position as 'A' | 'B') : undefined;
  const warnings: string[] = [];
  if (posTaken) warnings.push(`La position ${pack!.pack_number}${f.position} est déjà occupée par ${posTaken.serial_number ?? 'une batterie sans n° de série'}.`);
  if (battery && Number(battery.capacity_mah) !== capacity && battery.last_measured_mah) warnings.push(`La santé sera recalculée sur ${num(capacity, 0)} mAh : ${num(healthNow!, 1)} % au lieu de ${num(battery.health_pct ?? 0, 1)} %.`);
  if (f.status === 'hors_service' && f.pack_id) warnings.push('Une batterie hors service ne devrait plus être dans un pack : passez-la « hors pack ».');
  if (total > max) warnings.push(`Les cycles (${total}) dépassent le maximum (${max}).`);
  if (battery && battery.pack_id && battery.pack_id !== f.pack_id) warnings.push(f.pack_id ? `Changement de pack : la batterie prendra le drone port du pack ${pack?.pack_number}.` : 'La batterie sort de son pack et garde son drone port actuel.');

  return (
    <Modal title={battery ? `Modifier la batterie ${batteryCode(battery)}` : 'Nouvelle batterie'} onClose={onClose}
      footer={<Footer form="battery-form" busy={busy} onClose={onClose} disabled={!!posTaken} />}>
      <div className="bm">
        <form id="battery-form" className="bm-form" onSubmit={submit}>
          <Section n={1} icon="search" title="Identification">
            <div className="form-grid">
              <Field label="N° de série (fabricant)" hint="facultatif : peut être complété plus tard"><input className="mono" value={f.serial_number} onChange={(e) => set('serial_number', e.target.value)} placeholder="ex. TT-005" /></Field>
              <Field label="Modèle" required><input required value={f.model} onChange={(e) => set('model', e.target.value)} /></Field>
            </div>
          </Section>

          <Section n={2} icon="battery" title="Capacité nominale" hint="référence de l'état de santé">
            <CapacityPicker value={f.capacity_mah} onChange={(v) => set('capacity_mah', v)} />
          </Section>

          <Section n={3} icon="box" title="Affectation" hint="les 2 batteries d'un pack sont montées en parallèle">
            <div className="bm-packs" role="radiogroup" aria-label="Pack">
              <button type="button" role="radio" aria-checked={!f.pack_id} className={`bm-pack${!f.pack_id ? ' active' : ''}`} onClick={() => pickPack('')}>
                <strong>Hors pack</strong><small>réserve ou retirée</small>
              </button>
              {packs.map((p) => {
                const free = freeIn(p.id);
                return (
                  <button key={p.id} type="button" role="radio" aria-checked={f.pack_id === p.id}
                    className={`bm-pack${f.pack_id === p.id ? ' active' : ''}${!free.length ? ' full' : ''}`} onClick={() => pickPack(p.id)}
                    title={!free.length ? 'Les 2 positions sont occupées' : undefined}>
                    <strong>Pack {p.pack_number}</strong><small>{free.length === 2 ? 'vide' : free.length ? `${free[0]} libre` : 'complet'}</small>
                  </button>
                );
              })}
            </div>
            {pack ? (
              <div className="bm-pos">
                {(['A', 'B'] as const).map((pos) => {
                  const o = occupant(pack.id, pos);
                  return (
                    <button key={pos} type="button" className={`bm-pos-btn${f.position === pos ? ' active' : ''}${o ? ' taken' : ''}`} disabled={!!o} onClick={() => set('position', pos)}>
                      <b>{pack.pack_number}{pos}</b>
                      <span>{o ? `occupée · ${o.serial_number ?? 'sans n°'}` : f.position === pos ? 'cette batterie' : 'libre'}</span>
                    </button>
                  );
                })}
              </div>
            ) : !battery ? (
              <Field label="Drone port"><PortSelect value={f.drone_port_id} onChange={(v) => set('drone_port_id', v)} ports={ports} /></Field>
            ) : <p className="muted small">Pour changer de drone port une batterie hors pack, utilisez « Transférer » (historisé).</p>}
          </Section>

          <Section n={4} icon="shield" title="Statut">
            <StatusPicker value={f.status} onChange={(v) => set('status', v)} />
          </Section>

          <Section n={5} icon="clock" title="Cycles & mise en service">
            <div className="form-grid">
              <Field label="Cycles déjà effectués" hint="avant l'utilisation du logiciel"><input type="number" min="0" value={f.initial_cycles} onChange={(e) => set('initial_cycles', e.target.value)} /></Field>
              <Field label="Cycles maximum" hint={<span className="rf-quick">{[300, 500, 800].map((v) => <button key={v} type="button" className={`rf-chip${f.max_cycles === String(v) ? ' active' : ''}`} onClick={() => set('max_cycles', String(v))}>{v}</button>)}</span>}>
                <input type="number" min="1" value={f.max_cycles} onChange={(e) => set('max_cycles', e.target.value)} />
              </Field>
              <Field label="Mise en service"><input type="date" value={f.commissioned_on} onChange={(e) => set('commissioned_on', e.target.value)} /></Field>
            </div>
          </Section>

          <Field label="Notes" wide><textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Origine, incidents, particularités…" /></Field>
          <ErrorBox error={error} />
        </form>

        <aside className="bm-aside" aria-label="Aperçu">
          <span className="pd-kicker">Aperçu</span>
          <div className="bm-preview">
            <BatteryCell b={{ health_pct: healthNow, last_measured_mah: battery?.last_measured_mah ?? null }} label={pack ? `${pack.pack_number}${f.position}` : ''} size="lg" />
            <div className="bm-preview-id">
              <strong>{code}</strong>
              <span className="mono">{f.serial_number || 'sans n° de série'}</span>
              <span>{/mah/i.test(f.model) ? f.model : `${f.model} · ${num(capacity / 1000, 0)} Ah`}</span>
              <span className={`bm-st-pill st-${f.status}`}>{LABELS.batteryStatus[f.status as BatteryStatus]}</span>
            </div>
          </div>
          <div className="bm-meter">
            <div className="row-between small"><span>Cycles</span><b className={`text-${batteryLevel(cyclePct)}`}>{total} / {max}</b></div>
            <div className={`pb-bar lv-${batteryLevel(cyclePct)}`}><i style={{ width: `${Math.min(100, cyclePct)}%` }} /></div>
            <span className="small muted">{initial} initiaux + {flightCycles} vols · reste {Math.max(0, max - total)}</span>
          </div>
          <div className="bm-meter">
            <div className="row-between small"><span>Santé</span><b className={healthNow != null ? `text-${healthLevel(healthNow)}` : 'muted'}>{healthNow != null ? `${num(healthNow, 1)} %` : 'pas de relevé'}</b></div>
            {healthNow != null && <div className={`pb-bar lv-${healthLevel(healthNow) === 'ok' ? 'ok' : healthLevel(healthNow)}`}><i style={{ width: `${Math.min(100, healthNow)}%`, background: healthLevel(healthNow) === 'ok' ? '#3dd68c' : undefined }} /></div>}
            {battery?.last_measured_mah && <span className="small muted">{num(battery.last_measured_mah, 0)} mAh mesurés / {num(capacity, 0)} nominaux</span>}
          </div>
          {pack && <p className="small muted">Drone port : celui du pack {pack.pack_number}.</p>}
          {warnings.length > 0 && (
            <ul className="bm-warn">{warnings.map((w) => <li key={w}><Icon name="alert" size={13} /> {w}</li>)}</ul>
          )}
        </aside>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Pack (création avec ses 2 batteries, ou modification)
// ---------------------------------------------------------------------
export function PackModal({ pack, nextNumber, onClose, onSaved }: {
  pack: BatteryPack | null; nextNumber: number; onClose: () => void; onSaved: () => void;
}) {
  const { ports, portFilter } = useApp();
  const [f, setF] = useState({
    pack_number: String(pack?.pack_number ?? nextNumber),
    drone_port_id: pack ? pack.drone_port_id ?? '' : portFilter,
    status: pack?.status ?? 'en_service',
    notes: pack?.notes ?? '',
    capacity_mah: '30000',
    serial_a: '', cycles_a: '0',
    serial_b: '', cycles_b: '0',
  });
  /** les 2 batteries sont créées avec le pack (n° de série facultatifs) */
  const [withBatteries, setWithBatteries] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((cur) => ({ ...cur, [k]: v }));
  const members = useData(async () => (pack
    ? unwrap(await supabase.from('v_battery_status').select('*').eq('pack_id', pack.id).order('position')) as BatteryStatusRow[]
    : []), [pack?.id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const base = { pack_number: Number(f.pack_number), status: f.status as BatteryStatus, notes: toStr(f.notes) };
      if (pack) {
        unwrap(await supabase.from('battery_packs').update(base).eq('id', pack.id));
      } else {
        const created = unwrap(await supabase.from('battery_packs')
          .insert({ ...base, drone_port_id: toStr(f.drone_port_id) }).select().single()) as BatteryPack;
        const rows = [
          { serial: f.serial_a, cycles: f.cycles_a, position: 'A' },
          { serial: f.serial_b, cycles: f.cycles_b, position: 'B' },
        ].filter(() => withBatteries).map((r) => ({
          serial_number: toStr(r.serial), position: r.position, pack_id: created.id,
          capacity_mah: Number(f.capacity_mah), initial_cycles: toNum(r.cycles) ?? 0,
          status: f.status as BatteryStatus,
        }));
        if (rows.length) {
          const res = await supabase.from('batteries').insert(rows);
          if (res.error) {
            await supabase.from('battery_packs').delete().eq('id', created.id); // annule la création du pack
            throw new Error(res.error.message);
          }
        }
      }
      onSaved();
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  }

  const dCycles = Math.abs((toNum(f.cycles_a) ?? 0) - (toNum(f.cycles_b) ?? 0));
  const m = members.data ?? [];
  return (
    <Modal title={pack ? `Modifier le pack ${pack.pack_number}` : 'Nouveau pack de batteries'} onClose={onClose}
      footer={<Footer form="pack-form" busy={busy} onClose={onClose} label={pack ? 'Enregistrer' : 'Créer le pack'} />}>
      <form id="pack-form" className="bm-form bm-single" onSubmit={submit}>
        <Section n={1} icon="box" title="Pack">
          <div className="form-grid">
            <Field label="N° de pack" required><input type="number" min="1" required value={f.pack_number} onChange={(e) => set('pack_number', e.target.value)} /></Field>
            {!pack
              ? <Field label="Drone port"><PortSelect value={f.drone_port_id} onChange={(v) => set('drone_port_id', v)} ports={ports} /></Field>
              : <div className="computed"><span className="field-label">Drone port</span><strong>{ports.find((p) => p.id === pack.drone_port_id)?.name ?? 'Non affecté'}</strong><span className="field-hint">changer via « Transférer »</span></div>}
          </div>
        </Section>

        <Section n={2} icon="shield" title="Statut" hint={!pack ? 'appliqué aussi aux 2 batteries' : undefined}>
          <StatusPicker value={f.status} onChange={(v) => set('status', v)} />
        </Section>

        {!pack ? <>
          <Section n={3} icon="battery" title="Capacité nominale des batteries">
            <CapacityPicker value={f.capacity_mah} onChange={(v) => set('capacity_mah', v)} />
          </Section>
          <Section n={4} icon="bolt" title="Batteries du pack" hint="n° de série facultatifs">
            <label className="check"><input type="checkbox" checked={withBatteries} onChange={(e) => setWithBatteries(e.target.checked)} /> Créer les batteries {f.pack_number || '?'}A et {f.pack_number || '?'}B maintenant</label>
            {withBatteries && <div className="bm-pair">
              {(['a', 'b'] as const).map((k) => (
                <div key={k} className="bm-pair-card">
                  <span className="bm-pair-code">{f.pack_number || '?'}{k.toUpperCase()}</span>
                  <Field label="N° de série" hint="facultatif"><input className="mono" value={f[`serial_${k}`]} onChange={(e) => set(`serial_${k}`, e.target.value)} placeholder="ex. TT-005" /></Field>
                  <Field label="Cycles déjà effectués"><input type="number" min="0" value={f[`cycles_${k}`]} onChange={(e) => set(`cycles_${k}`, e.target.value)} /></Field>
                </div>
              ))}
            </div>}
            {!withBatteries && <p className="small muted">Le pack sera créé vide : vous y placerez des batteries existantes ou nouvelles depuis leur fiche (« Modifier »).</p>}
            {withBatteries && (
              <div className={`bpack-balance${dCycles > 25 ? ' warn' : ''}`}>
                <Icon name={dCycles > 25 ? 'alert' : 'shield'} size={14} />
                <span>Écart de <b>{dCycles} cycles</b> entre A et B{dCycles > 25 ? ' : préférez 2 batteries d\'usure proche (montage en parallèle).' : ' : appairage correct.'}</span>
              </div>
            )}
          </Section>
        </> : (
          <Section n={3} icon="battery" title="Batteries du pack">
            <div className="bm-members">
              {(['A', 'B'] as const).map((pos) => {
                const b = m.find((x) => x.position === pos);
                return b ? (
                  <div key={pos} className="bm-member">
                    <BatteryCell b={b} label={pos} size="sm" />
                    <div><strong className="mono">{b.serial_number ?? 'sans n° de série'}</strong><span>{b.total_cycles}/{b.max_cycles} cycles · {b.health_pct != null ? `${num(b.health_pct, 1)} %` : 'pas de relevé'}</span></div>
                  </div>
                ) : <div key={pos} className="bm-member empty"><span className="bcell-ghost">{pack.pack_number}{pos}</span><span className="muted small">Position libre : affectez une batterie depuis sa fiche (« Modifier »).</span></div>;
              })}
            </div>
          </Section>
        )}

        <Field label="Notes" wide><textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
        <ErrorBox error={error} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Relevé de capacité
// ---------------------------------------------------------------------
export function CapacityModal({ battery, onClose, onSaved }: { battery: BatteryStatusRow; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ test_date: today(), measured_mah: '', technician: '', notes: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const measured = toNum(f.measured_mah);
  const pct = measured ? (measured / battery.capacity_mah) * 100 : null;
  const delta = measured && battery.last_measured_mah ? measured - Number(battery.last_measured_mah) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      unwrap(await supabase.from('battery_capacity_tests').insert({
        battery_id: battery.id, test_date: f.test_date, measured_mah: measured,
        technician: toStr(f.technician), notes: toStr(f.notes),
      }));
      onSaved();
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Relevé de capacité – ${batteryCode(battery)}`} onClose={onClose} footer={<Footer form="cap-form" busy={busy} onClose={onClose} />}>
      <div className="bm bm-cap-layout">
        <form id="cap-form" className="bm-form" onSubmit={submit}>
          <div className="form-grid">
            <Field label="Date du relevé" required><input type="date" required value={f.test_date} onChange={(e) => setF({ ...f, test_date: e.target.value })} /></Field>
            <Field label="Capacité mesurée (mAh)" required hint={`Nominale : ${num(battery.capacity_mah, 0)} mAh${battery.last_measured_mah ? ` · dernier relevé : ${num(battery.last_measured_mah, 0)} mAh` : ''}`}>
              <input type="number" min="1" max="40000" step="1" required autoFocus value={f.measured_mah} onChange={(e) => setF({ ...f, measured_mah: e.target.value })} />
            </Field>
            <Field label="Technicien"><input value={f.technician} onChange={(e) => setF({ ...f, technician: e.target.value })} /></Field>
            <div className="computed"><span className="field-label">Cycles au relevé</span><strong>{battery.total_cycles}</strong><span className="field-hint">enregistrés automatiquement</span></div>
            <Field label="Notes" wide hint="Conditions de décharge, chargeur utilisé, anomalies…"><textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
          </div>
          <ErrorBox error={error} />
        </form>
        <aside className="bm-aside">
          <span className="pd-kicker">État de santé</span>
          <div className="bm-preview">
            <BatteryCell b={{ health_pct: pct, last_measured_mah: measured }} label={batteryCode(battery)} size="lg" />
            <div className="bm-preview-id">
              <strong className={pct != null ? `text-${healthLevel(pct)}` : 'muted'}>{pct != null ? `${num(pct, 1)} %` : '—'}</strong>
              <span>{pct == null ? 'saisissez la capacité mesurée' : pct < THRESHOLDS.healthDangerPct ? 'critique : à retirer du service' : pct < THRESHOLDS.healthWarnPct ? 'à surveiller' : 'bon état'}</span>
              {delta != null && <span className={delta < 0 ? 'text-warn' : 'text-ok'}>{delta > 0 ? '+' : ''}{num(delta, 0)} mAh / précédent</span>}
            </div>
          </div>
        </aside>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Transfert de drone port (pack complet ou batterie hors pack)
// ---------------------------------------------------------------------
export function TransferModal({ target, onClose, onSaved }: {
  target: { kind: 'pack'; id: string; label: string; portId: string | null } | { kind: 'battery'; id: string; label: string; portId: string | null };
  onClose: () => void; onSaved: () => void;
}) {
  const { ports } = useApp();
  const [f, setF] = useState({ to: '', date: today(), notes: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const from = ports.find((p) => p.id === target.portId)?.name ?? 'Non affecté';
  const toName = ports.find((p) => p.id === f.to)?.name;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const args = { p_to_port_id: f.to || null, p_date: f.date, p_notes: toStr(f.notes) };
      if (target.kind === 'pack') unwrap(await supabase.rpc('transfer_pack', { p_pack_id: target.id, ...args }));
      else unwrap(await supabase.rpc('transfer_battery', { p_battery_id: target.id, ...args }));
      onSaved();
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Transférer ${target.label}`} onClose={onClose} footer={<Footer form="transfer-form" busy={busy} onClose={onClose} label="Transférer" />}>
      <form id="transfer-form" className="form-grid" onSubmit={submit}>
        <div className="bm-route field-wide">
          <div><span className="pd-kicker">Depuis</span><strong>{from}</strong></div>
          <span className="bm-route-arrow">→</span>
          <div className={toName ? '' : 'muted'}><span className="pd-kicker">Vers</span><strong>{toName ?? 'à choisir'}</strong></div>
        </div>
        <Field label="Nouveau drone port" required>
          <select required value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })}>
            <option value="">— Choisir —</option>
            {ports.filter((p) => p.id !== target.portId && p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Date du transfert" required><input type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Motif / notes" wide><textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        {target.kind === 'pack' && <p className="muted small field-wide">Les deux batteries du pack sont transférées ensemble. Leurs cycles et relevés de capacité sont conservés.</p>}
        <ErrorBox error={error} />
      </form>
    </Modal>
  );
}
