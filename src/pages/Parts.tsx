import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { fetchAll, supabase, unwrap } from '../lib/supabase';
import { byPort, useApp } from '../lib/app';
import { useData } from '../lib/useData';
import type { Drone, DroneSlot, PartEventRow, PartRow, PartType, StockThreshold } from '../lib/types';
import { hours, num } from '../lib/format';
import { compatibleTypes, dateTime, PART_EVENT, PART_STATUS, potentialLevel, POTENTIAL_WARN_PCT, remainingCycles, remainingHours, zoneLabel } from '../lib/parts';
import { addDays, daysBetween, download, iso, parseIso, toCsv } from '../lib/stats';
import { FORECAST_WINDOW_DAYS, projection } from '../lib/dashboard';
import { Badge, Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { Icon, IconName } from '../components/icons';
import DroneView, { summarizeZones } from '../components/DroneView';
import {
  CreatePartsModal, MountModal, PotentialBar, ReplaceModal, StatusModal, TransferPartModal, UnmountModal,
} from '../components/PartModals';

type Tab = 'synthese' | 'drone' | 'inventaire' | 'stock' | 'quarantaine' | 'historique' | 'types';

type ModalState =
  | { kind: 'mount'; slot: DroneSlot | null; zone: string; typeCode: string; droneId?: string }
  | { kind: 'unmount'; part: PartRow; to: 'stock' | 'quarantaine' }
  | { kind: 'replace'; part: PartRow }
  | { kind: 'status'; part: PartRow; to: 'stock' | 'quarantaine' | 'rebut' }
  | { kind: 'transfer'; part: PartRow }
  | { kind: 'create'; type?: string };

/** Horizon de l'échéancier et du plan d'approvisionnement */
const HORIZON_DAYS = 90;
const SOON_DAYS = 30;

/** Échéance d'une pièce montée : heures restantes et date estimée au rythme du drone */
/** rest : reste en heures ou en cycles (selon le potentiel qui arrive en premier) */
interface Due { part: PartRow; rest: number; perDay: number; days: number | null; date: string | null }

const fmtDay = (s: string) => parseIso(s).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });

export default function Parts() {
  const { portFilter, ports, isAdmin } = useApp();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('onglet') as Tab) || 'synthese';
  const setTab = (t: Tab) => { const p = new URLSearchParams(params); p.set('onglet', t); setParams(p, { replace: true }); };
  const [modal, setModal] = useState<ModalState | null>(null);
  const [created, setCreated] = useState<string[] | null>(null);
  // ancien lien « ?scan=1 » : le scan se fait désormais dans le mode atelier
  const legacyScan = params.get('scan') === '1';

  const { data, error, loading, reload } = useData(async () => {
    const since = addDays(iso(new Date()), -(FORECAST_WINDOW_DAYS - 1));
    const [types, slots, drones, parts, thresholds, flights] = await Promise.all([
      supabase.from('part_types').select('*').order('sort'),
      supabase.from('drone_slots').select('*'),
      byPort(supabase.from('drones').select('*'), portFilter).order('code'),
      fetchAll<PartRow>((a, b) => byPort(supabase.from('v_parts').select('*'), portFilter).neq('status', 'rebut').order('code').range(a, b)),
      byPort(supabase.from('part_stock_thresholds').select('*'), portFilter),
      byPort(supabase.from('v_flights').select('drone_id, duration_min'), portFilter).gte('flight_date', since).limit(5000),
    ]);
    return {
      types: unwrap(types) as PartType[], slots: unwrap(slots) as DroneSlot[], drones: unwrap(drones) as Drone[],
      parts, thresholds: unwrap(thresholds) as StockThreshold[], flights: (unwrap(flights) ?? []) as { drone_id: string; duration_min: number | null }[],
    };
  }, [portFilter]);

  const close = () => setModal(null);
  const done = () => { setModal(null); reload(); };

  // ---- alertes globales et échéances
  const alerts = useMemo(() => {
    if (!data) return null;
    const mounted = data.parts.filter((p) => p.status === 'monte');
    const over = mounted.filter((p) => potentialLevel(p) === 'danger');
    const near = mounted.filter((p) => potentialLevel(p) === 'warn');
    const undefinedPot = mounted.filter((p) => potentialLevel(p) === 'unknown');
    const quarantine = data.parts.filter((p) => p.status === 'quarantaine');
    const stockOf = (port: string | null, type: string) => data.parts.filter((p) => p.status === 'stock' && p.type_code === type && p.drone_port_id === port).length;
    const lowStock = data.thresholds.filter((t) => t.min_qty > 0 && stockOf(t.drone_port_id, t.type_code) < t.min_qty);
    const totalSlots = data.drones.reduce((n, d) => n + data.slots.filter((s) => s.model === d.model).length, 0);
    const emptySlots = data.drones.reduce((n, d) => n + data.slots.filter((s) => s.model === d.model &&
      !mounted.some((p) => p.drone_id === d.id && p.slot === s.code)).length, 0);
    // rythme de vol de chaque drone (h/jour sur 30 jours)
    const perDay = new Map<string, number>();
    const cyclesPerDay = new Map<string, number>(); // 1 vol = 1 cycle
    for (const f of data.flights) {
      perDay.set(f.drone_id, (perDay.get(f.drone_id) ?? 0) + Number(f.duration_min ?? 0) / 60 / FORECAST_WINDOW_DAYS);
      cyclesPerDay.set(f.drone_id, (cyclesPerDay.get(f.drone_id) ?? 0) + 1 / FORECAST_WINDOW_DAYS);
    }
    // échéance = la plus proche entre le potentiel en heures et celui en cycles
    const dues: Due[] = mounted.filter((p) => p.max_hours_effective != null || p.max_cycles_effective != null).map((p) => {
      const byHours = p.max_hours_effective == null ? null : (() => {
        const rest = remainingHours(p)!, pd = perDay.get(p.drone_id!) ?? 0, proj = projection(rest, pd);
        return { part: p, rest, perDay: pd, days: proj?.days ?? null, date: proj?.date ?? null };
      })();
      const byCycles = p.max_cycles_effective == null ? null : (() => {
        const rest = remainingCycles(p)!, pd = cyclesPerDay.get(p.drone_id!) ?? 0, proj = projection(rest, pd);
        return { part: p, rest, perDay: pd, days: proj?.days ?? null, date: proj?.date ?? null };
      })();
      if (!byHours || !byCycles) return (byHours ?? byCycles)!;
      if (byCycles.rest <= 0) return byCycles;
      if (byHours.rest <= 0) return byHours;
      return (byCycles.days ?? 1e9) < (byHours.days ?? 1e9) ? byCycles : byHours;
    }).sort((a, b) => (a.days ?? 1e9) - (b.days ?? 1e9) || a.rest - b.rest);
    const dueById = new Map(dues.map((d) => [d.part.id, d]));
    const soon = dues.filter((d) => d.days != null && d.days > 0 && d.days <= SOON_DAYS);
    return { mounted, over, near, undefinedPot, quarantine, lowStock, emptySlots, totalSlots, dues, dueById, soon, stockOf };
  }, [data]);

  if (legacyScan) return <Navigate to="/scan" replace />;
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data || !alerts) return null;

  const typeName = (code: string) => data.types.find((t) => t.code === code)?.name ?? code;
  // pièces montables : le type de l'emplacement et les types interchangeables (servo d'aileron <-> gouverne)
  const stockCandidates = (typeCode: string, portId: string | null) => {
    const ok = compatibleTypes(data.types, typeCode);
    return data.parts.filter((p) => p.status === 'stock' && ok.includes(p.type_code) && p.drone_port_id === portId);
  };
  const equipPct = alerts.totalSlots ? Math.round(((alerts.totalSlots - alerts.emptySlots) / alerts.totalSlots) * 100) : 0;
  const nStock = data.parts.filter((p) => p.status === 'stock').length;

  const tabs: { key: Tab; label: string; icon: IconName; count?: number; level?: 'warn' | 'danger' }[] = [
    { key: 'synthese', label: 'Synthèse', icon: 'dashboard', count: (alerts.over.length + alerts.soon.length) || undefined, level: alerts.over.length ? 'danger' : 'warn' },
    { key: 'drone', label: 'Vue drone', icon: 'drone' },
    { key: 'inventaire', label: 'Inventaire', icon: 'search', count: data.parts.length },
    { key: 'stock', label: 'Stock', icon: 'box', count: alerts.lowStock.length || undefined, level: 'warn' },
    { key: 'quarantaine', label: 'Quarantaine', icon: 'alert', count: alerts.quarantine.length || undefined, level: 'warn' },
    { key: 'historique', label: 'Mouvements', icon: 'clock' },
    { key: 'types', label: 'Types & potentiels', icon: 'wrench' },
  ];

  return (
    <div className="parts-page">
      <PageHeader title="Pièces & stock" subtitle="Potentiel de chaque pièce, configuration des drones, stock de rechange et approvisionnement"
        actions={<>
          <Link className="btn" to="/scan"><Icon name="scan" size={16} /> Mode atelier</Link>
          <button className="btn btn-primary" onClick={() => setModal({ kind: 'create' })}>+ Entrée en stock</button>
        </>} />

      {created && (
        <div className="alert alert-ok">
          ✓ {created.length} pièce(s) créée(s) : <strong>{created.join(', ')}</strong>
          <Link className="btn btn-sm" to={`/pieces/etiquettes?codes=${created.join(',')}`} style={{ marginLeft: 8 }}>⎙ Imprimer les étiquettes QR</Link>
          <button className="btn btn-ghost btn-sm" onClick={() => setCreated(null)} style={{ marginLeft: 8 }}>OK</button>
        </div>
      )}

      <div className="flight-kpis parts-kpis">
        <button type="button" className={`fk fk-action${alerts.over.length ? ' fk-danger' : ' fk-ok'}`} onClick={() => setTab('synthese')}>
          <span className="fk-icon"><Icon name="alert" size={18} /></span>
          <div><strong>{alerts.over.length}</strong><span>{alerts.over.length ? 'potentiel dépassé · à remplacer' : 'aucun potentiel dépassé'}</span></div></button>
        <button type="button" className={`fk fk-action${alerts.soon.length || alerts.near.length ? ' fk-warn' : ''}`} onClick={() => setTab('synthese')}>
          <span className="fk-icon"><Icon name="clock" size={18} /></span>
          <div><strong>{alerts.soon.length}</strong><span>échéance sous {SOON_DAYS} jours{alerts.near.length ? ` · ${alerts.near.length} ≥ ${POTENTIAL_WARN_PCT} %` : ''}</span></div></button>
        <button type="button" className={`fk fk-action${alerts.lowStock.length ? ' fk-warn' : ' fk-ok'}`} onClick={() => setTab('stock')}>
          <span className="fk-icon"><Icon name="box" size={18} /></span>
          <div><strong>{alerts.lowStock.length}</strong><span>type(s) sous le minimum · {nStock} en stock</span></div></button>
        <button type="button" className={`fk fk-action${alerts.quarantine.length ? ' fk-warn' : ' fk-ok'}`} onClick={() => setTab('quarantaine')}>
          <span className="fk-icon"><Icon name="shield" size={18} /></span>
          <div><strong>{alerts.quarantine.length}</strong><span>{alerts.quarantine.length ? 'en quarantaine · décision à prendre' : 'aucune quarantaine'}</span></div></button>
        <button type="button" className={`fk fk-action${alerts.emptySlots ? ' fk-warn' : ' fk-ok'}`} onClick={() => setTab('drone')}>
          <span className="fk-icon"><Icon name="drone" size={18} /></span>
          <div><strong>{equipPct} %</strong><span>équipement · {alerts.emptySlots} emplacement(s) vide(s)</span></div></button>
        <button type="button" className="fk fk-action" onClick={() => setTab('inventaire')}>
          <span className="fk-icon"><Icon name="chip" size={18} /></span>
          <div><strong>{data.parts.length}</strong><span>pièces suivies · {alerts.mounted.length} montées</span></div></button>
      </div>

      {alerts.undefinedPot.length > 0 && (
        <div className="alert alert-warn">
          {alerts.undefinedPot.length} pièce(s) montée(s) n'ont pas de potentiel défini : aucune alerte ni prévision n'est possible pour elles.{' '}
          {isAdmin ? <button className="btn btn-ghost btn-sm" onClick={() => setTab('types')}>Définir les potentiels →</button> : 'Demandez à un administrateur de définir les potentiels.'}
        </div>
      )}

      <div className="tabs parts-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={`tab${tab === t.key ? ' active' : ''}`} onClick={() => setTab(t.key)}>
            <Icon name={t.icon} size={15} /> {t.label}{t.count != null && <Badge level={t.level ?? 'neutral'}>{t.count}</Badge>}
          </button>
        ))}
      </div>

      {tab === 'synthese' && <SynthesisTab data={data} alerts={alerts} ports={portFilter ? ports.filter((p) => p.id === portFilter) : ports}
        stockCandidates={stockCandidates} setModal={setModal} openDrone={(id) => { const p = new URLSearchParams(params); p.set('onglet', 'drone'); p.set('drone', id); setParams(p, { replace: true }); }} />}
      {tab === 'drone' && <DroneTab data={data} dueById={alerts.dueById} stockCandidates={stockCandidates} setModal={setModal} params={params} setParams={setParams} />}
      {tab === 'inventaire' && <InventoryTab parts={data.parts} types={data.types} showPort={!portFilter} />}
      {tab === 'stock' && <StockTab data={data} ports={portFilter ? ports.filter((p) => p.id === portFilter) : ports} onChanged={reload} onCreate={(type) => setModal({ kind: 'create', type })} />}
      {tab === 'quarantaine' && <QuarantineTab parts={alerts.quarantine} setModal={setModal} />}
      {tab === 'historique' && <HistoryTab portFilter={portFilter} />}
      {tab === 'types' && <TypesTab types={data.types} parts={data.parts} isAdmin={isAdmin} onChanged={reload} />}

      {modal?.kind === 'create' && <CreatePartsModal types={data.types} defaultType={modal.type} onClose={close}
        onDone={(codes) => { setModal(null); setCreated(codes); reload(); }} />}
      {modal?.kind === 'unmount' && <UnmountModal part={modal.part} defaultTo={modal.to} onClose={close} onDone={done} />}
      {modal?.kind === 'replace' && <ReplaceModal part={modal.part} candidates={stockCandidates(modal.part.type_code, modal.part.drone_port_id)} onClose={close} onDone={done} />}
      {modal?.kind === 'status' && <StatusModal part={modal.part} to={modal.to} onClose={close} onDone={done} />}
      {modal?.kind === 'transfer' && <TransferPartModal part={modal.part} onClose={close} onDone={done} />}
      {modal?.kind === 'mount' && (() => {
        const droneId = modal.droneId ?? params.get('drone') ?? data.drones[0]?.id;
        const drone = data.drones.find((d) => d.id === droneId)!;
        return <MountModal droneId={drone.id} droneCode={drone.code} slot={modal.slot?.code ?? null} slotLabel={modal.slot?.label ?? `${typeName(modal.typeCode)} – ${zoneLabel(modal.zone)}`}
          zone={modal.zone} typeName={typeName(modal.typeCode)} slotType={modal.typeCode} candidates={stockCandidates(modal.typeCode, drone.drone_port_id)} onClose={close} onDone={done} />;
      })()}
    </div>
  );
}

type Data = { types: PartType[]; slots: DroneSlot[]; drones: Drone[]; parts: PartRow[]; thresholds: StockThreshold[] };
/** Alertes et échéances calculées dans Parts */
interface Alerts {
  mounted: PartRow[]; over: PartRow[]; near: PartRow[]; quarantine: PartRow[]; lowStock: StockThreshold[];
  emptySlots: number; totalSlots: number; dues: Due[]; dueById: Map<string, Due>; soon: Due[]; stockOf: (port: string | null, type: string) => number;
}

/** Libellé d'échéance : « dépassé », « J-12 », « ≈ 3 mois » ou « pas de vol récent » */
function dueLabel(d: Due | undefined) {
  if (!d) return null;
  if (d.rest <= 0) return { text: 'dépassé', level: 'danger' as const };
  if (d.days == null) return { text: 'pas de vol récent', level: 'neutral' as const };
  if (d.days <= SOON_DAYS) return { text: `J-${d.days}`, level: (d.days <= 7 ? 'danger' : 'warn') as 'danger' | 'warn' };
  if (d.days <= 365) return { text: d.days < 60 ? `≈ ${d.days} j` : `≈ ${Math.round(d.days / 30)} mois`, level: 'ok' as const };
  return { text: '> 1 an', level: 'ok' as const };
}

// =====================================================================
// Synthèse : échéancier des remplacements, santé des drones, approvisionnement
// =====================================================================
function SynthesisTab({ data, alerts, ports, stockCandidates, setModal, openDrone }: {
  data: Data; alerts: Alerts; ports: { id: string; name: string }[];
  stockCandidates: (t: string, p: string | null) => PartRow[]; setModal: (m: ModalState) => void; openDrone: (id: string) => void;
}) {
  const todayIso = iso(new Date());
  const horizon = alerts.dues.filter((d) => d.rest <= 0 || (d.days != null && d.days <= HORIZON_DAYS));
  const buckets: { key: string; label: string; hint: string; level: 'danger' | 'warn' | 'ok'; items: Due[] }[] = [
    { key: 'now', label: 'Maintenant', hint: 'potentiel atteint ou dépassé', level: 'danger', items: horizon.filter((d) => d.rest <= 0) },
    { key: '30', label: `Sous ${SOON_DAYS} jours`, hint: 'à préparer', level: 'warn', items: horizon.filter((d) => d.rest > 0 && d.days! <= SOON_DAYS) },
    { key: '90', label: `${SOON_DAYS} à ${HORIZON_DAYS} jours`, hint: 'à anticiper', level: 'ok', items: horizon.filter((d) => d.rest > 0 && d.days! > SOON_DAYS) },
  ];

  // ---- plan d'approvisionnement à 90 jours
  const supply = ports.flatMap((port) => data.types.filter((t) => t.active).map((t) => {
    const need = horizon.filter((d) => d.part.drone_port_id === port.id && d.part.type_code === t.code).length;
    const min = data.thresholds.find((x) => x.drone_port_id === port.id && x.type_code === t.code)?.min_qty ?? 0;
    const stock = alerts.stockOf(port.id, t.code);
    const order = Math.max(0, need + min - stock);
    return { port, type: t, need, min, stock, order };
  })).filter((r) => r.order > 0 || r.need > 0).sort((a, b) => b.order - a.order || b.need - a.need);
  const toOrder = supply.reduce((n, r) => n + r.order, 0);

  function exportOrder() {
    download(`commande_pieces_${todayIso}.csv`, toCsv(supply.filter((r) => r.order > 0).map((r) => ({
      drone_port: r.port.name, code: r.type.code, piece: r.type.name, categorie: r.type.category,
      besoin_90j: r.need, minimum: r.min, en_stock: r.stock, a_commander: r.order,
    }))));
  }

  // ---- timeline 0 → 90 j
  const pos = (days: number) => Math.min(100, Math.max(0, (days / HORIZON_DAYS) * 100));

  return (
    <div className="pk-synth">
      <section className="card pk-due">
        <div className="pk-head">
          <div>
            <h2>Échéancier des remplacements</h2>
            <p>Pièces montées qui atteindront leur potentiel dans les {HORIZON_DAYS} prochains jours, au rythme de vol réel de chaque drone ({FORECAST_WINDOW_DAYS} derniers jours).</p>
          </div>
          <span className="pk-count">{horizon.length}<small>pièce(s)</small></span>
        </div>

        <div className="pk-timeline" aria-hidden>
          <div className="pk-tl-axis">
            {[0, 15, 30, 45, 60, 75, 90].map((dd) => <span key={dd} className={dd % 30 ? 'minor' : ''} style={{ left: `${pos(dd)}%` }}>{dd === 0 ? "aujourd'hui" : `J+${dd}`}</span>)}
          </div>
          <div className="pk-tl-track">
            <i className="pk-tl-soon" style={{ width: `${pos(SOON_DAYS)}%` }} />
            {horizon.map((d) => (
              <span key={d.part.id} className={`pk-tl-dot lv-${d.rest <= 0 ? 'danger' : d.days! <= SOON_DAYS ? 'warn' : 'ok'}`}
                style={{ left: `${pos(d.rest <= 0 ? 0 : d.days!)}%` }} title={`${d.part.code} · ${d.part.drone_code} · ${d.part.slot_label ?? ''}`} />
            ))}
          </div>
        </div>

        {horizon.length === 0 ? <div className="pk-empty"><Icon name="shield" size={22} /> Aucun remplacement prévu dans les {HORIZON_DAYS} prochains jours.</div> : (
          <div className="pk-buckets">
            {buckets.filter((b) => b.items.length).map((b) => (
              <div key={b.key} className={`pk-bucket lv-${b.level}`}>
                <div className="pk-bucket-head"><strong>{b.label}</strong><span>{b.items.length} · {b.hint}</span></div>
                <ul>
                  {b.items.map((d) => {
                    const p = d.part;
                    const cand = stockCandidates(p.type_code, p.drone_port_id).length;
                    const lbl = dueLabel(d)!;
                    return (
                      <li key={p.id} className="pk-due-item">
                        <span className={`pk-when lv-${lbl.level}`}>{lbl.text}{d.date && d.rest > 0 && <small>{fmtDay(d.date)}</small>}</span>
                        <div className="pk-due-main">
                          <div className="pk-due-title"><Link to={`/pieces/${p.id}`}><strong>{p.code}</strong></Link> <span>{p.type_name}</span></div>
                          <div className="pk-due-where"><Icon name="drone" size={12} /> {p.drone_code} · {p.slot_label ?? zoneLabel(p.zone)}</div>
                          <PotentialBar part={p} compact />
                        </div>
                        <div className="pk-due-side">
                          <span className={`pk-stock ${cand ? 'ok' : 'ko'}`}>{cand ? `${cand} en stock` : 'aucun en stock'}</span>
                          <button className={`btn btn-sm${d.rest <= 0 && cand ? ' btn-primary' : ''}`} disabled={!cand} onClick={() => setModal({ kind: 'replace', part: p })}
                            title={cand ? 'Remplacer par une pièce du stock' : 'Aucune pièce de ce type en stock dans ce drone port'}>⇆ Remplacer</button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="pk-side">
        <section className="card pk-fleet">
          <h2>Santé par drone</h2>
          {data.drones.map((dr) => {
            const slots = data.slots.filter((s) => s.model === dr.model);
            const mounted = alerts.mounted.filter((p) => p.drone_id === dr.id);
            const filled = slots.filter((s) => mounted.some((p) => p.slot === s.code)).length;
            const pct = slots.length ? filled / slots.length : 0;
            const over = mounted.filter((p) => potentialLevel(p) === 'danger').length;
            const near = mounted.filter((p) => potentialLevel(p) === 'warn').length;
            const next = alerts.dues.find((d) => d.part.drone_id === dr.id && d.rest > 0 && d.days != null);
            const C = 2 * Math.PI * 22;
            const lvl = over ? 'danger' : near || pct < 1 ? 'warn' : 'ok';
            return (
              <button key={dr.id} type="button" className={`pk-drone lv-${lvl}`} onClick={() => openDrone(dr.id)}>
                <svg viewBox="0 0 56 56" className="pk-ring" aria-hidden>
                  <circle cx="28" cy="28" r="22" className="r-track" />
                  <circle cx="28" cy="28" r="22" className="r-val" strokeDasharray={`${C * pct} ${C}`} transform="rotate(-90 28 28)" />
                  <text x="28" y="32" textAnchor="middle">{Math.round(pct * 100)}%</text>
                </svg>
                <div className="pk-drone-body">
                  <strong>{dr.code}</strong>
                  <span>{filled}/{slots.length} emplacements · {mounted.length} pièce(s)</span>
                  <span className="pk-drone-tags">
                    {over > 0 && <em className="t-danger">{over} dépassé(s)</em>}
                    {near > 0 && <em className="t-warn">{near} ≥ {POTENTIAL_WARN_PCT} %</em>}
                    {!over && !near && <em className="t-ok">potentiels OK</em>}
                  </span>
                  {next && <span className="pk-drone-next">Prochaine échéance : <b>{next.part.code}</b> {dueLabel(next)!.text}</span>}
                </div>
                <Icon name="chevronRight" size={16} />
              </button>
            );
          })}
        </section>

        <section className="card pk-supply">
          <div className="pk-head">
            <div>
              <h2>Plan d'approvisionnement</h2>
              <p>Besoins à {HORIZON_DAYS} jours + stock minimum − stock disponible.</p>
            </div>
            <button className="btn btn-sm" onClick={exportOrder} disabled={!toOrder}>⇩ Bon de commande</button>
          </div>
          {supply.length === 0 ? <div className="pk-empty"><Icon name="box" size={20} /> Stock suffisant pour les {HORIZON_DAYS} prochains jours.</div> : (
            <>
              <div className="pk-order-total"><strong>{toOrder}</strong> pièce(s) à commander</div>
              <ul className="pk-supply-list">
                {supply.map((r) => (
                  <li key={`${r.port.id}-${r.type.code}`} className={r.order ? 'is-order' : ''}>
                    <span className="pk-code">{r.type.code}</span>
                    <div><strong>{r.type.name}</strong><span>{ports.length > 1 ? `${r.port.name} · ` : ''}besoin {r.need} · min {r.min} · stock {r.stock}</span></div>
                    <b className={r.order ? 'to-order' : 'covered'}>{r.order ? `+${r.order}` : '✓'}</b>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

// =====================================================================
// Vue drone (photo interactive)
// =====================================================================
function DroneTab({ data, dueById, stockCandidates, setModal, params, setParams }: {
  data: Data; dueById: Map<string, Due>; stockCandidates: (t: string, p: string | null) => PartRow[]; setModal: (m: ModalState) => void;
  params: URLSearchParams; setParams: (p: URLSearchParams, o?: { replace?: boolean }) => void;
}) {
  const droneId = params.get('drone') ?? data.drones[0]?.id;
  const zone = params.get('zone') ?? 'vtol_avg';
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); p.set(k, v); setParams(p, { replace: true }); };
  const drone = data.drones.find((d) => d.id === droneId);
  if (!drone) return <Empty>Aucun drone dans ce drone port.</Empty>;

  const slots = data.slots.filter((s) => s.model === drone.model);
  const mounted = data.parts.filter((p) => p.status === 'monte' && p.drone_id === drone.id);
  const zones = summarizeZones(slots, mounted);
  const current = zones.find((z) => z.code === zone) ?? zones[0];
  const multiParts = mounted.filter((p) => p.zone === current.code && !p.slot);
  const multiTypes = data.types.filter((t) => t.multi && t.active);
  const totalSlots = slots.length, filled = zones.reduce((n, z) => n + z.filled, 0);
  const ZSTATE: Record<string, string> = { ok: 'Complet', warn: 'Potentiel ≥ 90 %', danger: 'Potentiel dépassé', empty: 'Incomplet' };

  return (
    <>
      <div className="pd-drones">
        {data.drones.map((d) => {
          const m = data.parts.filter((p) => p.status === 'monte' && p.drone_id === d.id);
          const s = data.slots.filter((x) => x.model === d.model);
          const f = s.filter((x) => m.some((p) => p.slot === x.code)).length;
          const bad = m.filter((p) => potentialLevel(p) === 'danger').length;
          const warn = m.filter((p) => potentialLevel(p) === 'warn').length;
          return (
            <button key={d.id} type="button" className={`pd-drone${d.id === drone.id ? ' active' : ''}`} onClick={() => set('drone', d.id)}>
              <strong>{d.code}</strong>
              <span className="pd-bar"><i style={{ width: `${s.length ? (f / s.length) * 100 : 0}%` }} /></span>
              <span className="pd-meta">{f}/{s.length}{bad > 0 && <em className="t-danger"> · ⚠ {bad}</em>}{warn > 0 && <em className="t-warn"> · {warn}</em>}</span>
            </button>
          );
        })}
        <span className="pd-summary small muted">{drone.model} · {filled}/{totalSlots} emplacements équipés · {mounted.length} pièce(s) montée(s)</span>
      </div>
      {slots.length === 0 && <div className="alert alert-warn">Aucun plan d'emplacements défini pour le modèle « {drone.model} ».</div>}

      <div className="parts-layout">
        <section className="card pd-view">
          <DroneView zones={zones} selected={current.code} onSelect={(c) => set('zone', c)} />
        </section>

        <section className="card pd-zone">
          <div className="pd-zone-head">
            <div><span className="pd-kicker">{drone.code} · zone</span><h2>{current.label}</h2></div>
            <span className={`pd-state zs-${current.state}`}>{ZSTATE[current.state]} · {current.filled}/{current.slots.length}</span>
          </div>
          {current.slots.map((s) => {
            const part = mounted.find((p) => p.slot === s.code);
            const candidates = stockCandidates(s.type_code, drone.drone_port_id);
            if (!part) {
              return (
                <div key={s.code} className="slot-card is-empty">
                  <div className="slot-card-head"><strong>{s.label}</strong><span className="slot-type">{s.type_code}</span></div>
                  <div className="slot-card-row">
                    <span className="text-warn small">○ Emplacement vide</span>
                    <button className={`btn btn-sm${candidates.length ? ' btn-primary' : ''}`} disabled={!candidates.length}
                      onClick={() => setModal({ kind: 'mount', slot: s, zone: s.zone, typeCode: s.type_code, droneId: drone.id })}>
                      ⤓ Monter · {candidates.length} en stock
                    </button>
                  </div>
                </div>
              );
            }
            const due = dueLabel(dueById.get(part.id));
            const lvl = potentialLevel(part);
            return (
              <div key={s.code} className={`slot-card lv-${lvl}`}>
                <div className="slot-card-head">
                  <strong>{s.label}</strong>
                  {due && <span className={`slot-due lv-${due.level}`}>{due.text}</span>}
                </div>
                <div className="slot-card-id">
                  <Link to={`/pieces/${part.id}`} className="slot-code">{part.code}</Link>
                  <span className="small muted">{part.serial_number ? `S/N ${part.serial_number} · ` : ''}depuis le {dateTime(part.installed_at).slice(0, 10)} · {part.flight_count} vol(s)</span>
                </div>
                <PotentialBar part={part} />
                <div className="slot-actions">
                  <button className="btn btn-sm" onClick={() => setModal({ kind: 'replace', part })}>⇆ Remplacer</button>
                  <button className="btn btn-sm" onClick={() => setModal({ kind: 'unmount', part, to: 'stock' })}>⤒ Démonter</button>
                  <button className="btn btn-sm btn-danger" onClick={() => setModal({ kind: 'unmount', part, to: 'quarantaine' })}>⚠ Défaillance</button>
                </div>
              </div>
            );
          })}

          <div className="slot-card is-multi">
            <div className="slot-card-head"><strong>Connecteurs & fils</strong><span className="small muted">{multiParts.length} monté(s)</span></div>
            {multiParts.map((p) => (
              <div key={p.id} className="slot-card-row small">
                <span><Link to={`/pieces/${p.id}`}><strong>{p.code}</strong></Link> · {p.type_name} · {hours(p.total_hours)}</span>
                <span className="slot-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => setModal({ kind: 'unmount', part: p, to: 'stock' })}>Démonter</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setModal({ kind: 'unmount', part: p, to: 'quarantaine' })}>Défaillance</button>
                </span>
              </div>
            ))}
            <div className="slot-actions">
              {multiTypes.map((t) => (
                <button key={t.code} className="btn btn-sm" onClick={() => setModal({ kind: 'mount', slot: null, zone: current.code, typeCode: t.code, droneId: drone.id })}>
                  + {t.name} ({stockCandidates(t.code, drone.drone_port_id).length})
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>

      <section className="card no-pad">
        <div className="table-summary row-between">
          <strong>Configuration complète de {drone.code}</strong>
          <span className="small muted">cliquez sur une zone pour l'afficher sur le drone</span>
        </div>
        <div className="table-wrap">
          <table className="config-table">
            <thead><tr><th>Emplacement</th><th>Pièce</th><th>N° de série</th><th>Montée le</th><th>Échéance</th><th style={{ minWidth: 200 }}>Heures / potentiel</th></tr></thead>
            <tbody>
              {zones.flatMap((z) => [
                <tr key={`z-${z.code}`} className={`zone-row${z.code === current.code ? ' is-current' : ''}`}>
                  <th colSpan={6}><button type="button" onClick={() => set('zone', z.code)}>
                    <i className={`zone-dot zone-${z.state}`} /> {z.label} <span className="muted">· {z.filled}/{z.slots.length}</span></button></th>
                </tr>,
                ...z.slots.map((s) => {
                  const p = mounted.find((x) => x.slot === s.code);
                  const due = p ? dueLabel(dueById.get(p.id)) : null;
                  return (
                    <tr key={s.code} className={p ? '' : 'row-muted'}>
                      <td>{s.label}</td>
                      <td>{p ? <Link to={`/pieces/${p.id}`}><strong>{p.code}</strong></Link> : <span className="text-warn">vide</span>}</td>
                      <td>{p?.serial_number ?? '—'}</td>
                      <td>{p ? dateTime(p.installed_at).slice(0, 10) : '—'}</td>
                      <td>{due ? <span className={`slot-due lv-${due.level}`}>{due.text}</span> : '—'}</td>
                      <td>{p ? <PotentialBar part={p} compact /> : '—'}</td>
                    </tr>
                  );
                }),
                ...mounted.filter((p) => p.zone === z.code && !p.slot).map((p) => (
                  <tr key={p.id}>
                    <td>{p.type_name}</td>
                    <td><Link to={`/pieces/${p.id}`}><strong>{p.code}</strong></Link></td>
                    <td>{p.serial_number ?? '—'}</td><td>{dateTime(p.installed_at).slice(0, 10)}</td><td>—</td><td><PotentialBar part={p} compact /></td>
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

// =====================================================================
// Inventaire
// =====================================================================
function InventoryTab({ parts, types, showPort }: { parts: PartRow[]; types: PartType[]; showPort: boolean }) {
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [type, setType] = useState('');
  const [alert, setAlert] = useState('');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const navigate = useNavigate();
  const categories = Array.from(new Set(types.map((t) => t.category)));
  const rows = parts.filter((p) =>
    (!status || p.status === status) && (!category || p.category === category) && (!type || p.type_code === type) &&
    (!alert || (alert === 'unknown' ? potentialLevel(p) === 'unknown' : ['warn', 'danger'].includes(potentialLevel(p)))) &&
    (!q || `${p.code} ${p.legacy_code ?? ''} ${p.serial_number ?? ''} ${p.manufacturer ?? ''} ${p.drone_code ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  const picked = rows.filter((p) => sel.has(p.id));
  const allPicked = rows.length > 0 && picked.length === rows.length;
  const count = (s: string) => parts.filter((p) => p.status === s).length;
  return (
    <>
      <div className="inv-status" role="tablist" aria-label="Statut">
        {([['', 'Toutes', parts.length], ['monte', 'Montées', count('monte')], ['stock', 'En stock', count('stock')], ['quarantaine', 'Quarantaine', count('quarantaine')]] as const).map(([k, l, n]) => (
          <button key={k} type="button" role="tab" aria-selected={status === k} className={`inv-chip st-${k || 'all'}${status === k ? ' active' : ''}`} onClick={() => setStatus(k)}>
            <b>{n}</b> {l}
          </button>
        ))}
      </div>
      <div className="card filters">
        <label className="field"><span className="field-label">Catégorie</span>
          <select value={category} onChange={(e) => { setCategory(e.target.value); setType(''); }}>
            <option value="">Toutes</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="field"><span className="field-label">Sous-catégorie</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Toutes</option>
            {types.filter((t) => !category || t.category === category).map((t) => <option key={t.code} value={t.code}>{t.code} · {t.name}</option>)}
          </select>
        </label>
        <label className="field"><span className="field-label">Potentiel</span>
          <select value={alert} onChange={(e) => setAlert(e.target.value)}>
            <option value="">Tous</option>
            <option value="alert">≥ {POTENTIAL_WARN_PCT} % ou dépassé</option>
            <option value="unknown">Potentiel non défini</option>
          </select>
        </label>
        <label className="field field-grow"><span className="field-label">Recherche</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Code (nouveau ou ancien), n° de série, fabricant, drone…" />
        </label>
      </div>
      {rows.length === 0 ? <Empty>Aucune pièce.</Empty> : (
        <div className="card no-pad">
          <div className="table-summary row-between">
            <span className="small muted">{rows.length} pièce(s){picked.length ? ` · ${picked.length} sélectionnée(s)` : ''}</span>
            <button className="btn btn-sm" onClick={() => navigate(`/pieces/etiquettes?ids=${(picked.length ? picked : rows).map((p) => p.id).join(',')}`)}>
              ⎙ Étiquettes QR ({picked.length || rows.length})
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th className="col-check"><input type="checkbox" aria-label="Tout sélectionner" checked={allPicked}
                  onChange={() => setSel(allPicked ? new Set() : new Set(rows.map((p) => p.id)))} /></th>
                <th>Code</th><th>Type</th><th>N° de série</th><th>Statut</th><th>Emplacement</th>{showPort && <th>Drone port</th>}<th style={{ minWidth: 200 }}>Heures / potentiel</th></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td className="col-check"><input type="checkbox" aria-label={`Sélectionner ${p.code}`} checked={sel.has(p.id)}
                      onChange={() => { const s = new Set(sel); if (s.has(p.id)) s.delete(p.id); else s.add(p.id); setSel(s); }} /></td>
                    <td><Link to={`/pieces/${p.id}`}><strong>{p.code}</strong></Link>{p.legacy_code && <div className="small muted mono" title="Ancien code">ex-{p.legacy_code}</div>}</td>
                    <td>{p.type_name}<div className="small muted">{p.category}</div></td>
                    <td>{p.serial_number ?? '—'}</td>
                    <td><Badge level={PART_STATUS[p.status].level}>{PART_STATUS[p.status].label}</Badge></td>
                    <td>{p.status === 'monte' ? <>{p.drone_code} · {p.slot_label ?? zoneLabel(p.zone)}</> : <span className="muted">—</span>}</td>
                    {showPort && <td>{p.drone_port_name ?? '—'}</td>}
                    <td><PotentialBar part={p} compact /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

// =====================================================================
// Stock par drone port (tuiles avec seuils minimum)
// =====================================================================
function StockTab({ data, ports, onChanged, onCreate }: { data: Data; ports: { id: string; name: string }[]; onChanged: () => void; onCreate: (type: string) => void }) {
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [only, setOnly] = useState<'tout' | 'alertes' | 'suivis'>('tout');
  const count = (portId: string, type: string, status: string) =>
    data.parts.filter((p) => p.drone_port_id === portId && p.type_code === type && p.status === status).length;
  const minOf = (portId: string, type: string) => data.thresholds.find((t) => t.drone_port_id === portId && t.type_code === type)?.min_qty ?? 0;

  async function saveMin(portId: string, type: string) {
    const key = `${portId}|${type}`;
    const v = edit[key];
    if (v == null) return;
    setError(null);
    try {
      const n = Math.max(0, Math.round(Number(v) || 0));
      unwrap(await supabase.from('part_stock_thresholds').upsert({ drone_port_id: portId, type_code: type, min_qty: n }).select());
      setEdit((e) => { const c = { ...e }; delete c[key]; return c; });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!ports.length) return <Empty>Aucun drone port.</Empty>;
  const categories = Array.from(new Set(data.types.filter((t) => t.active).map((t) => t.category)));
  return (
    <>
      <ErrorBox error={error} />
      <div className="row-between stock-toolbar">
        <div className="segmented segmented-sm" role="tablist" aria-label="Affichage">
          {([['tout', 'Tous les types'], ['alertes', 'Sous le minimum'], ['suivis', 'Avec un minimum']] as const).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={only === k} className={only === k ? 'active' : ''} onClick={() => setOnly(k)}>{l}</button>
          ))}
        </div>
        <span className="small muted">Le minimum se modifie directement sur la tuile (valider avec Entrée).</span>
      </div>
      {ports.map((port) => {
        const rows = data.types.filter((t) => t.active).map((t) => {
          const stock = count(port.id, t.code, 'stock');
          const min = minOf(port.id, t.code);
          const state: 'ok' | 'warn' | 'danger' | 'none' = min === 0 ? 'none' : stock >= min ? 'ok' : stock === 0 ? 'danger' : 'warn';
          return { t, stock, min, state, mounted: count(port.id, t.code, 'monte'), quar: count(port.id, t.code, 'quarantaine') };
        });
        const low = rows.filter((r) => r.state === 'warn' || r.state === 'danger');
        const shown = rows.filter((r) => only === 'tout' || (only === 'alertes' ? r.state === 'warn' || r.state === 'danger' : r.min > 0));
        const total = rows.reduce((n, r) => n + r.stock, 0);
        return (
          <section key={port.id} className="card stock-port">
            <div className="stock-port-head">
              <div><span className="pd-kicker">Drone port</span><h2>{port.name}</h2></div>
              <div className="stock-port-kpis">
                <span><b>{total}</b> pièce(s) en stock</span>
                <span className={low.length ? 't-warn' : 't-ok'}><b>{low.length}</b> type(s) sous le minimum</span>
                <span className={rows.some((r) => r.state === 'danger') ? 't-danger' : 't-ok'}><b>{rows.filter((r) => r.state === 'danger').length}</b> rupture(s)</span>
              </div>
            </div>
            {shown.length === 0 ? <div className="pk-empty"><Icon name="shield" size={20} /> Rien à signaler pour ce filtre.</div> : (
                  <div className="stock-tiles">
                    {[...shown].sort((a, b) => categories.indexOf(a.t.category) - categories.indexOf(b.t.category)).map((r, i, arr) => {
                      const key = `${port.id}|${r.t.code}`;
                      const blocks = Math.min(10, Math.max(r.min, r.stock, 1));
                      const firstOfCat = i === 0 || arr[i - 1].t.category !== r.t.category;
                      return (
                        <div key={r.t.code} className={`stile st-${r.state}${firstOfCat ? ' cat-first' : ''}`}>
                          <div className="stile-head">
                            <span className="pk-code">{r.t.code}</span>
                            <span className="stile-state">{r.state === 'danger' ? 'Rupture' : r.state === 'warn' ? `Manque ${r.min - r.stock}` : r.state === 'ok' ? 'OK' : ''}</span>
                          </div>
                          <div className="stile-name">{r.t.name}<small>{r.t.category}</small></div>
                          <div className="stile-qty">
                            <b>{r.stock}</b>
                            <label>min <input className="min-input" type="number" min="0" aria-label={`Minimum ${r.t.name}`}
                              value={edit[key] ?? String(r.min)} onChange={(e) => setEdit({ ...edit, [key]: e.target.value })}
                              onBlur={() => saveMin(port.id, r.t.code)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} /></label>
                          </div>
                          <div className="stile-blocks" aria-hidden>
                            {Array.from({ length: blocks }, (_, i) => <i key={i} className={i < r.stock ? 'on' : i < r.min ? 'need' : ''} />)}
                            {r.stock > 10 && <span>+{r.stock - 10}</span>}
                          </div>
                          <div className="stile-foot">
                            <span>{r.mounted} montée(s){r.quar ? ` · ${r.quar} en quarantaine` : ''}</span>
                            <button className="btn btn-ghost btn-sm" onClick={() => onCreate(r.t.code)} title="Entrée en stock">＋</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
            )}
          </section>
        );
      })}
    </>
  );
}

// =====================================================================
// Quarantaine
// =====================================================================
function QuarantineTab({ parts, setModal }: { parts: PartRow[]; setModal: (m: ModalState) => void }) {
  const events = useData(async () => (parts.length
    ? unwrap(await supabase.from('v_part_events').select('*').in('part_id', parts.map((p) => p.id)).eq('event_type', 'quarantaine')
      .order('at', { ascending: false })) as PartEventRow[]
    : []), [parts.map((p) => p.id).join()]);
  if (!parts.length) return <div className="card pk-empty big"><Icon name="shield" size={26} /> Aucune pièce en quarantaine.</div>;
  const todayIso = iso(new Date());
  const items = parts.map((p) => ({ p, ev: events.data?.find((e) => e.part_id === p.id) }))
    .sort((a, b) => (a.ev?.at ?? '').localeCompare(b.ev?.at ?? ''));
  return (
    <>
      <p className="muted small">Une pièce en quarantaine attend une décision : expertise puis remise en stock, ou mise au rebut. Les plus anciennes sont en premier.</p>
      <div className="quar-grid">
        {items.map(({ p, ev }) => {
          const age = ev ? daysBetween(ev.at.slice(0, 10), todayIso) : null;
          return (
            <article key={p.id} className={`quar-card${age != null && age > 14 ? ' is-old' : ''}`}>
              <div className="quar-head">
                <div>
                  <Link to={`/pieces/${p.id}`} className="slot-code">{p.code}</Link>
                  <span className="small muted">{p.type_name}{p.serial_number ? ` · S/N ${p.serial_number}` : ''}</span>
                </div>
                {age != null && <span className="quar-age"><b>{age}</b> j</span>}
              </div>
              <blockquote>{ev?.reason ?? 'Motif non renseigné'}</blockquote>
              <dl className="quar-facts">
                <div><dt>Depuis</dt><dd>{ev ? dateTime(ev.at) : '—'}</dd></div>
                <div><dt>Provenance</dt><dd>{ev?.drone_code ? `${ev.drone_code} · ${ev.slot ?? ''}` : '—'}</dd></div>
                <div><dt>Heures</dt><dd>{hours(p.total_hours)}{p.max_hours_effective != null ? ` / ${hours(p.max_hours_effective)}` : ''}</dd></div>
                <div><dt>Cycles</dt><dd>{num(p.total_cycles, 0)}{p.max_cycles_effective != null ? ` / ${num(p.max_cycles_effective, 0)}` : ''}</dd></div>
                <div><dt>Drone port</dt><dd>{p.drone_port_name ?? '—'}</dd></div>
              </dl>
              <div className="quar-actions">
                <button className="btn btn-sm" onClick={() => setModal({ kind: 'status', part: p, to: 'stock' })}>↺ Remettre en stock</button>
                <button className="btn btn-sm btn-danger" onClick={() => setModal({ kind: 'status', part: p, to: 'rebut' })}>✕ Rebut</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setModal({ kind: 'transfer', part: p })} title="Transférer vers un autre drone port">⇄ Transférer</button>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}

// =====================================================================
// Historique des mouvements
// =====================================================================
function HistoryTab({ portFilter }: { portFilter: string }) {
  const [type, setType] = useState('');
  const { data, error, loading } = useData(async () => {
    let q = supabase.from('v_part_events').select('*').order('at', { ascending: false }).order('created_at', { ascending: false }).limit(300);
    if (type) q = q.eq('event_type', type);
    // périmètre déjà appliqué par la base (drone port de l'utilisateur)
    return unwrap(await q) as PartEventRow[];
  }, [type, portFilter]);
  return (
    <>
      <div className="inv-status" role="tablist" aria-label="Mouvement">
        <button type="button" role="tab" aria-selected={!type} className={`inv-chip${!type ? ' active' : ''}`} onClick={() => setType('')}>Tous</button>
        {Object.entries(PART_EVENT).map(([k, v]) => (
          <button key={k} type="button" role="tab" aria-selected={type === k} className={`inv-chip ev-${k}${type === k ? ' active' : ''}`} onClick={() => setType(k)}>{v.icon} {v.label}</button>
        ))}
      </div>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : !data?.length ? <Empty>Aucun mouvement.</Empty> : (
        <div className="card no-pad">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Mouvement</th><th>Pièce</th><th>Drone / emplacement</th><th>Drone ports</th><th>Motif</th></tr></thead>
              <tbody>
                {data.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap">{dateTime(e.at)}</td>
                    <td className="nowrap"><span className={`mv-pill ev-${e.event_type}`}>{PART_EVENT[e.event_type].icon} {PART_EVENT[e.event_type].label}</span></td>
                    <td><Link to={`/pieces/${e.part_id}`}><strong>{e.part_code}</strong></Link><div className="small muted">{e.type_name}</div></td>
                    <td>{e.drone_code ? `${e.drone_code} · ${e.slot ?? ''}` : '—'}</td>
                    <td>{e.event_type === 'transfert' ? `${e.from_port_name ?? '—'} → ${e.to_port_name ?? '—'}`
                      : e.event_type === 'entree_stock' ? e.to_port_name ?? '—' : '—'}</td>
                    <td className="cell-text">{e.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

// =====================================================================
// Types de pièces et potentiels (admin)
// =====================================================================
function TypesTab({ types, parts, isAdmin, onChanged }: { types: PartType[]; parts: PartRow[]; isAdmin: boolean; onChanged: () => void }) {
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // clé d'édition : « MOV:h » (potentiel en heures) ou « MOV:c » (potentiel en cycles)
  async function save(key: string) {
    const v = edit[key];
    if (v == null) return;
    const [code, unit] = key.split(':');
    setError(null);
    try {
      const n = v.trim() === '' ? null : Math.max(1, Number(v.replace(',', '.')));
      unwrap(await supabase.from('part_types').update(unit === 'c' ? { default_max_cycles: n == null ? null : Math.round(n) } : { default_max_hours: n }).eq('code', code).select());
      setEdit((e) => { const c = { ...e }; delete c[key]; return c; });
      setSaved(key);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const undef = types.filter((t) => t.active && t.default_max_hours == null && t.default_max_cycles == null).length;
  const potInput = (t: PartType, unit: 'h' | 'c') => {
    const key = `${t.code}:${unit}`;
    const cur = unit === 'h' ? t.default_max_hours : t.default_max_cycles;
    return <>
      {isAdmin ? (
        <input className="min-input" type="number" min="1" step="1" placeholder={unit === 'h' ? 'à définir' : '—'} aria-label={`Potentiel ${unit === 'h' ? 'heures' : 'cycles'} ${t.name}`}
          value={edit[key] ?? (cur?.toString() ?? '')}
          onChange={(e) => setEdit({ ...edit, [key]: e.target.value })}
          onBlur={() => save(key)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      ) : cur != null ? (unit === 'h' ? `${num(cur)} h` : `${num(cur, 0)} cycles`) : unit === 'h' ? <span className="text-warn">à définir</span> : '—'}
      {saved === key && <span className="small text-ok"> ✓</span>}
    </>;
  };
  return (
    <>
      <ErrorBox error={error} />
      <div className="card no-pad">
        <div className="table-summary small muted">
          Le potentiel (heures de vol et/ou cycles maximum) s'applique à toutes les pièces du type, sauf si une pièce a son propre potentiel.
          Un cycle = un décollage + un atterrissage, compté à chaque vol du drone pendant le montage (moteurs VTOL notamment) ; la pièce est en alerte dès que l'un des deux potentiels approche.
          {undef > 0 && <> <strong className="text-warn">{undef} type(s) sans potentiel.</strong></>}
          {!isAdmin && ' Seul un administrateur peut le modifier.'}
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Code</th><th>Catégorie</th><th>Sous-catégorie</th><th className="num">Potentiel (h)</th><th className="num">Potentiel (cycles)</th><th className="num">Montées</th><th className="num">En stock</th><th className="num">Alerte</th></tr></thead>
            <tbody>
              {types.map((t) => {
                const of = parts.filter((p) => p.type_code === t.code);
                const alert = of.filter((p) => p.status === 'monte' && ['warn', 'danger'].includes(potentialLevel(p))).length;
                return (
                  <tr key={t.code}>
                    <td><span className="pk-code">{t.code}</span></td>
                    <td>{t.category}</td>
                    <td>{t.name}{t.multi && <span className="small muted"> · plusieurs par drone</span>}</td>
                    <td className="num">{potInput(t, 'h')}</td>
                    <td className="num">{potInput(t, 'c')}</td>
                    <td className="num">{of.filter((p) => p.status === 'monte').length}</td>
                    <td className="num">{of.filter((p) => p.status === 'stock').length}</td>
                    <td className="num">{alert ? <Badge level="warn">{alert}</Badge> : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="muted small">Codage des pièces : 3 lettres du type suivies d'un numéro attribué automatiquement (ex. {types[0]?.code ?? 'MOV'}0001).</p>
    </>
  );
}
