import { Fragment, ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

/* Graphiques SVG maison : marques fines (barres ≤ 24 px, extrémité arrondie 4 px, lignes 2 px),
   grille en filet, info-bulle au survol, tableau de données pour chaque graphique. */

const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
export const fmt = (v: number, digits = 1) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(v);
const compact = (v: number) => (Math.abs(v) >= 10000 ? `${nf.format(v / 1000)}k` : nf.format(v));

export interface Series { key: string; label: string; color: string }

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(320);
  useLayoutEffect(() => {
    if (!ref.current) return;
    setW(Math.max(260, Math.floor(ref.current.getBoundingClientRect().width)));
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Graduations « rondes » : 0, 5, 10… */
function niceTicks(maxValue: number, count = 4) {
  // au moins 0 → 4 : évite des graduations décimales (0,3 ; 0,5…) sur de petits effectifs
  const max = Math.max(maxValue, count);
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let t = 0; t <= max + step * 0.001; t += step) ticks.push(+t.toFixed(6));
  if (ticks[ticks.length - 1] < max) ticks.push(+(ticks[ticks.length - 1] + step).toFixed(6));
  return ticks;
}

function Tooltip({ x, containerWidth, children }: { x: number; containerWidth: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(x);
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth ?? 160;
    // à droite du curseur, sinon à gauche s'il n'y a pas la place
    let l = x + 12;
    if (l + w > containerWidth - 4) l = x - w - 12;
    setLeft(Math.max(0, l));
  }, [x, containerWidth]);
  return <div ref={ref} className="viz-tooltip" style={{ left }} role="status">{children}</div>;
}

export function TipRow({ color, label, value }: { color?: string; label: string; value: string }) {
  return (
    <div className="viz-tip-row">
      {color && <span className="viz-key-line" style={{ background: color }} />}
      <strong>{value}</strong>
      <span className="viz-tip-label">{label}</span>
    </div>
  );
}

export function Legend({ items, shape = 'rect' }: { items: Series[]; shape?: 'rect' | 'line' }) {
  return (
    <div className="viz-legend">
      {items.map((s) => (
        <span key={s.key} className="viz-legend-item">
          <span className={shape === 'line' ? 'viz-key-line' : 'viz-key-rect'} style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------
// Série temporelle (aire + ligne) avec réticule vertical
// ---------------------------------------------------------------------
export function TimeSeriesChart<T extends { date: string }>({ data, series, height = 220, tooltip, xLabel }: {
  data: T[];
  series: (Series & { value: (d: T) => number; area?: boolean })[];
  height?: number;
  tooltip: (d: T) => ReactNode;
  xLabel: (date: string) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const M = { top: 12, right: 12, bottom: 26, left: 36 };
  const iw = width - M.left - M.right, ih = height - M.top - M.bottom;
  const max = Math.max(1, ...data.flatMap((d) => series.map((s) => s.value(d))));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const x = (i: number) => M.left + (data.length <= 1 ? iw / 2 : (i * iw) / (data.length - 1));
  const y = (v: number) => M.top + ih - (v / top) * ih;
  // ~6 étiquettes sur l'axe des X
  const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 90))));

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = e.clientX - r.left;
    setHover(Math.max(0, Math.min(data.length - 1, Math.round((px / r.width) * (data.length - 1)))));
  };

  return (
    <div ref={ref} className="viz-wrap" onPointerLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label="Graphique temporel">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} className="viz-grid" />
            <text x={M.left - 6} y={y(t) + 4} textAnchor="end" className="viz-tick">{compact(t)}</text>
          </g>
        ))}
        {series.map((s) => {
          const pts = data.map((d, i) => `${x(i).toFixed(1)},${y(s.value(d)).toFixed(1)}`);
          return (
            <g key={s.key}>
              {s.area && <path d={`M${x(0)},${y(0)} L${pts.join(' L')} L${x(data.length - 1)},${y(0)} Z`} fill={s.color} opacity={0.1} />}
              <path d={`M${pts.join(' L')}`} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          );
        })}
        <line x1={M.left} x2={width - M.right} y1={y(0)} y2={y(0)} className="viz-axis" />
        {data.map((d, i) => (i % every === 0 ? (
          <text key={d.date} x={x(i)} y={height - 8} textAnchor="middle" className="viz-tick">{xLabel(d.date)}</text>
        ) : null))}
        {hover != null && <>
          <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + ih} className="viz-crosshair" />
          {series.map((s) => (
            <circle key={s.key} cx={x(hover)} cy={y(s.value(data[hover]))} r={4.5} fill={s.color} className="viz-dot" />
          ))}
        </>}
        <rect x={M.left} y={M.top} width={iw} height={ih} fill="transparent" onPointerMove={onMove} onPointerDown={onMove} />
      </svg>
      {hover != null && <Tooltip x={x(hover)} containerWidth={width}>{tooltip(data[hover])}</Tooltip>}
    </div>
  );
}

// ---------------------------------------------------------------------
// Colonnes (simples ou empilées) — chaque colonne est sa propre zone de survol
// ---------------------------------------------------------------------
export function ColumnChart<T extends { label: string }>({ data, series, height = 220, tooltip, labelMax = true }: {
  data: T[];
  series: (Series & { value: (d: T) => number })[];
  height?: number;
  tooltip: (d: T) => ReactNode;
  /** étiquette de valeur sur la colonne la plus haute uniquement */
  labelMax?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const M = { top: 18, right: 8, bottom: 26, left: 36 };
  const iw = width - M.left - M.right, ih = height - M.top - M.bottom;
  const totals = data.map((d) => series.reduce((s, se) => s + se.value(d), 0));
  const maxTotal = Math.max(0, ...totals);
  const ticks = niceTicks(Math.max(1, maxTotal));
  const top = ticks[ticks.length - 1];
  const band = iw / Math.max(1, data.length);
  const bw = Math.max(2, Math.min(24, band * 0.6));
  const y = (v: number) => M.top + ih - (v / top) * ih;
  const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 44))));
  const maxIdx = totals.indexOf(maxTotal);

  return (
    <div ref={ref} className="viz-wrap" onPointerLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label="Graphique en colonnes">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} className="viz-grid" />
            <text x={M.left - 6} y={y(t) + 4} textAnchor="end" className="viz-tick">{compact(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = M.left + band * i + band / 2;
          let acc = 0;
          const segs = series.map((s) => ({ s, v: s.value(d) })).filter((x) => x.v > 0);
          return (
            <g key={d.label} className={hover === i ? 'viz-col is-hover' : 'viz-col'}>
              {segs.map(({ s, v }, j) => {
                const y0 = y(acc), y1 = y(acc + v);
                acc += v;
                const isTop = j === segs.length - 1;
                const h = Math.max(0, y0 - y1 - (isTop ? 0 : 2)); // 2 px d'écart entre segments
                const r = isTop ? Math.min(4, h, bw / 2) : 0;
                const x0 = cx - bw / 2, yt = y1;
                // extrémité arrondie en haut, carrée à la base
                const path = `M${x0},${yt + h} L${x0},${yt + r} Q${x0},${yt} ${x0 + r},${yt} L${x0 + bw - r},${yt} Q${x0 + bw},${yt} ${x0 + bw},${yt + r} L${x0 + bw},${yt + h} Z`;
                return <path key={s.key} d={path} fill={s.color} />;
              })}
              {labelMax && i === maxIdx && maxTotal > 0 && (
                <text x={cx} y={y(totals[i]) - 5} textAnchor="middle" className="viz-value">{fmt(totals[i])}</text>
              )}
              {i % every === 0 && <text x={cx} y={height - 8} textAnchor="middle" className="viz-tick">{d.label}</text>}
              <rect x={M.left + band * i} y={M.top} width={band} height={ih} fill="transparent"
                tabIndex={0} aria-label={d.label}
                onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
            </g>
          );
        })}
        <line x1={M.left} x2={width - M.right} y1={y(0)} y2={y(0)} className="viz-axis" />
      </svg>
      {hover != null && <Tooltip x={M.left + band * hover + band / 2} containerWidth={width}>{tooltip(data[hover])}</Tooltip>}
    </div>
  );
}

// ---------------------------------------------------------------------
// Nuage de points + droite de tendance (moindres carrés)
// ---------------------------------------------------------------------
export function linearFit(pts: { x: number; y: number }[]) {
  const n = pts.length;
  if (n < 3) return null;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of pts) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; syy += (p.y - my) ** 2; }
  if (!sxx || !syy) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r: sxy / Math.sqrt(sxx * syy) };
}

export function ScatterChart<T>({ data, x, y, color, tooltip, xLabel, yLabel, height = 260, trend = true }: {
  data: T[]; x: (d: T) => number; y: (d: T) => number; color: (d: T) => string;
  tooltip: (d: T) => ReactNode; xLabel: string; yLabel: string; height?: number; trend?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const M = { top: 14, right: 14, bottom: 40, left: 48 };
  const iw = width - M.left - M.right, ih = height - M.top - M.bottom;
  const xs = data.map(x), ys = data.map(y);
  const xMin0 = Math.min(...xs), xMax0 = Math.max(...xs);
  const pad = (xMax0 - xMin0) * 0.05 || 1;
  const xMin = Math.max(0, xMin0 - pad), xMax = xMax0 + pad;
  const yTicks = niceTicks(Math.max(1, ...ys));
  const yTop = yTicks[yTicks.length - 1];
  const sx = (v: number) => M.left + ((v - xMin) / (xMax - xMin)) * iw;
  const sy = (v: number) => M.top + ih - (v / yTop) * ih;
  const xTickCount = Math.max(2, Math.floor(iw / 80));
  const xTicks = Array.from({ length: xTickCount + 1 }, (_, i) => xMin + ((xMax - xMin) * i) / xTickCount);
  const fit = trend ? linearFit(data.map((d) => ({ x: x(d), y: y(d) }))) : null;

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = e.clientX - r.left + M.left, py = e.clientY - r.top + M.top;
    let best = -1, bd = 24 ** 2;
    data.forEach((d, i) => { const dd = (sx(x(d)) - px) ** 2 + (sy(y(d)) - py) ** 2; if (dd < bd) { bd = dd; best = i; } });
    setHover(best >= 0 ? best : null);
  };

  return (
    <div ref={ref} className="viz-wrap" onPointerLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label={`Nuage de points : ${yLabel} selon ${xLabel}`}>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={width - M.right} y1={sy(t)} y2={sy(t)} className="viz-grid" />
            <text x={M.left - 6} y={sy(t) + 4} textAnchor="end" className="viz-tick">{compact(t)}</text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} x={sx(t)} y={M.top + ih + 16} textAnchor="middle" className="viz-tick">{fmt(t, xMax - xMin < 10 ? 1 : 0)}</text>
        ))}
        <text x={M.left + iw / 2} y={height - 4} textAnchor="middle" className="viz-tick viz-axis-label">{xLabel}</text>
        <line x1={M.left} x2={width - M.right} y1={sy(0)} y2={sy(0)} className="viz-axis" />
        {fit && (
          <line x1={sx(xMin)} y1={sy(Math.max(0, fit.intercept + fit.slope * xMin))} x2={sx(xMax)} y2={sy(Math.max(0, fit.intercept + fit.slope * xMax))}
            className="viz-trend" />
        )}
        {data.map((d, i) => (
          <circle key={i} cx={sx(x(d))} cy={sy(y(d))} r={hover === i ? 6 : 4.5} fill={color(d)} className="viz-point" opacity={hover == null || hover === i ? 0.9 : 0.45} />
        ))}
        <rect x={M.left} y={M.top} width={iw} height={ih} fill="transparent" onPointerMove={onMove} onPointerDown={onMove} />
      </svg>
      {hover != null && <Tooltip x={sx(x(data[hover]))} containerWidth={width}>{tooltip(data[hover])}</Tooltip>}
    </div>
  );
}

// ---------------------------------------------------------------------
// Calendrier d'activité : une case par jour, intensité selon la valeur
// ---------------------------------------------------------------------
const CAL_MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
export function CalendarHeatmap({ days, title }: {
  /** une entrée par jour de la période (ordre chronologique, dates ISO) */
  days: { date: string; value: number }[];
  title: (d: { date: string; value: number }) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth; }, [days.length]);
  if (!days.length) return null;
  const max = Math.max(1, ...days.map((d) => d.value));
  const dow = (s: string) => (new Date(`${s}T12:00:00`).getDay() + 6) % 7; // lundi = 0
  // semaines (colonnes) : on complète la première semaine avec des cases vides
  const weeks: ({ date: string; value: number } | null)[][] = [[]];
  for (let i = 0; i < dow(days[0].date); i++) weeks[0].push(null);
  for (const d of days) {
    if (weeks[weeks.length - 1].length === 7) weeks.push([]);
    weeks[weeks.length - 1].push(d);
  }
  const level = (v: number) => (v <= 0 ? 0 : v / max > 0.75 ? 4 : v / max > 0.5 ? 3 : v / max > 0.25 ? 2 : 1);
  return (
    <div className="calhm-wrap" ref={ref}>
      <div className="calhm" style={{ gridTemplateColumns: `26px repeat(${weeks.length}, 14px)` }} role="img" aria-label="Calendrier d'activité">
        <span />
        {weeks.map((w, i) => {
          // le nom du mois s'affiche sur la semaine qui contient le 1er (ou sur la première semaine affichée)
          const firstOfMonth = w.find((d) => d && d.date.endsWith('-01'));
          const ref = firstOfMonth ?? (i === 0 ? w.find(Boolean) : null);
          const label = ref ? CAL_MONTHS[Number(ref.date.slice(5, 7)) - 1] : '';
          return <span key={`m${i}`} className="calhm-month">{label}</span>;
        })}
        {[0, 1, 2, 3, 4, 5, 6].map((r) => (
          <Fragment key={r}>
            <span key={`d${r}`} className="calhm-day">{r === 0 ? 'lun' : r === 2 ? 'mer' : r === 4 ? 'ven' : ''}</span>
            {weeks.map((w, i) => {
              const d = w[r];
              return <span key={`c${r}-${i}`} className={`calhm-cell${d ? ` l${level(d.value)}` : ' empty'}`} title={d ? title(d) : undefined} />;
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Barres horizontales étiquetées (classements)
// ---------------------------------------------------------------------
export function BarList({ data, color, format = (v) => fmt(v), sub, max: maxRows = 10 }: {
  data: { label: string; value: number }[];
  color: string;
  format?: (v: number) => string;
  sub?: (label: string) => string | null;
  max?: number;
}) {
  const rows = data.slice(0, maxRows);
  const rest = data.slice(maxRows);
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="viz-barlist">
      {rows.map((r) => (
        <div key={r.label} className="viz-barlist-row" title={`${r.label} : ${format(r.value)}`}>
          <div className="viz-barlist-label">
            <span>{r.label}</span>
            {sub?.(r.label) && <span className="muted small">{sub(r.label)}</span>}
          </div>
          <div className="viz-barlist-track">
            <div className="viz-barlist-bar" style={{ width: `${(100 * r.value) / max}%`, background: color }} />
            <span className="viz-barlist-value">{format(r.value)}</span>
          </div>
        </div>
      ))}
      {rest.length > 0 && (
        <div className="muted small">+ {rest.length} autre(s) · {format(rest.reduce((s, r) => s + r.value, 0))}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Barre segmentée (une part du tout, ≤ 6 parts)
// ---------------------------------------------------------------------
export function SegmentedBar({ parts }: { parts: (Series & { value: number })[] }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const [hover, setHover] = useState<string | null>(null);
  if (!total) return <div className="muted small">Aucune donnée</div>;
  return (
    <div>
      <div className="viz-seg" role="img" aria-label={parts.map((p) => `${p.label} ${fmt((100 * p.value) / total, 0)} %`).join(', ')}>
        {parts.filter((p) => p.value > 0).map((p) => {
          const pct = (100 * p.value) / total;
          return (
            <div key={p.key} className={`viz-seg-part${hover === p.key ? ' is-hover' : ''}`} style={{ flexGrow: p.value, background: p.color }}
              title={`${p.label} : ${fmt(p.value, 0)} (${fmt(pct, 0)} %)`} tabIndex={0}
              onPointerEnter={() => setHover(p.key)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(p.key)} onBlur={() => setHover(null)}>
              {pct >= 12 && <span>{fmt(pct, 0)} %</span>}
            </div>
          );
        })}
      </div>
      <div className="viz-legend">
        {parts.map((p) => (
          <span key={p.key} className="viz-legend-item">
            <span className="viz-key-rect" style={{ background: p.color }} />
            {p.label} <span className="muted">· {fmt(p.value, 0)}{(100 * p.value) / total < 12 && p.value > 0 ? ` (${fmt((100 * p.value) / total, 0)} %)` : ''}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Carte de graphique avec bascule « Tableau » (accès aux valeurs sans survol)
// ---------------------------------------------------------------------
export function ChartCard({ title, subtitle, legend, table, children, wide }: {
  title: string; subtitle?: ReactNode; legend?: ReactNode; wide?: boolean;
  table?: { columns: string[]; rows: (string | number)[][] };
  children: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  useEffect(() => { setShowTable(false); }, [title]);
  return (
    <section className={`card viz-card${wide ? ' viz-card-wide' : ''}`}>
      <div className="row-between">
        <div>
          <h2 className="card-title">{title}</h2>
          {subtitle && <div className="muted small">{subtitle}</div>}
        </div>
        {table && (
          <button type="button" className="btn btn-ghost btn-sm" aria-pressed={showTable} onClick={() => setShowTable(!showTable)}>
            {showTable ? 'Graphique' : 'Tableau'}
          </button>
        )}
      </div>
      {legend && !showTable && legend}
      {showTable && table ? (
        <div className="table-wrap viz-table">
          <table>
            <thead><tr>{table.columns.map((c, i) => <th key={c} className={i ? 'num' : ''}>{c}</th>)}</tr></thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j} className={j ? 'num' : ''}>{typeof c === 'number' ? fmt(c) : c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : children}
    </section>
  );
}
