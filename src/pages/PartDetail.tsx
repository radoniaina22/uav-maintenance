import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchAll, supabase, unwrap } from '../lib/supabase';
import { useData } from '../lib/useData';
import type { PartEventRow, PartInstallationRow, PartRow } from '../lib/types';
import { date, hours, num } from '../lib/format';
import { cycles, dateTime, PART_EVENT, PART_STATUS, potentialLevel, remainingCycles, remainingHours, TANGO4_ZONES, zoneLabel } from '../lib/parts';
import { addDays, daysBetween, iso, parseIso } from '../lib/stats';
import { FORECAST_WINDOW_DAYS, projection } from '../lib/dashboard';
import { Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { Icon, IconName } from '../components/icons';
import { downloadQrPng, downloadQrSvg, partQrValue, QrCode } from '../components/QrCode';
import { EditPartModal, ReplaceModal, StatusModal, TransferPartModal, UnmountModal } from '../components/PartModals';

type ModalState =
  | { kind: 'edit' } | { kind: 'unmount'; to: 'stock' | 'quarantaine' } | { kind: 'replace' }
  | { kind: 'status'; to: 'stock' | 'quarantaine' | 'rebut' } | { kind: 'transfer' };

const STATUS_ICON: Record<PartRow['status'], IconName> = { monte: 'drone', stock: 'box', quarantaine: 'alert', rebut: 'wrench' };
/** couleurs des segments du compteur de carrière (un par drone) */
const SEG_COLORS = ['#3987e5', '#d95926', '#199e70', '#c084fc', '#f5b83d', '#5fb3c9'];

/** Jauge circulaire du potentiel consommé (heures, ou cycles quand ce sont eux qui limitent) */
function LifeRing({ p }: { p: PartRow }) {
  const lvl = potentialLevel(p);
  const byCycles = p.cycle_pct != null && (p.hours_pct == null || Number(p.cycle_pct) > Number(p.hours_pct));
  const rest = byCycles ? remainingCycles(p) : remainingHours(p);
  const pct = p.potential_pct == null ? 0 : Math.min(100, Number(p.potential_pct));
  const R = 58, C = 2 * Math.PI * R;
  return (
    <div className={`life-ring lv-${lvl}`}>
      <svg viewBox="0 0 140 140" aria-hidden>
        <circle cx="70" cy="70" r={R} className="lr-track" />
        <circle cx="70" cy="70" r={R} className="lr-val" strokeDasharray={`${(C * pct) / 100} ${C}`} transform="rotate(-90 70 70)" />
      </svg>
      <div className="lr-center">
        {rest == null ? <><strong>{hours(p.total_hours)}</strong><span>potentiel à définir</span></>
          : byCycles ? (rest <= 0 ? <><strong>Dépassé</strong><span>de {cycles(-rest)}</span></>
            : <><strong>{num(rest, 0)}</strong><span>cycles restants · {num(p.potential_pct, 0)} %</span></>)
          : rest <= 0 ? <><strong>Dépassé</strong><span>de {hours(-rest)}</span></>
          : <><strong>{num(rest, rest < 10 ? 1 : 0)} h</strong><span>restantes · {num(p.potential_pct, 0)} %</span></>}
      </div>
    </div>
  );
}

export default function PartDetail() {
  const { id } = useParams() as { id: string };
  const [modal, setModal] = useState<ModalState | null>(null);

  const { data, error, loading, reload } = useData(async () => {
    const part = unwrap(await supabase.from('v_parts').select('*').eq('id', id).single()) as PartRow;
    const since = addDays(iso(new Date()), -(FORECAST_WINDOW_DAYS - 1));
    const [inst, events, candidates, flights] = await Promise.all([
      supabase.from('v_part_installations').select('*').eq('part_id', id).order('installed_at', { ascending: false }),
      supabase.from('v_part_events').select('*').eq('part_id', id).order('at', { ascending: false }).order('created_at', { ascending: false }),
      part.status === 'monte'
        ? fetchAll<PartRow>((a, b) => supabase.from('v_parts').select('*').eq('status', 'stock').eq('type_code', part.type_code)
          .eq('drone_port_id', part.drone_port_id ?? '').range(a, b))
        : Promise.resolve([] as PartRow[]),
      part.drone_id
        ? supabase.from('v_flights').select('duration_min').eq('drone_id', part.drone_id).gte('flight_date', since).limit(2000)
        : Promise.resolve({ data: [], error: null }),
    ]);
    const flown = ((unwrap(flights) ?? []) as { duration_min: number | null }[]).reduce((s, f) => s + Number(f.duration_min ?? 0), 0);
    return {
      part, installations: unwrap(inst) as PartInstallationRow[], events: unwrap(events) as PartEventRow[], candidates,
      perDay: flown / 60 / FORECAST_WINDOW_DAYS,
    };
  }, [id]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const { part: p, installations, events, perDay } = data;
  const st = PART_STATUS[p.status];
  const done = () => { setModal(null); reload(); };
  const lvl = potentialLevel(p);
  const rest = remainingHours(p);
  const todayIso = iso(new Date());

  // échéance estimée (pièce montée, au rythme de son drone)
  const forecast = p.status === 'monte' && rest != null ? projection(rest, perDay) : null;
  // ancienneté : depuis l'acquisition ou la première entrée en stock
  const firstEvent = [...events].reverse()[0];
  const since = p.acquired_on ?? (firstEvent ? firstEvent.at.slice(0, 10) : null);
  const ageDays = since ? daysBetween(since, todayIso) : null;

  // compteur de carrière : heures avant suivi + heures sur chaque drone (ordre chronologique)
  const chrono = [...installations].reverse();
  const droneColor = new Map<string, string>();
  for (const i of chrono) if (!droneColor.has(i.drone_code)) droneColor.set(i.drone_code, SEG_COLORS[droneColor.size % SEG_COLORS.length]);
  const max = Number(p.max_hours_effective ?? 0);
  const scale = Math.max(max, Number(p.total_hours), 1);
  const segs = [
    ...(Number(p.initial_hours) > 0 ? [{ key: 'init', label: 'Avant suivi', h: Number(p.initial_hours), color: '#5b6f91', cur: false }] : []),
    ...chrono.map((i) => ({ key: i.id, label: `${i.drone_code} · ${i.slot_label ?? zoneLabel(i.zone)}`, h: Number(i.hours_on_drone), color: droneColor.get(i.drone_code)!, cur: !i.removed_at })),
  ].filter((s) => s.h > 0);
  const zonePos = p.status === 'monte' ? TANGO4_ZONES.find((z) => z.code === p.zone) : null;
  const lastQuarantine = events.find((e) => e.event_type === 'quarantaine');

  return (
    <div className="part-page">
      <PageHeader
        title={<span className="ph-title">{p.code}</span>}
        subtitle={<>{p.type_name} · {p.category}{p.serial_number ? ` · S/N ${p.serial_number}` : ''}{p.manufacturer ? ` · ${p.manufacturer}` : ''}</>}
        actions={<>
          <Link className="btn" to="/pieces?onglet=inventaire">← Pièces</Link>
          <button className="btn" onClick={() => setModal({ kind: 'edit' })}>Modifier</button>
          {p.status === 'monte' && <>
            <button className="btn btn-primary" onClick={() => setModal({ kind: 'replace' })} disabled={!data.candidates.length}
              title={data.candidates.length ? undefined : 'Aucune pièce de ce type en stock dans ce drone port'}>⇆ Remplacer</button>
            <button className="btn" onClick={() => setModal({ kind: 'unmount', to: 'stock' })}>⤒ Démonter</button>
            <button className="btn btn-danger" onClick={() => setModal({ kind: 'unmount', to: 'quarantaine' })}>⚠ Défaillance</button>
          </>}
          {p.status === 'stock' && <>
            <Link className="btn btn-primary" to="/pieces?onglet=drone">⤓ Monter (vue drone)</Link>
            <button className="btn" onClick={() => setModal({ kind: 'transfer' })}>⇄ Transférer</button>
            <button className="btn btn-danger" onClick={() => setModal({ kind: 'status', to: 'quarantaine' })}>⚠ Quarantaine</button>
          </>}
          {p.status === 'quarantaine' && <>
            <button className="btn" onClick={() => setModal({ kind: 'status', to: 'stock' })}>↺ Remettre en stock</button>
            <button className="btn btn-danger" onClick={() => setModal({ kind: 'status', to: 'rebut' })}>✕ Rebut</button>
            <button className="btn" onClick={() => setModal({ kind: 'transfer' })}>⇄ Transférer</button>
          </>}
        </>}
      />

      {/* ===== En-tête : jauge, identité, localisation, QR ===== */}
      <section className={`ph-hero st-${p.status} lv-${lvl}`}>
        <LifeRing p={p} />
        <div className="ph-ident">
          <span className={`ph-status st-${p.status}`}><Icon name={STATUS_ICON[p.status]} size={14} /> {st.label}</span>
          <h2>{p.type_name}</h2>
          <dl className="ph-facts">
            <div><dt>Code</dt><dd className="mono">{p.code}</dd></div>
            {p.legacy_code && <div><dt>Ancien code</dt><dd className="mono">{p.legacy_code}</dd></div>}
            <div><dt>N° de série</dt><dd>{p.serial_number ?? '—'}</dd></div>
            <div><dt>Fabricant</dt><dd>{p.manufacturer ?? '—'}</dd></div>
            <div><dt>Potentiel</dt><dd>{p.max_hours_effective == null && p.max_cycles_effective == null ? <span className="text-warn">à définir</span> : <>
              {p.max_hours_effective != null && <>{hours(p.max_hours_effective)} <small>{p.max_hours != null ? 'propre à la pièce' : 'du type'}</small></>}
              {p.max_hours_effective != null && p.max_cycles_effective != null && ' · '}
              {p.max_cycles_effective != null && <>{cycles(p.max_cycles_effective)} <small>{p.max_cycles != null ? 'propre à la pièce' : 'du type'}</small></>}
            </>}</dd></div>
          </dl>
        </div>

        <div className="ph-where">
          <span className="pd-kicker">Où est-elle ?</span>
          {p.status === 'monte' ? (
            <>
              <div className="ph-mini-drone">
                <img src="./tango4.png" alt="" />
                {zonePos && <i style={{ left: `${zonePos.x}%`, top: `${zonePos.y}%` }} />}
              </div>
              <div className="ph-where-txt">
                <b><Link to={`/drones/${p.drone_id}`}>{p.drone_code}</Link> · {p.slot_label ?? zoneLabel(p.zone)}</b>
                <span>montée le {dateTime(p.installed_at)} · {p.drone_port_name}</span>
              </div>
            </>
          ) : p.status === 'quarantaine' ? (
            <div className="ph-where-box warn">
              <Icon name="alert" size={22} />
              <div><strong>En quarantaine · {p.drone_port_name ?? '—'}</strong>
                <span>{lastQuarantine ? `depuis le ${dateTime(lastQuarantine.at)} (${daysBetween(lastQuarantine.at.slice(0, 10), todayIso)} j)` : ''}</span>
                {lastQuarantine?.reason && <q>{lastQuarantine.reason}</q>}</div>
            </div>
          ) : (
            <div className={`ph-where-box${p.status === 'rebut' ? ' off' : ''}`}>
              <Icon name={STATUS_ICON[p.status]} size={22} />
              <div><strong>{p.status === 'stock' ? `En stock · ${p.drone_port_name ?? '—'}` : 'Mise au rebut'}</strong>
                <span>{p.status === 'stock' ? 'prête à être montée' : 'retirée du service'}</span></div>
            </div>
          )}
        </div>

        <div className="ph-qr">
          <QrCode value={partQrValue(p.code)} size={96} />
          <div className="ph-qr-actions">
            <Link className="btn btn-sm" to={`/pieces/etiquettes?ids=${p.id}`}>⎙ Étiquette</Link>
            <span><button className="btn btn-ghost btn-sm" onClick={() => downloadQrPng(p.code)}>PNG</button>
              <button className="btn btn-ghost btn-sm" onClick={() => downloadQrSvg(p.code)}>SVG</button></span>
          </div>
        </div>
      </section>

      {/* ===== Chiffres clés ===== */}
      <div className="flight-kpis part-kpis">
        <div className="fk"><span className="fk-icon"><Icon name="clock" size={18} /></span>
          <div><strong>{hours(p.total_hours)}</strong><span>de vol · dont {hours(p.initial_hours)} avant suivi</span></div></div>
        <div className="fk"><span className="fk-icon"><Icon name="flight" size={18} /></span>
          <div><strong>{cycles(p.total_cycles)}</strong><span>{p.flight_count} vol(s) suivi(s){Number(p.initial_cycles) > 0 ? ` · ${p.initial_cycles} avant suivi` : ''} · {new Set(installations.map((i) => i.drone_code)).size} drone(s)</span></div></div>
        <div className={`fk${forecast ? (forecast.days <= 7 ? ' fk-danger' : forecast.days <= 30 ? ' fk-warn' : ' fk-ok') : ''}`}>
          <span className="fk-icon"><Icon name="bell" size={18} /></span>
          <div>
            <strong>{p.status !== 'monte' ? '—' : rest == null ? 'à définir' : rest <= 0 ? 'Maintenant' : forecast ? `J-${forecast.days}` : 'pas de vol'}</strong>
            <span>{p.status !== 'monte' ? 'échéance (pièce non montée)' : forecast && rest! > 0 ? `remplacement vers le ${parseIso(forecast.date).toLocaleDateString('fr-FR')}` : rest != null && rest <= 0 ? 'potentiel atteint : à remplacer' : 'aucun vol récent du drone'}</span>
          </div></div>
        <div className="fk"><span className="fk-icon"><Icon name="bolt" size={18} /></span>
          <div><strong>{p.status === 'monte' && perDay > 0 ? `${num(perDay * 7, 1)} h` : '—'}</strong><span>par semaine (rythme du drone)</span></div></div>
        <div className="fk"><span className="fk-icon"><Icon name="book" size={18} /></span>
          <div><strong>{ageDays != null ? (ageDays < 60 ? `${ageDays} j` : `${Math.round(ageDays / 30)} mois`) : '—'}</strong>
            <span>{p.acquired_on ? `acquise le ${date(p.acquired_on)}` : since ? `suivie depuis le ${parseIso(since).toLocaleDateString('fr-FR')}` : 'ancienneté'}</span></div></div>
      </div>

      {/* ===== Compteur de carrière ===== */}
      <section className="card career">
        <div className="career-head">
          <div>
            <h2>Compteur de carrière</h2>
            <p className="muted small">Heures cumulées par affectation{max ? `, jusqu'au potentiel de ${hours(max)}` : ''}.</p>
          </div>
          <span className={`career-total lv-${lvl}`}>{hours(p.total_hours)}{max ? <small> / {hours(max)}</small> : null}</span>
        </div>
        <div className="career-bar">
          {segs.map((s) => (
            <span key={s.key} className={`career-seg${s.cur ? ' is-current' : ''}`} style={{ width: `${(s.h / scale) * 100}%`, background: s.color }}
              title={`${s.label} : ${hours(s.h)}`} />
          ))}
          {max > 0 && <i className="career-limit" style={{ left: `${Math.min(100, (max / scale) * 100)}%` }} />}
          {max > 0 && Number(p.total_hours) > max && <span className="career-over" style={{ left: `${(max / scale) * 100}%`, width: `${((Number(p.total_hours) - max) / scale) * 100}%` }} />}
        </div>
        <div className="career-legend">
          {segs.length === 0 ? <span className="muted small">Aucune heure de vol pour l'instant.</span> : segs.map((s) => (
            <span key={s.key}><i style={{ background: s.color }} />{s.label} · <b>{hours(s.h)}</b>{s.cur && <em> en place</em>}</span>
          ))}
        </div>
      </section>

      {p.notes && <section className="card ph-notes"><h2 className="card-title">Notes</h2><p className="prewrap">{p.notes}</p></section>}

      {/* ===== Affectations + journal ===== */}
      <div className="grid-2 ph-grid">
        <section className="card">
          <h2 className="card-title">Affectations sur drone</h2>
          {installations.length === 0 ? <Empty>Jamais montée.</Empty> : (
            <ol className="assign-list">
              {installations.map((i) => (
                <li key={i.id} className={i.removed_at ? '' : 'is-current'} style={{ borderLeftColor: droneColor.get(i.drone_code) }}>
                  <div className="assign-head">
                    <Link to={`/drones/${i.drone_id}`}><strong>{i.drone_code}</strong></Link>
                    <span>{i.slot_label ?? zoneLabel(i.zone)}</span>
                    <b>{num(i.hours_on_drone)} h</b>
                  </div>
                  <div className="assign-dates small muted">
                    {dateTime(i.installed_at)} → {i.removed_at ? dateTime(i.removed_at) : <span className="assign-live">en place</span>}
                    {' · '}{daysBetween(i.installed_at.slice(0, 10), i.removed_at ? i.removed_at.slice(0, 10) : todayIso)} j
                  </div>
                  {i.removal_reason && <div className="assign-reason">{i.removal_reason}</div>}
                </li>
              ))}
            </ol>
          )}
        </section>
        <section className="card">
          <h2 className="card-title">Journal des mouvements</h2>
          {events.length === 0 ? <Empty>Aucun mouvement.</Empty> : (
            <ol className="mv-timeline">
              {events.map((e) => (
                <li key={e.id} className={`ev-${e.event_type}`}>
                  <span className="mv-dot" aria-hidden>{PART_EVENT[e.event_type].icon}</span>
                  <div>
                    <div className="mv-head"><strong>{PART_EVENT[e.event_type].label}</strong><span className="small muted">{dateTime(e.at)}</span></div>
                    <div className="small muted">
                      {e.drone_code && <>{e.drone_code}{e.slot ? ` · ${e.slot}` : ''}</>}
                      {e.event_type === 'transfert' && <>{e.from_port_name ?? '—'} → {e.to_port_name ?? '—'}</>}
                      {e.event_type === 'entree_stock' && e.to_port_name}
                    </div>
                    {e.reason && <div className="mv-reason">{e.reason}</div>}
                    {(e.actor_name || e.imported) && <div className="small muted">
                      {e.actor_name ? `Par ${e.actor_name}` : ''}{e.imported ? `${e.actor_name ? ' · ' : ''}ancien registre` : ''}
                    </div>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {modal?.kind === 'edit' && <EditPartModal part={p} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'unmount' && <UnmountModal part={p} defaultTo={modal.to} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'replace' && <ReplaceModal part={p} candidates={data.candidates} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'status' && <StatusModal part={p} to={modal.to} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'transfer' && <TransferPartModal part={p} onClose={() => setModal(null)} onDone={done} />}
    </div>
  );
}
