import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { useApp } from '../lib/app';
import { useData } from '../lib/useData';
import type { BatteryPack, BatteryStatusRow, CapacityTest, FlightRow, TransferRow } from '../lib/types';
import { batteryCode, batteryLevel, date, healthLevel, LABELS, minutes, num, THRESHOLDS } from '../lib/format';
import { addDays, iso, parseIso } from '../lib/stats';
import { Badge, Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { Icon } from '../components/icons';
import { BatteryCell, endOfLife, GaugeRing, healthTrend, rateSince, RATE_WINDOW_DAYS } from '../components/BatteryVisuals';
import { BatteryModal, CapacityModal, TransferModal } from '../components/BatteryModals';

/** Courbe de vieillissement : santé (%) selon les cycles, tendance et projection jusqu'aux seuils */
function AgingChart({ tests, b }: { tests: CapacityTest[]; b: BatteryStatusRow }) {
  const trend = healthTrend(tests, b.capacity_mah);
  const pts = tests.filter((t) => t.cycles_at_test != null).map((t) => ({ t, x: Number(t.cycles_at_test), y: (100 * t.measured_mah) / b.capacity_mah }));
  if (!pts.length) return <Empty>Aucun relevé avec le nombre de cycles : la courbe de vieillissement apparaîtra après les premiers relevés.</Empty>;
  const W = 680, H = 250, L = 40, R = 16, T = 14, B = 34;
  const xMax = Math.max(b.max_cycles, ...pts.map((p) => p.x), b.total_cycles) * 1.02;
  const yMin = Math.min(60, ...pts.map((p) => p.y)) - 2, yMax = Math.max(102, ...pts.map((p) => p.y));
  const sx = (v: number) => L + (v / xMax) * (W - L - R);
  const sy = (v: number) => T + ((yMax - v) / (yMax - yMin)) * (H - T - B);
  const xTicks = Array.from({ length: 6 }, (_, i) => Math.round((b.max_cycles / 5) * i));
  // tendance : du premier relevé jusqu'au seuil critique (ou la fin de l'axe)
  const x0 = Math.min(...pts.map((p) => p.x));
  const xEnd = trend ? Math.min(xMax, trend.dangerAt != null && trend.dangerAt > x0 ? trend.dangerAt : xMax) : 0;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="aging" role="img" aria-label="Santé de la batterie selon les cycles">
      <rect x={L} y={sy(THRESHOLDS.healthWarnPct)} width={W - L - R} height={sy(THRESHOLDS.healthDangerPct) - sy(THRESHOLDS.healthWarnPct)} className="ag-zone-warn" />
      <rect x={L} y={sy(THRESHOLDS.healthDangerPct)} width={W - L - R} height={sy(yMin) - sy(THRESHOLDS.healthDangerPct)} className="ag-zone-danger" />
      {[100, 90, THRESHOLDS.healthWarnPct, THRESHOLDS.healthDangerPct, 70].filter((g) => g > yMin && g <= yMax).map((g) => (
        <g key={g}>
          <line x1={L} x2={W - R} y1={sy(g)} y2={sy(g)} className={`ag-grid${g === THRESHOLDS.healthWarnPct || g === THRESHOLDS.healthDangerPct ? ' ag-th' : ''}`} />
          <text x={L - 6} y={sy(g) + 4} textAnchor="end" className="ag-tick">{g} %</text>
        </g>
      ))}
      {xTicks.map((t) => <text key={t} x={sx(t)} y={H - 16} textAnchor="middle" className="ag-tick">{t}</text>)}
      <text x={(L + W - R) / 2} y={H - 2} textAnchor="middle" className="ag-tick">cycles</text>
      <line x1={sx(b.max_cycles)} x2={sx(b.max_cycles)} y1={T} y2={H - B} className="ag-max" />
      <text x={sx(b.max_cycles) - 4} y={T + 10} textAnchor="end" className="ag-tick">fin de vie {b.max_cycles} cycles</text>
      <line x1={sx(b.total_cycles)} x2={sx(b.total_cycles)} y1={T} y2={H - B} className="ag-now" />
      <text x={sx(b.total_cycles) + 4} y={H - B - 6} className="ag-tick ag-now-label">aujourd'hui · {b.total_cycles}</text>
      {trend && <line x1={sx(x0)} y1={sy(trend.intercept + trend.slope * x0)} x2={sx(xEnd)} y2={sy(trend.intercept + trend.slope * xEnd)} className="ag-trend" />}
      {trend?.warnAt != null && trend.warnAt > 0 && trend.warnAt < xMax && <circle cx={sx(trend.warnAt)} cy={sy(THRESHOLDS.healthWarnPct)} r={5} className="ag-cross warn" />}
      {trend?.dangerAt != null && trend.dangerAt > 0 && trend.dangerAt < xMax && <circle cx={sx(trend.dangerAt)} cy={sy(THRESHOLDS.healthDangerPct)} r={5} className="ag-cross danger" />}
      {pts.map((p) => (
        <circle key={p.t.id} cx={sx(p.x)} cy={sy(p.y)} r={5} className={`ag-pt lv-${healthLevel(p.y)}`}>
          <title>{date(p.t.test_date)} · {p.x} cycles : {num(p.t.measured_mah, 0)} mAh ({num(p.y, 1)} %)</title>
        </circle>
      ))}
    </svg>
  );
}

export default function BatteryDetail() {
  const { id } = useParams() as { id: string };
  const { isAdmin } = useApp();
  const [modal, setModal] = useState<'capacity' | 'edit' | 'transfer' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, error: loadError, loading, reload } = useData(async () => {
    const battery = unwrap(await supabase.from('v_battery_status').select('*').eq('id', id).single()) as BatteryStatusRow;
    const [tests, transfers, flights, packs, recent, partner] = await Promise.all([
      supabase.from('battery_capacity_tests').select('*').eq('battery_id', id).order('test_date', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('v_battery_transfers').select('*').eq('battery_id', id).order('transfer_date', { ascending: false }),
      supabase.from('v_flights').select('*').or(`battery_1_id.eq.${id},battery_2_id.eq.${id}`).order('flight_date', { ascending: false }).order('takeoff_time', { ascending: false }).limit(12),
      supabase.from('battery_packs').select('*').order('pack_number'),
      supabase.from('v_flights').select('id', { count: 'exact', head: true }).or(`battery_1_id.eq.${id},battery_2_id.eq.${id}`).gte('flight_date', rateSince()),
      battery.pack_id ? supabase.from('v_battery_status').select('*').eq('pack_id', battery.pack_id).neq('id', id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    ]);
    return {
      battery,
      tests: unwrap(tests) as CapacityTest[],
      transfers: unwrap(transfers) as TransferRow[],
      flights: unwrap(flights) as FlightRow[],
      packs: unwrap(packs) as BatteryPack[],
      perDay: (recent.count ?? 0) / RATE_WINDOW_DAYS,
      partner: (unwrap(partner) ?? null) as BatteryStatusRow | null,
    };
  }, [id]);

  async function deleteTest(t: CapacityTest) {
    if (!confirm(`Supprimer le relevé du ${date(t.test_date)} (${num(t.measured_mah, 0)} mAh) ?`)) return;
    try {
      unwrap(await supabase.from('battery_capacity_tests').delete().eq('id', t.id));
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (loading && !data) return <Loading />;
  if (loadError) return <ErrorBox error={loadError} />;
  if (!data) return null;
  const { battery: b, tests, transfers, flights, packs, perDay, partner } = data;
  const lvl = batteryLevel(b.cycle_pct);
  const hl = b.health_pct != null ? healthLevel(b.health_pct) : 'unknown';
  const done = () => { setModal(null); reload(); };
  const eol = endOfLife(b, perDay);
  const trend = healthTrend(tests, b.capacity_mah);
  // seuil de santé de 85 % : cycle prévu et date estimée au rythme actuel
  const warnCycle = trend?.warnAt != null && trend.warnAt > b.total_cycles ? Math.round(trend.warnAt) : null;
  const warnDate = warnCycle != null && perDay > 0 ? addDays(iso(new Date()), Math.ceil((warnCycle - b.total_cycles) / perDay)) : null;
  const lossPer100 = trend ? -trend.slope * 100 : null;

  return (
    <div className="bat-page">
      <PageHeader
        title={<>Batterie {batteryCode(b)}</>}
        subtitle={<>{b.serial_number ? `S/N ${b.serial_number} · ` : 'sans n° de série · '}{b.model}{/mah/i.test(b.model) ? '' : ` ${num(b.capacity_mah, 0)} mAh`} · ⌂ {b.drone_port_name ?? 'Non affectée'}{b.pack_number ? ` · Pack ${b.pack_number}, position ${b.position}` : ' · hors pack'}</>}
        actions={<>
          <Link className="btn" to="/batteries">← Batteries</Link>
          {isAdmin && <button className="btn" onClick={() => setModal('edit')}>Modifier</button>}
          {isAdmin && !b.pack_id && <button className="btn" onClick={() => setModal('transfer')}>⇄ Transférer</button>}
          <button className="btn btn-primary" onClick={() => setModal('capacity')}>+ Relevé de capacité</button>
        </>}
      />
      <ErrorBox error={error} />

      {/* ===== En-tête ===== */}
      <section className={`bd-hero lv-${hl === 'danger' || lvl === 'danger' ? 'danger' : hl === 'warn' || lvl === 'warn' ? 'warn' : 'ok'}`}>
        <div className="bd-photo"><img src="./battery-tattu.png" alt="" /></div>
        <div className="bd-ident">
          <div className="bd-code">{batteryCode(b)}<Badge level={b.status === 'en_service' ? 'ok' : b.status === 'stock' ? 'neutral' : 'danger'}>{LABELS.batteryStatus[b.status]}</Badge></div>
          <dl className="ph-facts">
            <div><dt>N° de série</dt><dd className="mono">{b.serial_number ?? '—'}</dd></div>
            <div><dt>Modèle</dt><dd>{b.model}</dd></div>
            <div><dt>Capacité nominale</dt><dd>{num(b.capacity_mah, 0)} mAh</dd></div>
            <div><dt>Pack</dt><dd>{b.pack_number ? `Pack ${b.pack_number} · position ${b.position}` : 'hors pack'}</dd></div>
            <div><dt>Drone port</dt><dd>{b.drone_port_name ?? 'Non affectée'}</dd></div>
            <div><dt>Mise en service</dt><dd>{b.commissioned_on ? date(b.commissioned_on) : '—'}</dd></div>
          </dl>
        </div>
        <div className="bd-rings">
          <GaugeRing value={b.health_pct ?? 0} level={hl} center={b.health_pct != null ? `${num(b.health_pct, 1)} %` : '—'}
            sub={b.health_pct != null ? 'santé' : 'pas de relevé'} size={128} />
          <GaugeRing value={b.total_cycles} max={b.max_cycles} level={lvl} center={`${b.total_cycles}`} sub={`/ ${b.max_cycles} cycles`} size={128} />
        </div>
      </section>

      <div className="flight-kpis bd-kpis">
        <div className="fk"><span className="fk-icon"><Icon name="battery" size={18} /></span>
          <div><strong>{Math.max(0, b.remaining_cycles)}</strong><span>cycles restants · {b.initial_cycles} initiaux + {b.flight_cycles} vols</span></div></div>
        <div className={`fk${b.last_measured_mah ? (hl === 'ok' ? ' fk-ok' : hl === 'warn' ? ' fk-warn' : ' fk-danger') : ' fk-warn'}`}><span className="fk-icon"><Icon name="bolt" size={18} /></span>
          <div><strong>{b.last_measured_mah ? `${num(b.last_measured_mah, 0)} mAh` : 'à mesurer'}</strong><span>{b.last_test_date ? `capacité réelle au ${date(b.last_test_date)}` : 'aucun relevé de capacité'}</span></div></div>
        <div className="fk"><span className="fk-icon"><Icon name="flight" size={18} /></span>
          <div><strong>{perDay > 0 ? `${num(perDay * 7, 1)} / sem.` : '—'}</strong><span>cycles (30 derniers jours) · dernier vol {date(b.last_used_on)}</span></div></div>
        <div className={`fk${eol && eol.days <= 60 ? ' fk-warn' : ''}`}><span className="fk-icon"><Icon name="clock" size={18} /></span>
          <div><strong>{!eol ? '—' : eol.days === 0 ? 'atteinte' : eol.days > 3650 ? '> 10 ans' : parseIso(eol.date).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' })}</strong>
            <span>fin de vie en cycles{eol ? '' : ' (aucun vol récent)'}</span></div></div>
        <div className={`fk${warnCycle != null && warnCycle - b.total_cycles < 50 ? ' fk-warn' : ''}`}><span className="fk-icon"><Icon name="health" size={18} /></span>
          <div><strong>{lossPer100 != null ? `−${num(lossPer100, 1)} pts` : '—'}</strong>
            <span>{lossPer100 != null ? `de santé / 100 cycles${warnCycle != null ? ` · ${THRESHOLDS.healthWarnPct} % vers ${warnCycle} cycles${warnDate ? ` (${parseIso(warnDate).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' })})` : ''}` : ''}` : 'tendance : 2 relevés avec cycles requis'}</span></div></div>
      </div>

      <div className="bd-grid">
        <section className="card bd-aging">
          <div className="pk-head">
            <div>
              <h2>Courbe de vieillissement</h2>
              <p>Santé mesurée selon les cycles. La droite prolonge la tendance jusqu'aux seuils de {THRESHOLDS.healthWarnPct} % (à surveiller) et {THRESHOLDS.healthDangerPct} % (critique).</p>
            </div>
          </div>
          <AgingChart tests={tests} b={b} />
        </section>

        <section className="card bd-twin">
          <h2>{partner ? 'Jumelle du pack' : 'Appairage'}</h2>
          {partner ? (() => {
            const dH = b.health_pct != null && partner.health_pct != null ? Number(b.health_pct) - Number(partner.health_pct) : null;
            const dC = b.total_cycles - partner.total_cycles;
            const warn = (dH != null && Math.abs(dH) > 5) || Math.abs(dC) > 25;
            return (
              <>
                <div className="twin-cells">
                  <div><BatteryCell b={b} label={batteryCode(b)} size="lg" /><span>{b.total_cycles} cycles</span></div>
                  <span className="twin-link">⇄</span>
                  <div><Link to={`/batteries/${partner.id}`}><BatteryCell b={partner} label={batteryCode(partner)} size="lg" /></Link><span>{partner.total_cycles} cycles</span></div>
                </div>
                <div className={`twin-verdict${warn ? ' warn' : ''}`}>
                  <Icon name={warn ? 'alert' : 'shield'} size={16} />
                  <span>{dH != null ? <>Écart de santé <b>{dH > 0 ? '+' : ''}{num(dH, 1)} pts</b> · </> : 'Santé non comparable · '}écart de <b>{Math.abs(dC)} cycles</b>.
                    {warn ? ' Les 2 batteries sont montées en parallèle : un écart important sollicite davantage la plus faible.' : ' Appairage équilibré.'}</span>
                </div>
              </>
            );
          })() : <p className="muted small">Cette batterie n'est pas dans un pack. Les batteries d'un pack sont montées en parallèle : appairez-la avec une batterie d'usure proche.</p>}
        </section>
      </div>

      <section className="card no-pad">
        <div className="table-summary row-between"><strong>Relevés de capacité</strong><span className="small muted">{tests.length} relevé(s)</span></div>
        {tests.length === 0 ? <div style={{ padding: 16 }}><Empty>Aucun relevé. Mesurez la capacité réelle par décharge complète puis saisissez-la ici.</Empty></div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th className="num">Capacité mesurée</th><th style={{ minWidth: 160 }}>Santé</th><th className="num">Écart / précédent</th><th className="num">Cycles</th><th>Technicien</th><th>Notes</th><th></th></tr></thead>
              <tbody>
                {tests.map((t, i) => {
                  const pct = (100 * t.measured_mah) / b.capacity_mah;
                  const prev = tests[i + 1];
                  const delta = prev ? t.measured_mah - prev.measured_mah : null;
                  return (
                    <tr key={t.id}>
                      <td className="nowrap">{date(t.test_date)}{i === 0 && <> <Badge level="info">dernier</Badge></>}</td>
                      <td className="num"><strong>{num(t.measured_mah, 0)} mAh</strong></td>
                      <td><div className={`health-bar lv-${healthLevel(pct)}`}><i style={{ width: `${Math.min(100, pct)}%` }} /><span>{num(pct, 1)} %</span></div></td>
                      <td className={`num${delta != null && delta < 0 ? ' text-warn' : delta ? ' text-ok' : ''}`}>{delta == null ? '—' : `${delta > 0 ? '+' : ''}${num(delta, 0)} mAh`}</td>
                      <td className="num">{t.cycles_at_test ?? '—'}</td>
                      <td>{t.technician ?? '—'}</td>
                      <td className="cell-text">{t.notes ?? '—'}</td>
                      <td><button className="btn btn-ghost btn-sm" onClick={() => deleteTest(t)}>Supprimer</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid-2 ph-grid">
        <section className="card">
          <h2 className="card-title">Derniers vols</h2>
          {flights.length === 0 ? <Empty>Aucun vol.</Empty> : (
            <ol className="bflights">
              {flights.map((f) => {
                const sag = f.cell_voltage_start != null && f.cell_voltage_end != null ? f.cell_voltage_start - f.cell_voltage_end : null;
                const usedPct = f.consumption_mah != null && f.pack_capacity_mah ? (100 * f.consumption_mah) / f.pack_capacity_mah : null;
                return (
                  <li key={f.id}>
                    <Link to={`/vols/${f.id}`} className="bf-main">
                      <span className="bf-date">{date(f.flight_date)}</span>
                      <span className="bf-route">{f.drone_code} → {f.destination_name ?? '—'}</span>
                      <span className="bf-dur">{minutes(f.duration_min)}</span>
                    </Link>
                    <div className="bf-data">
                      {usedPct != null ? (
                        <span className="bf-use"><span className={`bf-gauge${usedPct > 80 ? ' hot' : ''}`}><i style={{ width: `${Math.min(100, usedPct)}%` }} /></span>
                          {num(f.consumption_mah!, 0)} mAh · {num(usedPct, 0)} % du pack</span>
                      ) : <span className="muted">consommation non saisie</span>}
                      {f.cell_voltage_start != null && f.cell_voltage_end != null &&
                        <span className="bf-volt">{num(f.cell_voltage_start, 2)} → {num(f.cell_voltage_end, 2)} V/cell{sag != null && <em> (−{num(sag, 2)} V)</em>}</span>}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
        <section className="card">
          <h2 className="card-title">Transferts de drone port</h2>
          {transfers.length === 0 ? <Empty>Aucun transfert.</Empty> : (
            <ol className="btransfers">
              {transfers.map((t) => (
                <li key={t.id}>
                  <span className="bt-date">{date(t.transfer_date)}</span>
                  <span className="bt-route">{t.from_port_name ?? 'Non affecté'} <b>→</b> {t.to_port_name ?? 'Non affecté'}{t.pack_number ? <span className="muted small"> (pack {t.pack_number})</span> : null}</span>
                  <span className="bt-note muted small">{t.notes ?? ''}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {modal === 'capacity' && <CapacityModal battery={b} onClose={() => setModal(null)} onSaved={done} />}
      {modal === 'edit' && <BatteryModal battery={b} packs={packs} onClose={() => setModal(null)} onSaved={done} />}
      {modal === 'transfer' && <TransferModal target={{ kind: 'battery', id: b.id, label: batteryCode(b), portId: b.drone_port_id }} onClose={() => setModal(null)} onSaved={done} />}
    </div>
  );
}
