import { ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { cardinal, date } from '../lib/format';
import { flightVerdict, useWeather, Weather, weatherIcon, weatherText, WEATHER_LIMITS } from '../lib/dashboard';
import { buildMetar, CAT_FR, decodeCells, flightCategory, metarTokens, stationId } from '../lib/metar';
import type { DronePort } from '../lib/types';
import { fmt } from './charts';
import { Icon, IconName } from './icons';

// ---------------------------------------------------------------------
// Courbe miniature (tendance)
// ---------------------------------------------------------------------
export function Sparkline({ values, color = 'var(--series-1)', height = 34 }: { values: number[]; color?: string; height?: number }) {
  const w = 120, h = height, n = values.length;
  const max = Math.max(1, ...values);
  if (n < 2) return null;
  const pts = values.map((v, i) => `${((i / (n - 1)) * w).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`);
  return (
    <svg className="sparkline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <path d={`M0,${h} L${pts.join(' L')} L${w},${h} Z`} fill={color} opacity={0.12} />
      <path d={`M${pts.join(' L')}`} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Variation en % (ou en points) par rapport à la période précédente */
export function Trend({ cur, prev, goodWhenUp = true, pts = false }: { cur: number | null; prev: number | null; goodWhenUp?: boolean; pts?: boolean }) {
  if (cur == null || prev == null) return null;
  const d = pts ? cur - prev : prev === 0 ? (cur === 0 ? 0 : null) : (100 * (cur - prev)) / prev;
  if (d == null) return <span className="stat-delta flat">nouveau</span>;
  if (Math.abs(d) < (pts ? 0.05 : 0.5)) return <span className="stat-delta flat">= stable</span>;
  const good = d > 0 === goodWhenUp;
  return <span className={`stat-delta ${good ? 'up' : 'down'}`}>{d > 0 ? '▲' : '▼'} {fmt(Math.abs(d), pts ? 1 : 0)}{pts ? ' pt' : ' %'}</span>;
}

export function TrendTile({ label, value, unit, cur, prev, series, goodWhenUp = true, pts = false, sub, color }: {
  label: string; value: string; unit?: string; cur: number | null; prev: number | null; series: number[];
  goodWhenUp?: boolean; pts?: boolean; sub?: ReactNode; color?: string;
}) {
  return (
    <div className="stat trend-tile">
      <div className="stat-label">{label}</div>
      <div className="trend-row">
        <div className="stat-value">{value}{unit && <span className="stat-unit"> {unit}</span>}</div>
        <Sparkline values={series} color={color} />
      </div>
      <div className="stat-sub"><Trend cur={cur} prev={prev} goodWhenUp={goodWhenUp} pts={pts} /> <span className="muted">{sub ?? 'vs 30 jours précédents'}</span></div>
    </div>
  );
}

// ---------------------------------------------------------------------
// « À faire »
// ---------------------------------------------------------------------
export interface ActionItem { key: string; level: 'danger' | 'warn' | 'info'; icon: IconName; count: number; label: string; to: string }

export function ActionCenter({ items }: { items: ActionItem[] }) {
  const list = items.filter((i) => i.count > 0);
  const order = { danger: 0, warn: 1, info: 2 };
  list.sort((a, b) => order[a.level] - order[b.level]);
  return (
    <section className="card action-center">
      <div className="row-between">
        <h2 className="card-title">À faire</h2>
        <span className="small muted">{list.length ? `${list.reduce((s, i) => s + i.count, 0)} élément(s)` : ''}</span>
      </div>
      {list.length === 0 ? (
        <div className="action-ok"><Icon name="shield" size={20} /> Rien en attente : tout est à jour.</div>
      ) : (
        <div className="action-grid">
          {list.map((i) => (
            <Link key={i.key} to={i.to} className={`action-item level-${i.level}`}>
              <span className="action-icon"><Icon name={i.icon} size={18} /></span>
              <strong className="action-count">{i.count}</strong>
              <span className="action-label">{i.label}</span>
              <span className="action-go" aria-hidden>→</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------
// Météo du jour par drone port
// ---------------------------------------------------------------------
/** Bloc METAR / TAF d'un drone port (texte monospace, décodage au survol, copie) */
function AviationBlock({ name, w, verdict }: { name: string; w: Weather; verdict: { level: string; label: string } }) {
  const [copied, setCopied] = useState(false);
  const id = stationId(name);
  const tokens = metarTokens(id, w.av.now, w.av.offset);
  const metar = buildMetar(id, w.av.now, w.av.offset);
  const cat = flightCategory(w.av.now);
  const cells = decodeCells(w.av.now);
  const copy = () => {
    navigator.clipboard?.writeText(metar).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => { /* presse-papiers indisponible */ });
  };
  return (
    <div className={`weather-port av-port cat-${cat}`}>
      <div className="weather-head">
        <span className={`av-cat cat-${cat}`} title={`Catégorie de vol ${cat} : ${CAT_FR[cat]}`}>{cat}</span>
        <div className="weather-main"><strong>{name}</strong><span className="small muted">{weatherText(w.current.code)} · {CAT_FR[cat]}</span></div>
        <span className={`verdict verdict-${verdict.level}`}>{verdict.label}</span>
      </div>
      <div className="av-strip">
        <div className="av-tokens" aria-label={metar}>
          {tokens.map((t, i) => <span key={i} className={`av-tok k-${t.kind}${t.level ? ` lv-${t.level}` : ''}`} title={t.title}>{t.t}</span>)}
          <span className="av-tok k-head">=</span>
        </div>
        <button type="button" className="av-copy" onClick={copy} title="Copier le METAR">{copied ? '✓' : '⧉'}</button>
      </div>
      <dl className="av-cells">
        {cells.slice(0, 3).map((c) => <div key={c.label} title={c.sub}><dt>{c.label}</dt><dd>{c.value}</dd><span>{c.sub}</span></div>)}
      </dl>
    </div>
  );
}

const WX_VIEW_KEY = 'uav.weatherView';

export function WeatherPanel({ ports, qrfWind, compact = false }: { ports: DronePort[]; qrfWind: number | null; compact?: boolean }) {
  const state = useWeather(ports);
  const [view, setView] = useState<'simple' | 'aviation'>(() => { try { return localStorage.getItem(WX_VIEW_KEY) === 'aviation' ? 'aviation' : 'simple'; } catch { return 'simple'; } });
  const pickView = (v: 'simple' | 'aviation') => { setView(v); try { localStorage.setItem(WX_VIEW_KEY, v); } catch { /* stockage indisponible */ } };
  const missing = ports.filter((p) => p.latitude == null || p.longitude == null);
  const located = ports.filter((p) => p.latitude != null && p.longitude != null);
  return (
    <section className="card weather-card">
      <div className="row-between">
        <h2 className="card-title">Météo de vol</h2>
        <div className="segmented segmented-sm" role="tablist" aria-label="Affichage météo">
          <button type="button" role="tab" aria-selected={view === 'simple'} className={view === 'simple' ? 'active' : ''} onClick={() => pickView('simple')}>Simple</button>
          <button type="button" role="tab" aria-selected={view === 'aviation'} className={view === 'aviation' ? 'active' : ''} onClick={() => pickView('aviation')}>METAR</button>
        </div>
      </div>
      <span className="small muted">Open-Meteo · seuils {WEATHER_LIMITS.windOk}/{WEATHER_LIMITS.windMax} m/s</span>
      {located.length === 0 && (
        <div className="muted small">Renseignez la latitude et la longitude de vos drone ports (<Link to="/drone-ports">Drone ports</Link>) pour afficher la météo.</div>
      )}
      <div className="weather-list">
        {located.map((p) => {
          const s = state[p.id];
          if (!s) return <div key={p.id} className="weather-port skeleton-line">{p.name} · chargement…</div>;
          if (s.error || !s.w) return <div key={p.id} className="weather-port muted small">{p.name} : {s.error ?? 'indisponible'}</div>;
          const c = s.w.current;
          const v = flightVerdict({ wind: c.wind, gust: c.gust, code: c.code });
          if (view === 'aviation') return <AviationBlock key={p.id} name={p.name} w={s.w} verdict={v} />;
          // première heure défavorable ou limite dans les 12 h
          const next = s.w.hours.find((h) => flightVerdict(h).level !== 'ok');
          return (
            <div key={p.id} className="weather-port">
              <div className="weather-head">
                <span className="weather-icon" aria-hidden>{weatherIcon(c.code)}</span>
                <div className="weather-main">
                  <strong>{p.name}</strong>
                  <span className="small muted">{weatherText(c.code)} · {fmt(c.temp, 0)} °C</span>
                </div>
                <span className={`verdict verdict-${v.level}`}>{v.label}</span>
              </div>
              <div className="weather-now">
                <div><span>Vent</span><strong>{fmt(c.wind)} m/s</strong><em>{cardinal(c.dir)}</em></div>
                <div><span>Rafales</span><strong>{fmt(c.gust)} m/s</strong></div>
                <div><span>Pluie</span><strong>{fmt(c.precip)} mm</strong></div>
              </div>
              {!compact && (
                <div className="weather-hours" role="img" aria-label="Prévisions heure par heure">
                  {s.w.hours.map((h) => {
                    const hv = flightVerdict(h);
                    return (
                      <div key={h.time} className={`wh wh-${hv.level}`} title={`${h.time.slice(11, 16)} : vent ${fmt(h.wind)} m/s, rafales ${fmt(h.gust)} m/s, pluie ${h.rainProb} % · ${hv.label}${hv.why.length ? ` (${hv.why.join(', ')})` : ''}`}>
                        <span className="wh-time">{h.time.slice(11, 13)}h</span>
                        <span className="wh-bar" style={{ height: `${Math.min(100, (100 * h.wind) / (WEATHER_LIMITS.windMax * 1.4))}%` }} />
                        <span className="wh-val">{fmt(h.wind, 0)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="small muted">
                {v.why.length ? `Maintenant : ${v.why.join(', ')}. ` : ''}
                {next ? `${flightVerdict(next).label} à partir de ${next.time.slice(11, 16)}.` : 'Conditions favorables sur les 12 prochaines heures.'}
              </div>
            </div>
          );
        })}
      </div>
      {view === 'aviation' && located.length > 0 && (
        <div className="av-disclaimer"><Icon name="alert" size={13} /><span>METAR généré à partir du modèle Open-Meteo, au format OACI : indicatif, <strong>non officiel</strong>, bases nuageuses estimées. Survolez chaque groupe pour le décoder. Pour préparer le vol, consultez aussi les METAR officiels des aérodromes voisins.</span></div>
      )}
      {missing.length > 0 && located.length > 0 && <div className="small muted">Sans coordonnées : {missing.map((p) => p.name).join(', ')}.</div>}
      {qrfWind != null && <div className="small muted weather-qrf">Repère : vent moyen lors de vos QRF météo = <strong>{fmt(qrfWind)} m/s</strong>.</div>}
    </section>
  );
}

// ---------------------------------------------------------------------
// Fil d'activité
// ---------------------------------------------------------------------
export interface FeedItem { at: string; kind: string; title: string; detail: string | null; link: string | null }
const FEED_ICON: Record<string, IconName> = {
  vol: 'flight', cloture: 'book', incident: 'alert', rapport: 'wrench', rapport_clos: 'shield', signature: 'pen',
  piece: 'chip', batterie: 'battery', visite: 'drone',
};
function ago(at: string) {
  const s = (Date.now() - new Date(at).getTime()) / 1000;
  if (s < 60) return 'à l\'instant';
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  if (s < 7 * 86400) return `il y a ${Math.floor(s / 86400)} j`;
  return date(at.slice(0, 10));
}
/** Carte à onglets (dernier onglet ouvert mémorisé) */
export function TabbedCard({ id, title, tabs }: {
  id: string; title: string;
  tabs: { key: string; label: string; count?: number; level?: 'warn' | 'danger'; link?: { to: string; label: string }; content: ReactNode }[];
}) {
  const storeKey = `uav.tab.${id}`;
  const [active, setActive] = useState(() => { try { return localStorage.getItem(storeKey) ?? tabs[0].key; } catch { return tabs[0].key; } });
  const cur = tabs.find((t) => t.key === active) ?? tabs[0];
  const pick = (k: string) => { setActive(k); try { localStorage.setItem(storeKey, k); } catch { /* stockage indisponible */ } };
  return (
    <section className="card tabbed-card">
      <div className="tabbed-head">
        <h2 className="card-title">{title}</h2>
        {cur.link && <Link to={cur.link.to} className="small">{cur.link.label}</Link>}
      </div>
      <div className="tabbed-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={t.key === cur.key} className={t.key === cur.key ? 'active' : ''} onClick={() => pick(t.key)}>
            {t.label}{t.count != null && t.count > 0 && <span className={`tabbed-count${t.level ? ` lv-${t.level}` : ''}`}>{t.count}</span>}
          </button>
        ))}
      </div>
      <div className="tabbed-body" role="tabpanel">{cur.content}</div>
    </section>
  );
}

export function ActivityFeed({ items, limit = 12 }: { items: FeedItem[]; limit?: number }) {
  return (
    <section className="card feed-card">
      <h2 className="card-title">Activité récente</h2>
      {items.length === 0 ? <div className="muted small">Aucune activité sur les 60 derniers jours.</div> : (
        <ol className="feed">
          {items.slice(0, limit).map((e, i) => {
            const body = <>
              <span className={`feed-icon feed-${e.kind}`} aria-hidden><Icon name={FEED_ICON[e.kind] ?? 'sparkle'} size={14} /></span>
              <span className="feed-body"><strong>{e.title}</strong>{e.detail && <span className="small muted">{e.detail}</span>}</span>
              <time className="small muted" dateTime={e.at} title={new Date(e.at).toLocaleString('fr-FR')}>{ago(e.at)}</time>
            </>;
            return <li key={i}>{e.link ? <Link to={e.link} className="feed-item">{body}</Link> : <div className="feed-item">{body}</div>}</li>;
          })}
        </ol>
      )}
    </section>
  );
}
