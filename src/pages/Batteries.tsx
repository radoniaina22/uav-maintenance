import { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { byPort, useApp } from '../lib/app';
import { useData } from '../lib/useData';
import type { BatteryPack, BatteryStatusRow, PackStatusRow, TransferRow } from '../lib/types';
import { batteryCode, batteryLevel, date, healthLevel, LABELS, num, THRESHOLDS } from '../lib/format';
import { daysBetween, iso, parseIso } from '../lib/stats';
import { Badge, Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { Icon } from '../components/icons';
import { BatteryCell, cycleRates, endOfLife, rateSince } from '../components/BatteryVisuals';
import { BatteryModal, CapacityModal, PackModal, TransferModal } from '../components/BatteryModals';

type ModalState =
  | { kind: 'pack'; pack: BatteryPack | null }
  | { kind: 'battery'; battery: BatteryStatusRow | null }
  | { kind: 'capacity'; battery: BatteryStatusRow }
  | { kind: 'transfer'; target: Parameters<typeof TransferModal>[0]['target'] };

const statusLevel = (s: string) => (s === 'en_service' ? 'ok' : s === 'stock' ? 'neutral' : 'danger');
/** Un relevé de capacité est conseillé au moins tous les 90 jours */
const TEST_DUE_DAYS = 90;
/** Écarts tolérés entre les 2 batteries d'un pack (montées en parallèle) */
const BALANCE_HEALTH_PTS = 5;
const BALANCE_CYCLES = 25;

const fmtLife = (e: { days: number; date: string } | null) =>
  !e ? 'pas de vol récent' : e.days === 0 ? 'atteinte' : e.days > 3650 ? '> 10 ans' : e.days > 365 ? `≈ ${num(e.days / 365, 1)} ans` : parseIso(e.date).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' });

/** Ligne d'une batterie dans une carte de pack */
function PackBattery({ b, perDay, onCapacity }: { b: BatteryStatusRow; perDay: number; onCapacity: () => void }) {
  const lvl = batteryLevel(b.cycle_pct);
  const testAge = b.last_test_date ? daysBetween(b.last_test_date, iso(new Date())) : null;
  return (
    <div className="pb-row">
      <BatteryCell b={b} label={b.position ?? ''} />
      <div className="pb-main">
        <div className="pb-head">
          <Link to={`/batteries/${b.id}`} className="pb-sn">{b.serial_number ?? 'sans n° de série'}</Link>
          <span className={`pb-cycles text-${lvl}`}><b>{b.total_cycles}</b> / {b.max_cycles} cycles</span>
        </div>
        <div className={`pb-bar lv-${lvl}`}><i style={{ width: `${Math.min(100, b.cycle_pct)}%` }} /></div>
        <div className="pb-meta">
          {b.last_measured_mah
            ? <span className={`text-${healthLevel(b.health_pct)}`}>{num(b.last_measured_mah, 0)} / {num(b.capacity_mah, 0)} mAh</span>
            : <span className="text-warn">aucun relevé</span>}
          <span>{perDay > 0 ? `${num(perDay * 7, 1)} cycles/sem.` : 'inactive (30 j)'}</span>
        </div>
        {testAge != null && testAge > TEST_DUE_DAYS && <div className="pb-due">Relevé de plus de {TEST_DUE_DAYS} jours ({date(b.last_test_date)})</div>}
      </div>
      <button className="btn btn-sm" onClick={onCapacity} title="Saisir un relevé de capacité">Relevé</button>
    </div>
  );
}

export default function Batteries() {
  const { portFilter, isAdmin } = useApp();
  const [modal, setModal] = useState<ModalState | null>(null);
  const [showRetired, setShowRetired] = useState(false);

  const { data, error, loading, reload } = useData(async () => {
    const [packs, batteries, transfers, allPacks, flights] = await Promise.all([
      byPort(supabase.from('v_pack_status').select('*'), portFilter).order('pack_number'),
      byPort(supabase.from('v_battery_status').select('*'), portFilter).order('pack_number').order('position').order('serial_number'),
      supabase.from('v_battery_transfers').select('*').order('transfer_date', { ascending: false }).order('created_at', { ascending: false }).limit(20),
      supabase.from('battery_packs').select('*').order('pack_number'),
      byPort(supabase.from('v_flights').select('battery_1_id, battery_2_id'), portFilter).gte('flight_date', rateSince()).limit(5000),
    ]);
    return {
      packs: unwrap(packs) as PackStatusRow[],
      batteries: unwrap(batteries) as BatteryStatusRow[],
      transfers: unwrap(transfers) as TransferRow[],
      allPacks: unwrap(allPacks) as BatteryPack[],
      rates: cycleRates((unwrap(flights) ?? []) as { battery_1_id: string | null; battery_2_id: string | null }[]),
    };
  }, [portFilter]);

  const close = () => setModal(null);
  const saved = () => { setModal(null); reload(); };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const todayIso = iso(new Date());
  const rate = (id: string) => data.rates.get(id) ?? 0;
  const packs = data.packs.filter((p) => showRetired || p.status !== 'hors_service');
  const loose = data.batteries.filter((b) => !b.pack_id && (showRetired || b.status !== 'hors_service'));
  const active = data.batteries.filter((b) => b.status !== 'hors_service');
  const cycleAlerts = active.filter((b) => batteryLevel(b.cycle_pct) !== 'ok');
  const healthAlerts = active.filter((b) => healthLevel(b.health_pct) !== 'ok' && b.health_pct != null);
  const testsDue = active.filter((b) => !b.last_test_date || daysBetween(b.last_test_date, todayIso) > TEST_DUE_DAYS);
  const measured = active.filter((b) => b.health_pct != null);
  const avgHealth = measured.length ? measured.reduce((s, b) => s + Number(b.health_pct), 0) / measured.length : null;
  const totalCycles = active.reduce((s, b) => s + b.total_cycles, 0);
  const lives = active.map((b) => ({ b, eol: endOfLife(b, rate(b.id)) })).filter((x) => x.eol).sort((a, b) => a.eol!.days - b.eol!.days);
  const nextEol = lives[0];
  const nextNumber = Math.max(0, ...data.allPacks.map((p) => p.pack_number)) + 1;
  const nominalAh = Array.from(new Set(active.map((b) => b.capacity_mah / 1000))).sort((a, b) => a - b).map((v) => num(v, 0)).join(' / ');

  // Transferts : une ligne par pack et par date (les 2 batteries d'un pack sont regroupées)
  const transferGroups = Object.values(data.transfers.reduce<Record<string, TransferRow & { items: string[] }>>((acc, t) => {
    const key = `${t.pack_id ?? t.battery_id}|${t.transfer_date}|${t.to_port_id}`;
    acc[key] ??= { ...t, items: [] };
    acc[key].items.push(t.serial_number ?? 'sans n°');
    return acc;
  }, {}));

  return (
    <div className="bat-page">
      <PageHeader
        title="Batteries"
        subtitle="Packs de 2 batteries en parallèle (1A + 1B…) · 1 vol = 1 cycle par batterie · santé = capacité réelle / nominale"
        actions={isAdmin && <>
          <button className="btn" onClick={() => setModal({ kind: 'battery', battery: null })}>+ Batterie</button>
          <button className="btn btn-primary" onClick={() => setModal({ kind: 'pack', pack: null })}>+ Nouveau pack</button>
        </>}
      />

      {/* ===== Bandeau du parc ===== */}
      <section className="bat-hero">
        <img className="bat-hero-img" src="./battery-tattu.png" alt="Batterie Tattu 12S" />
        <div className="bat-hero-body">
          <span className="pd-kicker">Parc batteries</span>
          <h2>Tattu 12S · NMC LiPo</h2>
          <div className="bat-specs">
            <span>44,4 V</span><span>12 cellules</span><span>{nominalAh || '30'} Ah</span><span>{Math.max(0, ...active.map((b) => b.max_cycles)) || 500} cycles max</span>
          </div>
          <div className="bat-hero-stats">
            <div><b>{data.packs.filter((p) => p.status === 'en_service').length}</b><span>packs en service</span></div>
            <div><b>{active.length}</b><span>batteries actives</span></div>
            <div><b className={avgHealth != null ? `text-${healthLevel(avgHealth)}` : ''}>{avgHealth != null ? `${num(avgHealth, 1)} %` : '—'}</b><span>santé moyenne</span></div>
            <div><b>{num(totalCycles, 0)}</b><span>cycles cumulés</span></div>
          </div>
        </div>
      </section>

      <div className="flight-kpis bat-kpis">
        <div className={`fk${cycleAlerts.length ? ' fk-warn' : ' fk-ok'}`}><span className="fk-icon"><Icon name="battery" size={18} /></span>
          <div><strong>{cycleAlerts.length}</strong><span>batterie(s) à ≥ {THRESHOLDS.batteryWarnPct} % des cycles</span></div></div>
        <div className={`fk${healthAlerts.length ? ' fk-danger' : ' fk-ok'}`}><span className="fk-icon"><Icon name="health" size={18} /></span>
          <div><strong>{healthAlerts.length}</strong><span>santé &lt; {THRESHOLDS.healthWarnPct} % (capacité réelle)</span></div></div>
        <div className={`fk${testsDue.length ? ' fk-warn' : ' fk-ok'}`}><span className="fk-icon"><Icon name="bolt" size={18} /></span>
          <div><strong>{testsDue.length}</strong><span>relevé(s) de capacité à faire (aucun ou &gt; {TEST_DUE_DAYS} j)</span></div></div>
        <div className="fk"><span className="fk-icon"><Icon name="clock" size={18} /></span>
          <div><strong>{nextEol ? fmtLife(nextEol.eol) : '—'}</strong><span>{nextEol ? `fin de vie la plus proche · ${batteryCode(nextEol.b)} (${nextEol.b.remaining_cycles} cycles restants)` : 'fin de vie : aucun vol récent'}</span></div></div>
      </div>

      <label className="check"><input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Afficher les éléments hors service</label>

      {packs.length === 0 ? <Empty>Aucun pack de batteries{isAdmin ? ' : créez le premier avec « Nouveau pack ».' : '.'}</Empty> : (
        <div className="bpacks">
          {packs.map((p) => {
            const bats = data.batteries.filter((b) => b.pack_id === p.id);
            const a = bats.find((x) => x.position === 'A'), b = bats.find((x) => x.position === 'B');
            const worst = Math.max(batteryLevel(p.max_cycle_pct ?? 0) === 'danger' ? 2 : batteryLevel(p.max_cycle_pct ?? 0) === 'warn' ? 1 : 0,
              healthLevel(p.min_health_pct) === 'danger' ? 2 : healthLevel(p.min_health_pct) === 'warn' ? 1 : 0);
            const dH = a?.health_pct != null && b?.health_pct != null ? Math.abs(Number(a.health_pct) - Number(b.health_pct)) : null;
            const dC = a && b ? Math.abs(a.total_cycles - b.total_cycles) : null;
            const unbalanced = (dH != null && dH > BALANCE_HEALTH_PTS) || (dC != null && dC > BALANCE_CYCLES);
            const packRate = Math.max(...bats.map((x) => rate(x.id)), 0);
            const packEol = bats.map((x) => endOfLife(x, rate(x.id))).filter(Boolean).sort((x, y) => x!.days - y!.days)[0] ?? null;
            const realPct = p.real_capacity_mah && p.nominal_capacity_mah ? (100 * p.real_capacity_mah) / p.nominal_capacity_mah : null;
            return (
              <section key={p.id} className={`bpack level-${['ok', 'warn', 'danger'][worst]}${p.status !== 'en_service' ? ' is-off' : ''}`}>
                <div className="bpack-head">
                  <div>
                    <span className="pd-kicker">Pack</span>
                    <div className="bpack-num">{p.pack_number}</div>
                  </div>
                  <div className="bpack-id">
                    <Badge level={statusLevel(p.status)}>{LABELS.batteryStatus[p.status]}</Badge>
                    <span className="small">⌂ {p.drone_port_name ?? <span className="text-warn">Non affecté</span>}</span>
                  </div>
                  <div className="bpack-cap">
                    <b>{realPct != null ? `${num(realPct, 0)} %` : '—'}</b>
                    <span>{p.real_capacity_mah ? `${num(p.real_capacity_mah / 1000, 1)} / ${num((p.nominal_capacity_mah ?? 0) / 1000, 0)} Ah` : 'capacité réelle inconnue'}</span>
                  </div>
                </div>

                {(['A', 'B'] as const).map((pos) => {
                  const x = pos === 'A' ? a : b;
                  return x
                    ? <PackBattery key={pos} b={x} perDay={rate(x.id)} onCapacity={() => setModal({ kind: 'capacity', battery: x })} />
                    : <div key={pos} className="pb-row pb-empty"><span className="bcell-ghost">{p.pack_number}{pos}</span><span className="muted small">Position {pos} libre</span></div>;
                })}

                <div className={`bpack-balance${unbalanced ? ' warn' : ''}`}>
                  <Icon name={unbalanced ? 'alert' : 'shield'} size={14} />
                  {a && b ? <span>Équilibre A/B : <b>{dH != null ? `Δ ${num(dH, 1)} pts de santé` : 'santé non comparée'}</b> · <b>Δ {dC} cycles</b>{unbalanced ? ' · à surveiller (montage en parallèle)' : ' · appairage correct'}</span>
                    : <span>Pack incomplet</span>}
                </div>

                <dl className="bpack-facts">
                  <div><dt>Rythme</dt><dd>{packRate > 0 ? `${num(packRate * 7, 1)} vols/sem.` : 'aucun vol (30 j)'}</dd></div>
                  <div><dt>Fin de vie (cycles)</dt><dd>{fmtLife(packEol)}</dd></div>
                  <div><dt>Dernier vol</dt><dd>{date(p.last_used_on)}</dd></div>
                </dl>

                {isAdmin && (
                  <div className="bpack-actions">
                    <button className="btn btn-sm" onClick={() => setModal({ kind: 'transfer', target: { kind: 'pack', id: p.id, label: `le pack ${p.pack_number}`, portId: p.drone_port_id } })}>⇄ Transférer</button>
                    <button className="btn btn-sm btn-ghost" onClick={() => setModal({ kind: 'pack', pack: p })}>Modifier</button>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {loose.length > 0 && (
        <section className="card">
          <div className="bloose-head">
            <h2 className="card-title">Batteries hors pack</h2>
            <span className="small muted">réserve, en attente d'appairage ou retirées</span>
          </div>
          <div className="bloose">
            {loose.map((b) => (
              <div key={b.id} className="bloose-item">
                <BatteryCell b={b} size="sm" />
                <div className="bloose-main">
                  <Link to={`/batteries/${b.id}`} className="pb-sn">{b.serial_number ?? 'sans n° de série'}</Link>
                  <span className="small muted">{b.drone_port_name ?? '—'} · {num(b.capacity_mah / 1000, 0)} Ah · <span className={`text-${batteryLevel(b.cycle_pct)}`}>{b.total_cycles}/{b.max_cycles} cycles</span></span>
                  <Badge level={statusLevel(b.status)}>{LABELS.batteryStatus[b.status]}</Badge>
                </div>
                <div className="bloose-actions">
                  <button className="btn btn-sm" onClick={() => setModal({ kind: 'capacity', battery: b })}>Relevé</button>
                  {isAdmin && <>
                    <button className="btn btn-ghost btn-sm" onClick={() => setModal({ kind: 'battery', battery: b })}>Modifier</button>
                    <button className="btn btn-ghost btn-sm" title="Transférer" onClick={() => setModal({ kind: 'transfer', target: { kind: 'battery', id: b.id, label: batteryCode(b), portId: b.drone_port_id } })}>⇄</button>
                  </>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <h2 className="card-title">Derniers transferts entre drone ports</h2>
        {transferGroups.length === 0 ? <Empty>Aucun transfert enregistré.</Empty> : (
          <ol className="btransfers">
            {transferGroups.map((t) => (
              <li key={t.id}>
                <span className="bt-date">{date(t.transfer_date)}</span>
                <span className="bt-what">{t.pack_number ? <><strong>Pack {t.pack_number}</strong> <span className="muted small">{t.items.join(', ')}</span></> : <strong>{t.serial_number ?? 'batterie sans n°'}</strong>}</span>
                <span className="bt-route">{t.from_port_name ?? 'Non affecté'} <b>→</b> {t.to_port_name ?? 'Non affecté'}</span>
                <span className="bt-note muted small">{t.notes ?? ''}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {modal?.kind === 'pack' && <PackModal pack={modal.pack} nextNumber={nextNumber} onClose={close} onSaved={saved} />}
      {modal?.kind === 'battery' && <BatteryModal battery={modal.battery} packs={data.allPacks} onClose={close} onSaved={saved} />}
      {modal?.kind === 'capacity' && <CapacityModal battery={modal.battery} onClose={close} onSaved={saved} />}
      {modal?.kind === 'transfer' && <TransferModal target={modal.target} onClose={close} onSaved={saved} />}
    </div>
  );
}
