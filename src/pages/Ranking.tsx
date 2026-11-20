import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { useApp } from '../lib/app';
import { useData } from '../lib/useData';
import { date, LABELS } from '../lib/format';
import { iso, Preset, PRESETS, rangeFor } from '../lib/stats';
import { fmt, Legend } from '../components/charts';
import { milestoneProgress } from '../lib/milestones';
import { Badge, Empty, ErrorBox, Field, Loading, PageHeader } from '../components/ui';
import { Icon } from '../components/icons';

interface RankRow {
  pilot_id: string; full_name: string; license_number: string | null; active: boolean;
  drone_port_id: string | null; drone_port_name: string | null; has_account: boolean;
  flights: number; minutes: number; pic_minutes: number; copilot_minutes: number; initial_minutes: number;
  career_hours: number; first_flight: string | null; last_flight: string | null;
}

type Mode = 'carriere' | Preset;
const C_PIC = 'var(--series-1)', C_COP = 'var(--series-3)', C_PREV = 'var(--rank-prev)';
const hm = (min: number) => { const m = Math.round(min); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };
const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');

/** Paliers : 10, 25, 50, 100, 250 h puis tous les 500 h (voir lib/milestones) */
const nextMilestone = (hours: number) => milestoneProgress(hours);

type Range = { from: string; to: string } | null;

/** Onglet Pilotes : classement par heures de vol (carnet). */
function PilotRanking({ range, showInactive }: { range: Range; showInactive: boolean }) {
  const { isAdmin, portFilter, myPort, pilot: me } = useApp();

  const { data, error, loading } = useData(async () => unwrap(await supabase.rpc('pilot_ranking', {
    p_from: range?.from ?? null, p_to: range?.to ?? null, p_port: isAdmin ? (portFilter || null) : null,
  })) as RankRow[], [range?.from, range?.to, portFilter, isAdmin]);

  const rows = useMemo(() => {
    const list = (data ?? []).filter((r) => showInactive || r.active).map((r) => ({ ...r, minutes: Number(r.minutes) }));
    list.sort((a, b) => b.minutes - a.minutes || a.full_name.localeCompare(b.full_name));
    // rang partagé en cas d'égalité
    let rank = 0, last = -1;
    return list.map((r, i) => { if (r.minutes !== last) { rank = i + 1; last = r.minutes; } return { ...r, rank }; });
  }, [data, showInactive]);

  const ranked = rows.filter((r) => r.minutes > 0);
  const totalMin = ranked.reduce((s, r) => s + r.minutes, 0);
  const max = Math.max(1, ...rows.map((r) => r.minutes));
  const podium = ranked.filter((r) => r.rank <= 3).slice(0, 3);
  const career = range == null;
  const mine = rows.find((r) => r.pilot_id === me?.id);

  return (
    <>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : !rows.length ? <Empty>Aucun pilote dans ce périmètre.</Empty> : (
        <div className={loading ? 'viz-refetch' : ''}>
          <div className="stats">
            <div className="stat"><div className="stat-label">Pilotes classés</div><div className="stat-value">{ranked.length}<span className="stat-unit"> / {rows.length}</span></div><div className="stat-sub">avec au moins une heure</div></div>
            <div className="stat"><div className="stat-label">Heures cumulées</div><div className="stat-value">{fmt(totalMin / 60)}<span className="stat-unit"> h</span></div><div className="stat-sub">{career ? 'carrière de tous les pilotes' : 'sur la période'}</div></div>
            <div className="stat"><div className="stat-label">Moyenne par pilote classé</div><div className="stat-value">{ranked.length ? fmt(totalMin / 60 / ranked.length) : '—'}<span className="stat-unit"> h</span></div></div>
            <div className="stat"><div className="stat-label">{mine ? 'Votre rang' : 'En tête'}</div>
              <div className="stat-value">{mine ? (mine.minutes > 0 ? <>{mine.rank}<span className="stat-unit"> / {ranked.length}</span></> : '—') : ranked[0]?.full_name ?? '—'}</div>
              <div className="stat-sub">{mine ? hm(mine.minutes) : ranked[0] ? hm(ranked[0].minutes) : ''}</div></div>
          </div>

          {podium.length > 0 && (
            <section className="podium" aria-label="Podium">
              {[podium[1], podium[0], podium[2]].map((r, i) => r && (
                <div key={r.pilot_id} className={`podium-step rank-${r.rank} pos-${i}`}>
                  <div className="podium-avatar"><span>{initials(r.full_name)}</span><b className="podium-medal">{r.rank}</b></div>
                  <div className="podium-name">{r.full_name}{r.pilot_id === me?.id && <span className="you-tag">vous</span>}</div>
                  <div className="podium-hours">{fmt(r.minutes / 60)} <small>h</small></div>
                  <div className="podium-meta">{r.flights} vol(s){isAdmin && !portFilter && r.drone_port_name ? ` · ${r.drone_port_name}` : ''}</div>
                  <div className="podium-block"><span>{r.rank}</span></div>
                </div>
              ))}
            </section>
          )}

          <section className="card no-pad">
            <div className="table-summary row-between">
              <strong>Classement</strong>
              <Legend items={[
                { key: 'p', label: 'Commandant de bord', color: C_PIC },
                { key: 'c', label: 'Copilote', color: C_COP },
                ...(career ? [{ key: 'a', label: 'Heures antérieures', color: C_PREV }] : []),
              ]} />
            </div>
            <div className="table-wrap">
              <table className="rank-table">
                <thead><tr>
                  <th className="c">Rang</th><th>Pilote</th><th className="rank-bar-col">Heures de vol</th><th className="num">Total</th><th className="num">Vols</th>
                  <th className="num">Part CdB</th><th>Dernier vol</th>{career && <th>Prochain palier</th>}
                </tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const flown = Number(r.pic_minutes) + Number(r.copilot_minutes);
                    const ms = career ? nextMilestone(r.minutes / 60) : null;
                    const isMe = r.pilot_id === me?.id;
                    return (
                      <tr key={r.pilot_id} className={`${isMe ? 'is-me' : ''}${r.minutes ? '' : ' row-muted'}`}>
                        <td className="c"><span className={`rank-badge${r.rank <= 3 && r.minutes ? ` top-${r.rank}` : ''}`}>{r.minutes ? r.rank : '—'}</span></td>
                        <td>
                          <div className="rank-pilot">
                            <span className="rank-avatar" aria-hidden>{initials(r.full_name)}</span>
                            <div>
                              {(isAdmin || isMe) ? <Link to={`/carnet/${r.pilot_id}`}><strong>{r.full_name}</strong></Link> : <strong>{r.full_name}</strong>}
                              {isMe && <span className="you-tag">vous</span>}
                              {!r.active && <span className="small muted"> · inactif</span>}
                              <div className="small muted">{r.drone_port_name ?? 'Sans drone port'}{r.license_number ? ` · Lic. ${r.license_number}` : ''}</div>
                            </div>
                          </div>
                        </td>
                        <td className="rank-bar-col">
                          <div className="rank-bar" role="img" aria-label={`${r.full_name} : ${hm(r.minutes)}, dont ${hm(Number(r.pic_minutes))} commandant de bord, ${hm(Number(r.copilot_minutes))} copilote`}
                            title={`CdB ${hm(Number(r.pic_minutes))} · copilote ${hm(Number(r.copilot_minutes))}${career && Number(r.initial_minutes) ? ` · antérieures ${hm(Number(r.initial_minutes))}` : ''}`}>
                            <span style={{ width: `${(100 * Number(r.pic_minutes)) / max}%`, background: C_PIC }} />
                            <span style={{ width: `${(100 * Number(r.copilot_minutes)) / max}%`, background: C_COP }} />
                            {career && <span style={{ width: `${(100 * Number(r.initial_minutes)) / max}%`, background: C_PREV }} />}
                          </div>
                        </td>
                        <td className="num nowrap"><strong>{fmt(r.minutes / 60)} h</strong><div className="small muted">{hm(r.minutes)}</div></td>
                        <td className="num">{r.flights}</td>
                        <td className="num">{flown ? `${fmt((100 * Number(r.pic_minutes)) / flown, 0)} %` : '—'}</td>
                        <td className="nowrap">{r.last_flight ? date(r.last_flight) : <span className="muted">—</span>}</td>
                        {career && (
                          <td className="rank-ms">
                            {ms && <>
                              <div className="small"><strong>{ms.next} h</strong> <span className="muted">· reste {fmt(ms.remaining)} h</span></div>
                              <div className="rank-ms-track"><span style={{ width: `${ms.pct}%` }} /></div>
                            </>}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
          <p className="muted small" style={{ marginTop: 12 }}>
            Seuls les vols clôturés (inscrits au carnet de vol) sont comptés. {career ? 'En mode carrière, les heures antérieures déclarées sur la fiche pilote sont ajoutées. ' : ''}
            En cas d'égalité, les pilotes partagent le même rang.{!isAdmin ? ` Classement limité aux pilotes de votre drone port (${myPort?.name}).` : ''}
          </p>
        </div>
      )}
    </>
  );
}

// =====================================================================
// Page « Classement » : onglets Pilotes / Drones, filtres communs
// =====================================================================
type Tab = 'pilotes' | 'drones';

export default function Ranking() {
  const { isAdmin, ports, portFilter, setPortFilter, myPort } = useApp();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('onglet') === 'drones' ? 'drones' : 'pilotes';
  const setTab = (t: Tab) => { const p = new URLSearchParams(params); p.set('onglet', t); setParams(p, { replace: true }); };
  const [mode, setMode] = useState<Mode>('carriere');
  const year = new Date().getFullYear();
  const [custom, setCustom] = useState({ from: `${year}-01-01`, to: iso(new Date()) });
  const [showInactive, setShowInactive] = useState(false);
  const range = useMemo(() => (mode === 'carriere' ? null : rangeFor(mode, custom)), [mode, custom]);
  const portName = isAdmin ? (portFilter ? ports.find((p) => p.id === portFilter)?.name : 'Tous les drone ports') : myPort?.name;
  const periodLabel = range ? `Du ${date(range.from)} au ${date(range.to)}` : 'Carrière (heures antérieures comprises)';

  return (
    <>
      <PageHeader title="Classement" subtitle={<>{portName} · {periodLabel}</>} />

      <div className="tabs" role="tablist">
        {([['pilotes', 'Pilotes', 'users'], ['drones', 'Drones', 'drone']] as const).map(([k, label, icon]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>
            <Icon name={icon} size={16} /> {label}
          </button>
        ))}
      </div>

      <div className="card filter-row">
        <Field label="Période">
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="carriere">Carrière (total)</option>
            {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}{p.key === 'annee' ? ` (${year})` : p.key === 'annee_prec' ? ` (${year - 1})` : ''}</option>)}
          </select>
        </Field>
        {mode === 'perso' && <>
          <Field label="Du"><input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></Field>
          <Field label="Au"><input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></Field>
        </>}
        <Field label="Drone port">
          {isAdmin ? (
            <select value={portFilter} onChange={(e) => setPortFilter(e.target.value)}>
              <option value="">Tous les drone ports</option>
              {ports.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          ) : <select value={myPort?.id} disabled><option>{myPort?.name}</option></select>}
        </Field>
        <label className="field checkbox-field"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          {tab === 'pilotes' ? ' Inclure les pilotes inactifs' : ' Inclure les drones retirés'}</label>
      </div>

      {tab === 'pilotes' ? <PilotRanking range={range} showInactive={showInactive} /> : <DroneRanking range={range} showRetired={showInactive} />}
    </>
  );
}

// =====================================================================
// Onglet Drones : classement par heures de vol ou nombre de vols
// =====================================================================
interface DroneRankRow {
  drone_id: string; code: string; model: string; status: keyof typeof LABELS.droneStatus; drone_port_name: string | null;
  flights: number; deliveries: number; controls: number; qrf: number;
  minutes: number; delivery_minutes: number; control_minutes: number; qrf_minutes: number; initial_minutes: number;
  km: number; kg: number; career_hours: number; hours_to_next_visit: number | null; last_flight: string | null;
}
type Metric = 'heures' | 'vols';
const C_LIV = 'var(--series-1)', C_QRF = 'var(--series-2)', C_CTL = 'var(--series-3)';
const STATUS_LEVEL = { operationnel: 'ok', maintenance: 'warn', immobilise: 'danger', retire: 'neutral' } as const;

function DroneRanking({ range, showRetired }: { range: Range; showRetired: boolean }) {
  const { isAdmin, portFilter } = useApp();
  const [metric, setMetric] = useState<Metric>('heures');
  const career = range == null;

  const { data, error, loading } = useData(async () => unwrap(await supabase.rpc('drone_ranking', {
    p_from: range?.from ?? null, p_to: range?.to ?? null, p_port: isAdmin ? (portFilter || null) : null,
  })) as DroneRankRow[], [range?.from, range?.to, portFilter, isAdmin]);

  const value = (r: DroneRankRow) => (metric === 'heures' ? Number(r.minutes) : Number(r.flights));
  const rows = useMemo(() => {
    const list = (data ?? []).filter((r) => showRetired || r.status !== 'retire');
    list.sort((a, b) => value(b) - value(a) || (metric === 'heures' ? b.flights - a.flights : Number(b.minutes) - Number(a.minutes)) || a.code.localeCompare(b.code));
    let rank = 0, last = -1;
    return list.map((r, i) => { const v = value(r); if (v !== last) { rank = i + 1; last = v; } return { ...r, rank }; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, showRetired, metric]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!rows.length) return <Empty>Aucun drone dans ce périmètre.</Empty>;

  const ranked = rows.filter((r) => value(r) > 0);
  const totalMin = rows.reduce((s, r) => s + Number(r.minutes), 0);
  const totalFlights = rows.reduce((s, r) => s + Number(r.flights), 0);
  const max = Math.max(1, ...rows.map(value));
  const podium = ranked.filter((r) => r.rank <= 3).slice(0, 3);
  const fmtValue = (r: DroneRankRow) => (metric === 'heures' ? <>{fmt(Number(r.minutes) / 60)} <small>h</small></> : <>{r.flights} <small>vol{r.flights > 1 ? 's' : ''}</small></>);
  // segments de la barre : livraisons / QRF / contrôles (+ heures antérieures en carrière)
  const segments = (r: DroneRankRow) => metric === 'heures'
    ? [[Number(r.delivery_minutes), C_LIV], [Number(r.qrf_minutes), C_QRF], [Number(r.control_minutes), C_CTL], [career ? Number(r.initial_minutes) : 0, C_PREV]] as const
    : [[Number(r.deliveries), C_LIV], [Number(r.qrf), C_QRF], [Number(r.controls), C_CTL]] as const;

  return (
    <div className={loading ? 'viz-refetch' : ''}>
      <div className="row-between rank-toolbar">
        <div className="segmented segmented-sm" role="radiogroup" aria-label="Classer par">
          <button type="button" role="radio" aria-checked={metric === 'heures'} className={metric === 'heures' ? 'active' : ''} onClick={() => setMetric('heures')}>Heures de vol</button>
          <button type="button" role="radio" aria-checked={metric === 'vols'} className={metric === 'vols' ? 'active' : ''} onClick={() => setMetric('vols')}>Nombre de vols</button>
        </div>
        <span className="small muted">Tous les vols comptent (ouverts et clôturés), comme pour le potentiel du drone.</span>
      </div>

      <div className="stats">
        <div className="stat"><div className="stat-label">Drones classés</div><div className="stat-value">{ranked.length}<span className="stat-unit"> / {rows.length}</span></div><div className="stat-sub">avec au moins un vol</div></div>
        <div className="stat"><div className="stat-label">Heures de vol</div><div className="stat-value">{fmt(totalMin / 60)}<span className="stat-unit"> h</span></div><div className="stat-sub">{career ? 'carrière de la flotte' : 'sur la période'}</div></div>
        <div className="stat"><div className="stat-label">Vols</div><div className="stat-value">{totalFlights}</div>
          <div className="stat-sub">{rows.reduce((s, r) => s + Number(r.deliveries), 0)} livraisons · {rows.reduce((s, r) => s + Number(r.qrf), 0)} QRF</div></div>
        <div className="stat"><div className="stat-label">En tête</div><div className="stat-value">{ranked[0]?.code ?? '—'}</div>
          <div className="stat-sub">{ranked[0] ? (metric === 'heures' ? hm(Number(ranked[0].minutes)) : `${ranked[0].flights} vol(s)`) : ''}</div></div>
      </div>

      {podium.length > 0 && (
        <section className="podium" aria-label="Podium des drones">
          {[podium[1], podium[0], podium[2]].map((r, i) => r && (
            <div key={r.drone_id} className={`podium-step rank-${r.rank} pos-${i}`}>
              <div className="podium-avatar podium-drone"><Icon name="drone" size={r.rank === 1 ? 34 : 28} /><b className="podium-medal">{r.rank}</b></div>
              <div className="podium-name">{r.code}</div>
              <div className="podium-hours">{fmtValue(r)}</div>
              <div className="podium-meta">{metric === 'heures' ? `${r.flights} vol(s)` : `${fmt(Number(r.minutes) / 60)} h`}{r.drone_port_name ? ` · ${r.drone_port_name}` : ''}</div>
              <div className="podium-block"><span>{r.rank}</span></div>
            </div>
          ))}
        </section>
      )}

      <section className="card no-pad">
        <div className="table-summary row-between">
          <strong>Classement par {metric === 'heures' ? 'heures de vol' : 'nombre de vols'}</strong>
          <Legend items={[
            { key: 'l', label: 'Livraisons', color: C_LIV }, { key: 'q', label: 'QRF', color: C_QRF }, { key: 'c', label: 'Contrôles', color: C_CTL },
            ...(career && metric === 'heures' ? [{ key: 'a', label: 'Heures antérieures', color: C_PREV }] : []),
          ]} />
        </div>
        <div className="table-wrap">
          <table className="rank-table">
            <thead><tr>
              <th className="c">Rang</th><th>Drone</th><th className="rank-bar-col">{metric === 'heures' ? 'Heures de vol' : 'Vols'}</th>
              <th className="num">Heures</th><th className="num">Vols</th><th className="num">Livraisons</th><th className="num">Distance</th>
              <th className="num">Livré</th><th>Dernier vol</th><th className="num">Visite 250 h</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const v = value(r);
                const visit = r.hours_to_next_visit != null ? Number(r.hours_to_next_visit) : null;
                return (
                  <tr key={r.drone_id} className={v ? '' : 'row-muted'}>
                    <td className="c"><span className={`rank-badge${r.rank <= 3 && v ? ` top-${r.rank}` : ''}`}>{v ? r.rank : '—'}</span></td>
                    <td>
                      <div className="rank-pilot">
                        <span className="rank-avatar" aria-hidden><Icon name="drone" size={17} /></span>
                        <div>
                          <Link to={`/drones/${r.drone_id}`}><strong>{r.code}</strong></Link>{' '}
                          {r.status !== 'operationnel' && <Badge level={STATUS_LEVEL[r.status]}>{LABELS.droneStatus[r.status]}</Badge>}
                          <div className="small muted">{r.model}{r.drone_port_name ? ` · ${r.drone_port_name}` : ''}</div>
                        </div>
                      </div>
                    </td>
                    <td className="rank-bar-col">
                      <div className="rank-bar" role="img"
                        aria-label={`${r.code} : ${r.deliveries} livraison(s), ${r.qrf} QRF, ${r.controls} contrôle(s), ${hm(Number(r.minutes))}`}
                        title={`Livraisons ${r.deliveries} · QRF ${r.qrf} · contrôles ${r.controls} · ${hm(Number(r.minutes))}`}>
                        {segments(r).map(([w, c], i) => <span key={i} style={{ width: `${(100 * w) / max}%`, background: c }} />)}
                      </div>
                    </td>
                    <td className="num nowrap"><strong>{fmt(Number(r.minutes) / 60)} h</strong><div className="small muted">{hm(Number(r.minutes))}</div></td>
                    <td className="num">{r.flights}</td>
                    <td className="num">{r.deliveries}{Number(r.flights) ? <div className="small muted">{fmt((100 * Number(r.deliveries)) / Number(r.flights), 0)} %</div> : null}</td>
                    <td className="num nowrap">{Number(r.km) ? `${fmt(Number(r.km), 0)} km` : '—'}</td>
                    <td className="num nowrap">{Number(r.kg) ? `${fmt(Number(r.kg))} kg` : '—'}</td>
                    <td className="nowrap">{r.last_flight ? date(r.last_flight) : <span className="muted">—</span>}</td>
                    <td className="num nowrap">{visit == null ? '—' : <span className={visit <= 0 ? 'text-danger' : visit <= 25 ? 'text-warn' : ''}>{visit <= 0 ? 'dépassée' : `reste ${fmt(visit)} h`}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <p className="muted small" style={{ marginTop: 12 }}>
        Livraisons = vols de livraison sans QRF ; distance = distances saisies (QRF compris) ; « livré » = charge des livraisons réussies.
        {career ? ' En mode carrière, les heures antérieures du drone sont ajoutées.' : ''} Le compteur de visite est toujours celui d'aujourd'hui.
      </p>
    </div>
  );
}