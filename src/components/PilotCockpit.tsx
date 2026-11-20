import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { LogbookRow, PilotStatsRow } from '../lib/types';
import { date, LABELS, minutes, num, time } from '../lib/format';
import { addDays, iso, parseIso } from '../lib/stats';
import { Badge, CountUp, Empty } from './ui';
import { Icon, IconName } from './icons';
import { milestoneProgress, milestonesUpTo } from '../lib/milestones';

/* « Cockpit du pilote » : licence, altimètre des heures, instruments, calendrier d'activité, distinctions, cartes d'embarquement. */

/** Médaille d'un palier d'heures (10, 25, 50, 100, 250 h puis tous les 500 h) */
function hoursMedal(m: number) {
  const named: Record<number, [string, string]> = {
    10: ['⏱', '10 heures'], 25: ['🥉', '25 heures'], 50: ['🥈', '50 heures'], 100: ['🥇', 'Centurion'],
    250: ['🏅', 'Vétéran'], 500: ['💎', 'Expert'], 1000: ['👑', 'Légende'],
  };
  const [icon, title] = named[m] ?? [m % 1000 === 0 ? '👑' : '🌟', `${m.toLocaleString('fr-FR')} heures`];
  return { icon, title, desc: `${m.toLocaleString('fr-FR')} h de vol cumulées` };
}
const MONTHS_SHORT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join('');
const hm = (m: number) => { const r = Math.round(m); return `${Math.floor(r / 60)} h ${String(r % 60).padStart(2, '0')}`; };

/** Grade honorifique selon les heures de carrière */
function grade(h: number) {
  if (h >= 1000) return { label: 'Commandant senior', stars: 5 };
  if (h >= 250) return { label: 'Commandant', stars: 4 };
  if (h >= 50) return { label: 'Pilote confirmé', stars: 3 };
  if (h >= 10) return { label: 'Pilote', stars: 2 };
  return { label: 'Pilote en formation', stars: 1 };
}

/** Plus longue série de jours consécutifs, et série en cours */
function streaks(days: string[]) {
  const set = Array.from(new Set(days)).sort();
  let best = 0, run = 0, prev = '';
  for (const d of set) { run = prev && addDays(prev, 1) === d ? run + 1 : 1; best = Math.max(best, run); prev = d; }
  const today = iso(new Date());
  let current = 0;
  for (let d = set.includes(today) ? today : addDays(today, -1); set.includes(d); d = addDays(d, -1)) current++;
  return { best, current };
}

// ---------------------------------------------------------------------
// Altimètre : anneau de progression vers le prochain palier
// ---------------------------------------------------------------------
function Altimeter({ hours }: { hours: number }) {
  const { next, pct: pct100 } = milestoneProgress(hours);
  const pct = pct100 / 100;
  const R = 74, C = 2 * Math.PI * R, arc = 0.78; // 280° d'arc
  const ticks = Array.from({ length: 29 }, (_, i) => i);
  return (
    <div className="altimeter">
      <svg viewBox="0 0 180 180" aria-hidden>
        <g transform="rotate(130 90 90)">
          <circle cx="90" cy="90" r={R} className="alt-track" strokeDasharray={`${C * arc} ${C}`} />
          <circle cx="90" cy="90" r={R} className="alt-value" strokeDasharray={`${C * arc * pct} ${C}`} />
        </g>
        {ticks.map((i) => {
          const a = ((130 + (280 * i) / 28) * Math.PI) / 180;
          const r1 = 86, r2 = i % 7 === 0 ? 79 : 82;
          return <line key={i} x1={90 + r1 * Math.cos(a)} y1={90 + r1 * Math.sin(a)} x2={90 + r2 * Math.cos(a)} y2={90 + r2 * Math.sin(a)} className={i / 28 <= pct ? 'alt-tick on' : 'alt-tick'} />;
        })}
      </svg>
      <div className="alt-center">
        <span className="alt-label">Heures de vol</span>
        <strong className="alt-hours"><CountUp value={hours} decimals={1} /></strong>
        <span className="alt-next">palier {next} h · reste {num(next - hours)} h</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Calendrier d'activité (heatmap)
// ---------------------------------------------------------------------
function Heatmap({ entries, year }: { entries: LogbookRow[]; year: string }) {
  const today = iso(new Date());
  const end = year ? (year === today.slice(0, 4) ? today : `${year}-12-31`) : today;
  const start0 = year ? `${year}-01-01` : addDays(today, -364);
  const startDow = (parseIso(start0).getDay() + 6) % 7; // lundi = 0
  const start = addDays(start0, -startDow);
  const perDay = new Map<string, { m: number; n: number }>();
  for (const e of entries) { const x = perDay.get(e.entry_date) ?? { m: 0, n: 0 }; x.m += Number(e.duration_min); x.n++; perDay.set(e.entry_date, x); }
  const max = Math.max(1, ...Array.from(perDay.values()).map((x) => x.m));
  const weeks: { d: string; inRange: boolean }[][] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const dow = (parseIso(d).getDay() + 6) % 7;
    if (dow === 0) weeks.push([]);
    weeks[weeks.length - 1].push({ d, inRange: d >= start0 });
  }
  const level = (m: number) => (m <= 0 ? 0 : m / max > 0.75 ? 4 : m / max > 0.5 ? 3 : m / max > 0.25 ? 2 : 1);
  const activeDays = Array.from(perDay.keys()).filter((d) => d >= start0 && d <= end).length;
  // sur petit écran, on fait défiler jusqu'aux semaines les plus récentes
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => { if (wrap.current) wrap.current.scrollLeft = wrap.current.scrollWidth; }, [year, entries.length]);
  return (
    <div className="heatmap-wrap" ref={wrap}>
      <div className="heatmap" style={{ gridTemplateColumns: `24px repeat(${weeks.length}, minmax(0, 16px))` }} role="img"
        aria-label={`Calendrier d'activité : ${activeDays} jour(s) de vol`}>
        <div className="hm-months" style={{ gridColumn: `2 / span ${weeks.length}`, gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 16px))` }}>
          {weeks.map((w, i) => {
            const first = w.find((c) => c.d.endsWith('-01') || (i === 0 && c.inRange));
            return <span key={i}>{first && (first.d.endsWith('-01') || i === 0) ? MONTHS_SHORT[Number(first.d.slice(5, 7)) - 1] : ''}</span>;
          })}
        </div>
        <div className="hm-days"><span>lun</span><span /><span>mer</span><span /><span>ven</span><span /><span /></div>
        {weeks.map((w, i) => (
          <div key={i} className="hm-week">
            {w.map((c) => {
              const x = perDay.get(c.d);
              return <span key={c.d} className={`hm-cell l${c.inRange ? level(x?.m ?? 0) : 'x'}`}
                title={c.inRange ? `${date(c.d)} : ${x ? `${x.n} vol(s) · ${minutes(x.m)}` : 'aucun vol'}` : undefined} />;
            })}
          </div>
        ))}
      </div>
      <div className="hm-legend small muted">
        <span>{activeDays} jour(s) de vol {year ? `en ${year}` : 'sur 12 mois'}</span>
        <span className="hm-scale">moins <i className="hm-cell l0" /><i className="hm-cell l1" /><i className="hm-cell l2" /><i className="hm-cell l3" /><i className="hm-cell l4" /> plus</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Distinctions
// ---------------------------------------------------------------------
interface Achievement { key: string; icon: string; title: string; desc: string; value: number; goal: number }

function Achievements({ items }: { items: Achievement[] }) {
  const done = items.filter((a) => a.value >= a.goal).length;
  return (
    <section className="card">
      <div className="row-between">
        <h2 className="card-title">Distinctions</h2>
        <span className="small muted">{done} / {items.length} débloquée(s)</span>
      </div>
      <div className="medals">
        {items.map((a) => {
          const ok = a.value >= a.goal;
          return (
            <div key={a.key} className={`medal${ok ? ' is-unlocked' : ''}`} title={`${a.title} : ${a.desc}`}>
              <span className="medal-icon" aria-hidden>{a.icon}</span>
              <strong>{a.title}</strong>
              <span className="small muted">{a.desc}</span>
              {!ok && <span className="medal-progress"><span style={{ width: `${Math.min(100, (100 * a.value) / a.goal)}%` }} /></span>}
              {!ok && <span className="medal-count">{num(Math.min(a.value, a.goal), a.goal < 20 && a.value % 1 ? 1 : 0)} / {a.goal}</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------
// Carte d'embarquement (un vol)
// ---------------------------------------------------------------------
function Ticket({ e, port }: { e: LogbookRow; port: string }) {
  const d = parseIso(e.entry_date);
  const dest = e.destination_name ?? (e.flight_type === 'controle' ? 'Vol local' : '—');
  return (
    <Link to={`/vols/${e.flight_id}`} className={`ticket type-${e.flight_type}`}>
      <div className="ticket-stub">
        <span className="ticket-day">{String(d.getDate()).padStart(2, '0')}</span>
        <span className="ticket-month">{MONTHS_SHORT[d.getMonth()]} {String(d.getFullYear()).slice(2)}</span>
      </div>
      <div className="ticket-main">
        <div className="ticket-route">
          <div className="ticket-point"><span className="ticket-code">{(e.drone_port_name ?? port).slice(0, 14)}</span><span className="ticket-time">{time(e.takeoff_time)}</span></div>
          <div className="ticket-path" aria-hidden>
            <svg viewBox="0 0 120 24" preserveAspectRatio="none"><path d="M2 20 Q60 -6 118 20" /></svg>
            <span className="ticket-plane"><Icon name="drone" size={14} /></span>
            <span className="ticket-dur">{minutes(e.duration_min)}</span>
          </div>
          <div className="ticket-point right"><span className="ticket-code">{dest.slice(0, 16)}</span><span className="ticket-time">{time(e.landing_time)}</span></div>
        </div>
        <div className="ticket-meta">
          <span><Icon name="drone" size={12} /> {e.drone_code ?? '—'}</span>
          <Badge level={e.flight_type === 'controle' ? 'neutral' : 'info'}>{LABELS.flightType[e.flight_type]}</Badge>
          <Badge level={e.role === 'pilote' ? 'ok' : 'neutral'}>{e.role === 'pilote' ? 'Commandant de bord' : 'Copilote'}</Badge>
        </div>
      </div>
      <div className="ticket-cumul"><span>cumul</span><strong>{num(e.cumulative_hours, 1)}</strong><span>heures</span></div>
    </Link>
  );
}

// ---------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------
export default function PilotCockpit({ pilot: p, all, entries, year, years, setYear }: {
  pilot: PilotStatsRow; all: LogbookRow[]; entries: LogbookRow[]; year: string; years: string[]; setYear: (y: string) => void;
}) {
  const [view, setView] = useState<'cartes' | 'tableau'>('cartes');
  const [limit, setLimit] = useState(12);
  const career = Number(p.total_hours);
  const g = grade(career);

  const k = useMemo(() => {
    const flown = entries.reduce((s, e) => s + Number(e.duration_min), 0);
    const pic = entries.filter((e) => e.role === 'pilote').reduce((s, e) => s + Number(e.duration_min), 0);
    const longest = entries.reduce((m, e) => Math.max(m, Number(e.duration_min)), 0);
    const st = streaks(all.map((e) => e.entry_date));
    const dests = new Set(all.map((e) => e.destination_name).filter(Boolean)).size;
    const drones = new Set(all.map((e) => e.drone_code).filter(Boolean)).size;
    const picCount = all.filter((e) => e.role === 'pilote').length;
    const deliveries = all.filter((e) => e.flight_type === 'livraison').length;
    const early = all.filter((e) => e.takeoff_time < '07:00').length;
    const late = all.filter((e) => e.landing_time >= '17:30').length;
    const marathon = all.filter((e) => Number(e.duration_min) >= 60).length;
    const achievements: Achievement[] = [
      { key: 'first', icon: '🛫', title: 'Premier envol', desc: 'Premier vol au carnet', value: all.length, goal: 1 },
      // un palier par médaille : tous les paliers franchis + le prochain à atteindre
      ...milestonesUpTo(career).map((m) => ({ key: `h${m}`, ...hoursMedal(m), value: career, goal: m })),
      { key: 'del', icon: '📦', title: 'Messager', desc: '25 livraisons', value: deliveries, goal: 25 },
      { key: 'pic', icon: '🎖', title: 'Aux commandes', desc: '20 vols en commandant de bord', value: picCount, goal: 20 },
      { key: 'exp', icon: '🧭', title: 'Explorateur', desc: '5 destinations différentes', value: dests, goal: 5 },
      { key: 'multi', icon: '🛸', title: 'Polyvalent', desc: '3 drones différents pilotés', value: drones, goal: 3 },
      { key: 'streak', icon: '🔥', title: 'En série', desc: '5 jours de vol consécutifs', value: st.best, goal: 5 },
      { key: 'early', icon: '🌅', title: 'Lève-tôt', desc: 'Décollage avant 7 h', value: early, goal: 1 },
      { key: 'dusk', icon: '🌇', title: 'Crépuscule', desc: 'Atterrissage après 17 h 30', value: late, goal: 1 },
      { key: 'long', icon: '🏁', title: 'Endurance', desc: 'Un vol d\'au moins 1 h', value: marathon, goal: 1 },
    ];
    return { flown, pic, longest, st, dests, drones, achievements };
  }, [entries, all, career]);

  const instruments: { icon: IconName; label: string; value: React.ReactNode; sub: string }[] = [
    { icon: 'flight', label: 'Vols', value: <CountUp value={entries.length} />, sub: year ? `en ${year}` : 'au total' },
    { icon: 'clock', label: 'Temps de vol', value: hm(k.flown), sub: year ? `en ${year}` : 'inscrit au carnet' },
    { icon: 'shield', label: 'Commandant de bord', value: k.flown ? `${num((100 * k.pic) / k.flown, 0)} %` : '—', sub: hm(k.pic) },
    { icon: 'sparkle', label: 'Plus long vol', value: k.longest ? minutes(k.longest) : '—', sub: 'record personnel' },
    { icon: 'pin', label: 'Destinations', value: k.dests, sub: 'CSB différents' },
    { icon: 'trophy', label: 'Série', value: `${k.st.current} j`, sub: `record ${k.st.best} jour(s) d'affilée` },
  ];

  const shown = entries.slice(0, limit);
  const periodMin = entries.reduce((s, e) => s + Number(e.duration_min), 0);

  return (
    <div className="cockpit">
      {/* ---- Licence de pilote ---- */}
      <section className="license">
        <div className="license-bg" aria-hidden>
          <svg viewBox="0 0 600 200" preserveAspectRatio="none"><path className="contrail" d="M-20 170 C 120 120, 220 160, 330 90 S 520 40, 640 20" /></svg>
          <span className="license-drone"><Icon name="drone" size={22} /></span>
        </div>
        <div className="license-id">
          <div className="license-avatar"><span>{initials(p.full_name)}</span></div>
          <div className="license-who">
            <span className="license-kicker">Licence de télépilote · UAV Maintenance</span>
            <h2>{p.full_name}</h2>
            <div className="license-grade">
              <span className="stars" aria-label={`${g.stars} étoile(s)`}>{'★'.repeat(g.stars)}<span className="off">{'★'.repeat(5 - g.stars)}</span></span>
              <strong>{g.label}</strong>
            </div>
            <dl className="license-fields">
              <div><dt>Drone port</dt><dd>{p.drone_port_name ?? '—'}</dd></div>
              <div><dt>N° de licence</dt><dd>{p.license_number ?? '—'}</dd></div>
              <div><dt>Dernier vol</dt><dd>{date(p.last_flight_date)}</dd></div>
              <div><dt>Vols clôturés</dt><dd>{num(p.flight_count, 0)}</dd></div>
            </dl>
          </div>
        </div>
        <div className="license-perf" aria-hidden />
        <div className="license-alt">
          <Altimeter hours={career} />
          <div className="license-split">
            <span><i className="dot-pic" /> CdB {num(p.pic_hours)} h</span>
            <span><i className="dot-cop" /> Copilote {num(p.copilot_hours)} h</span>
            {Number(p.initial_flight_minutes) > 0 && <span><i className="dot-prev" /> Antérieures {num(Number(p.initial_flight_minutes) / 60)} h</span>}
          </div>
        </div>
      </section>

      {p.open_flight_count > 0 && (
        <Link to="/vols?statut=ouvert" className="alert alert-warn alert-link">
          ✎ {p.open_flight_count} vol(s) en attente de clôture : leurs heures seront inscrites au carnet à la clôture.
        </Link>
      )}

      {/* ---- Instruments ---- */}
      <div className="instruments">
        {instruments.map((x) => (
          <div key={x.label} className="instrument">
            <span className="instrument-icon"><Icon name={x.icon} size={18} /></span>
            <span className="instrument-label">{x.label}</span>
            <strong className="instrument-value">{x.value}</strong>
            <span className="instrument-sub">{x.sub}</span>
          </div>
        ))}
      </div>

      <section className="card">
          <div className="row-between">
            <h2 className="card-title">Activité de vol</h2>
            <label className="small">Année{' '}
              <select className="select-inline" value={year} onChange={(e) => setYear(e.target.value)}>
                <option value="">12 derniers mois</option>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </label>
          </div>
          <Heatmap entries={all} year={year} />
      </section>
      <Achievements items={k.achievements} />

      {/* ---- Vols ---- */}
      <section className="card">
        <div className="row-between">
          <div>
            <h2 className="card-title">Journal de bord</h2>
            <span className="small muted">{entries.length} vol(s) · {minutes(periodMin)}{year ? ` en ${year}` : ''}</span>
          </div>
          <div className="segmented segmented-sm" role="tablist" aria-label="Présentation">
            <button type="button" role="tab" aria-selected={view === 'cartes'} className={view === 'cartes' ? 'active' : ''} onClick={() => setView('cartes')}>Cartes d'embarquement</button>
            <button type="button" role="tab" aria-selected={view === 'tableau'} className={view === 'tableau' ? 'active' : ''} onClick={() => setView('tableau')}>Tableau</button>
          </div>
        </div>
        {entries.length === 0 ? <Empty>Aucun vol clôturé dans le carnet{year ? ` en ${year}` : ''}.</Empty> : view === 'cartes' ? (
          <>
            <div className="tickets">{shown.map((e) => <Ticket key={e.id} e={e} port={p.drone_port_name ?? 'Drone port'} />)}</div>
            {entries.length > limit && <div className="center" style={{ marginTop: 12 }}><button className="btn" onClick={() => setLimit(limit + 12)}>Afficher plus ({entries.length - limit})</button></div>}
          </>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Type</th><th>Drone</th><th>Destination</th><th>Décollage</th><th>Atterrissage</th><th>Durée</th><th>Fonction</th><th className="num">Cumul</th></tr></thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td><Link to={`/vols/${e.flight_id}`}>{date(e.entry_date)}</Link></td>
                    <td>{e.flight_type === 'controle' ? 'Contrôle' : 'Livraison'}</td>
                    <td><strong>{e.drone_code}</strong></td>
                    <td>{e.destination_name ?? <span className="muted">—</span>}</td>
                    <td>{time(e.takeoff_time)}</td><td>{time(e.landing_time)}</td><td>{minutes(e.duration_min)}</td>
                    <td><Badge level={e.role === 'pilote' ? 'info' : 'neutral'}>{LABELS.crewRole[e.role]}</Badge></td>
                    <td className="num"><strong>{num(e.cumulative_hours, 1)} h</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
