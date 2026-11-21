import { forwardRef } from 'react';
import type { WindpathRecord, WindpathRecordPoint } from '../lib/windpath';
import UavLogo from './UavLogo';

/**
 * Rapport de vol WindPath : annexe du CRM (même feuille A4, même PDF).
 * Construit à partir de la mission conservée avec le vol (flight_windpath_records) :
 * route, bilan prévu / réel, points de passage, courbes de consommation et de tension.
 * « ≈ » signale une valeur appliquée automatiquement (point non saisi pendant le vol).
 */

export interface WindpathReportFlight {
  /** absent : rapport imprimé depuis la planification, avant l'enregistrement du vol */
  crmNo?: string | null;
  droneCode: string;
  flightDate: string;   // AAAA-MM-JJ
  takeoffTime: string;  // HH:MM[:SS]
  destination: string | null;
  pilots: string[];
  portName: string | null;
  /** valeurs enregistrées dans le vol (fiche) */
  consumptionMah: number | null;
  voltageEndV: number | null;
}

const PHASE_FR: Record<string, string> = {
  Takeoff: 'Décollage', Climbing: 'Montée', Cruise: 'Croisière', Dropping: 'Largage', Descending: 'Descente', Landing: 'Atterrissage',
};
const nf = (v: number | null | undefined, d = 0) => (v == null ? '—' : v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }));
const hhmm = (ts: number | null | undefined) => {
  if (ts == null) return '—';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const hhmmss = (ts: number | null | undefined) => {
  if (ts == null) return '—';
  const d = new Date(ts);
  return `${hhmm(ts)}:${String(d.getSeconds()).padStart(2, '0')}`;
};
const signed = (v: number | null, unit: string, d = 0) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${nf(Math.abs(v), d)} ${unit}`);
const gapMin = (ms: number | null) => {
  if (ms == null) return '—';
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 30) return 'à l\'heure';
  const m = Math.floor(s / 60);
  return `${ms > 0 ? '+' : '−'}${m ? `${m} min ` : ''}${String(s % 60).padStart(2, '0')} s`;
};
const Auto = ({ on }: { on: boolean }) => (on ? <span className="wp-auto" title="Estimation appliquée automatiquement (point non saisi)">≈</span> : null);

function Box({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`crm-box ${className}`}>
      <h2 className="crm-box-title">{title}</h2>
      {children}
    </section>
  );
}
function Cells({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <div className="crm-cells">
      {items.map(([k, v]) => <div key={k} className="crm-cell"><span className="crm-label">{k}</span><span className="crm-value">{v}</span></div>)}
    </div>
  );
}

/** Route dessinée à l'échelle (projection locale), avec la partie volée, le largage, le nord et une échelle */
function RouteMap({ points }: { points: WindpathRecordPoint[] }) {
  const pts = points.filter((p) => p.lat != null && p.lon != null) as (WindpathRecordPoint & { lat: number; lon: number })[];
  if (pts.length < 2) return <p className="crm-muted wp-empty">Route indisponible.</p>;
  const W = 700, H = 250, PAD = 34;
  const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xs = pts.map((p) => p.lon * k), ys = pts.map((p) => p.lat);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const span = Math.max(x1 - x0, (y1 - y0) * ((W - 2 * PAD) / (H - 2 * PAD)), 1e-4);
  const scale = (W - 2 * PAD) / span;
  const ox = PAD + ((W - 2 * PAD) - (x1 - x0) * scale) / 2, oy = PAD + ((H - 2 * PAD) - (y1 - y0) * scale) / 2;
  const P = (p: { lat: number; lon: number }) => [ox + (p.lon * k - x0) * scale, H - (oy + (p.lat - y0) * scale)] as const;
  // échelle : 1 degré de latitude ≈ 111,32 km
  const mPerPx = 111320 / scale;
  const nice = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000].find((m) => m / mPerPx >= 70) ?? 50000;
  const barPx = nice / mPerPx;
  // points superposés (aller-retour, décollage vertical) : une seule étiquette
  const labelled = new Set<string>();
  return (
    <svg className="wp-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Route du vol">
      <rect x="0" y="0" width={W} height={H} fill="#f6f8fb" />
      <polyline points={pts.map((p) => P(p).join(',')).join(' ')} fill="none" stroke="#2b6fd6" strokeWidth="2" strokeDasharray="6 5" />
      {pts.slice(1).map((p, i) => {
        const a = pts[i];
        if (a.pass == null || p.pass == null) return null;
        const [ax, ay] = P(a), [bx, by] = P(p);
        return <line key={`f${i}`} x1={ax} y1={ay} x2={bx} y2={by} stroke="#1f9d5c" strokeWidth="4" strokeLinecap="round" opacity={p.passAuto ? 0.55 : 1} />;
      })}
      {pts.map((p, i) => {
        const [x, y] = P(p);
        const key = `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
        const showLabel = !labelled.has(key);
        labelled.add(key);
        const home = i === 0;
        // point au même endroit qu'un précédent (décollage vertical, retour au drone port) : déjà dessiné
        if (!showLabel && !p.drop) return null;
        return (
          <g key={i}>
            {p.drop ? <rect x={x - 6} y={y - 6} width="12" height="12" transform={`rotate(45 ${x} ${y})`} fill="#f0a020" stroke="#7a4a00" strokeWidth="1.5" />
              : home ? <rect x={x - 7} y={y - 7} width="14" height="14" rx="3" fill="#1d2b44" />
              : <circle cx={x} cy={y} r="5" fill={p.pass != null ? '#1f9d5c' : '#ffffff'} stroke="#2b6fd6" strokeWidth="2" />}
            {home && <text x={x} y={y + 3.5} textAnchor="middle" fontSize="9" fontWeight="800" fill="#fff">H</text>}
            {showLabel && !home && <text x={x + 9} y={y - 7} fontSize="10" fontWeight="700" fill="#1d2b44">{p.drop ? `${p.n} · largage` : p.n}</text>}
            {showLabel && p.windMs != null && p.windDir != null && (
              <g transform={`translate(${x - 16} ${y + 16}) rotate(${p.windDir + 180})`}>
                <line x1="0" y1="6" x2="0" y2="-6" stroke="#5a6b85" strokeWidth="1.4" />
                <path d="M0 -8 L-3 -3 L3 -3 Z" fill="#5a6b85" />
              </g>
            )}
            {showLabel && p.windMs != null && <text x={x - 6} y={y + 30} fontSize="8.5" fill="#5a6b85">{nf(p.windMs, 1)} m/s</text>}
          </g>
        );
      })}
      <g transform={`translate(${W - 26} 30)`}>
        <path d="M0 -14 L6 4 L0 0 L-6 4 Z" fill="#1d2b44" />
        <text x="0" y="16" textAnchor="middle" fontSize="10" fontWeight="800" fill="#1d2b44">N</text>
      </g>
      <g transform={`translate(14 ${H - 14})`}>
        <line x1="0" y1="0" x2={barPx} y2="0" stroke="#1d2b44" strokeWidth="2" />
        <line x1="0" y1="-4" x2="0" y2="4" stroke="#1d2b44" strokeWidth="2" />
        <line x1={barPx} y1="-4" x2={barPx} y2="4" stroke="#1d2b44" strokeWidth="2" />
        <text x={barPx + 6} y="4" fontSize="10" fill="#1d2b44">{nice >= 1000 ? `${nice / 1000} km` : `${nice} m`}</text>
      </g>
    </svg>
  );
}

/** Courbe prévue (trait) et relevés réels (points) par point de passage */
function Chart({ title, unit, est, real, auto, color, digits = 0 }: {
  title: string; unit: string; est: (number | null)[]; real: (number | null)[]; auto: boolean[]; color: string; digits?: number;
}) {
  const W = 340, H = 150, L = 44, R = 10, T = 22, B = 22;
  const vals = [...est, ...real].filter((v): v is number => v != null);
  if (!vals.length) return <div className="wp-chart"><b>{title}</b><p className="crm-muted wp-empty">Pas de données.</p></div>;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const n = Math.max(est.length, real.length);
  const X = (i: number) => L + (n <= 1 ? 0 : (i * (W - L - R)) / (n - 1));
  const Y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const line = est.map((v, i) => (v == null ? null : `${X(i)},${Y(v)}`)).filter(Boolean).join(' ');
  return (
    <div className="wp-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
        <text x={L} y="12" fontSize="10" fontWeight="700" fill="#1d2b44">{title}</text>
        <text x={W - R} y="12" textAnchor="end" fontSize="8.5" fill="#5a6b85">— prévu · ● réel · ○ ≈ auto</text>
        {[lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1].map((t, i) => (
          <g key={i}>
            <line x1={L} x2={W - R} y1={Y(t)} y2={Y(t)} stroke="#e3e8ef" />
            <text x={L - 4} y={Y(t) + 3} textAnchor="end" fontSize="8.5" fill="#5a6b85">{nf(t, digits)}{unit === 'V' ? ' V' : ''}</text>
          </g>
        ))}
        <polyline points={line} fill="none" stroke={color} strokeWidth="2" />
        {real.map((v, i) => (v == null ? null
          : <circle key={i} cx={X(i)} cy={Y(v)} r="3.5" fill={auto[i] ? '#ffffff' : '#1f9d5c'} stroke="#1f9d5c" strokeWidth="1.6" />))}
      </svg>
    </div>
  );
}

const WindpathReport = forwardRef<HTMLElement, { record: WindpathRecord; flight: WindpathReportFlight }>(function WindpathReport({ record, flight }, ref) {
  const pts = record.points;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const drop = pts.find((p) => p.drop) ?? null;
  const lastReal = [...pts].reverse().find((p) => p.realCumMah != null) ?? null;
  const lastRealV = [...pts].reverse().find((p) => p.realV != null) ?? null;
  const realMah = flight.consumptionMah ?? lastReal?.realCumMah ?? null;
  const realMahAuto = flight.consumptionMah == null && Boolean(lastReal?.mahAuto);
  const estMah = record.summary.estimatedMah ?? last?.estCumMah ?? null;
  const realV = flight.voltageEndV ?? lastRealV?.realV ?? null;
  const realVAuto = flight.voltageEndV == null && Boolean(lastRealV?.vAuto);
  const estV = record.summary.finalVoltage ?? last?.estV ?? null;
  const durEst = first?.eta != null && last?.eta != null ? (last.eta - first.eta) / 60000 : null;
  const durReal = first?.pass != null && last?.pass != null ? (last.pass - first.pass) / 60000 : null;
  const hasAuto = pts.some((p) => p.passAuto || p.mahAuto || p.vAuto);
  const [y, m, d] = flight.flightDate.split('-');

  const rows: { label: string; est: React.ReactNode; real: React.ReactNode; gap: React.ReactNode }[] = [
    { label: 'Décollage', est: hhmm(first?.eta), real: <>{hhmmss(first?.pass)}<Auto on={Boolean(first?.passAuto)} /></>, gap: first?.pass != null && first?.eta != null ? gapMin(first.pass - first.eta) : '—' },
    ...(drop ? [{ label: `Largage (point ${drop.n})`, est: hhmm(drop.eta), real: <>{hhmmss(drop.pass)}<Auto on={drop.passAuto} /></>, gap: drop.pass != null && drop.eta != null ? gapMin(drop.pass - drop.eta) : '—' }] : []),
    { label: 'Atterrissage', est: hhmm(last?.eta), real: <>{hhmmss(last?.pass)}<Auto on={Boolean(last?.passAuto)} /></>, gap: last?.pass != null && last?.eta != null ? gapMin(last.pass - last.eta) : '—' },
    { label: 'Durée', est: durEst == null ? '—' : `${nf(durEst)} min`, real: durReal == null ? '—' : `${nf(durReal)} min`, gap: durEst != null && durReal != null ? signed(durReal - durEst, 'min') : '—' },
    { label: 'Consommation', est: estMah == null ? '—' : `${nf(estMah)} mAh`, real: <>{realMah == null ? '—' : `${nf(realMah)} mAh`}<Auto on={realMahAuto} /></>,
      gap: estMah != null && realMah != null ? <>{signed(realMah - estMah, 'mAh')} ({signed(((realMah - estMah) / estMah) * 100, '%', 1)})</> : '—' },
    { label: 'Tension finale', est: estV == null ? '—' : `${nf(estV, 2)} V`, real: <>{realV == null ? '—' : `${nf(realV, 2)} V`}<Auto on={realVAuto} /></>, gap: estV != null && realV != null ? signed(realV - estV, 'V', 2) : '—' },
  ];

  return (
    <article ref={ref} className="crm-sheet wp-sheet">
      <header className="crm-head">
        <UavLogo className="crm-logo" />
        <div className="crm-head-title">
          <div className="crm-org">UNFPA Madagascar · Livraison par drones</div>
          <h1>Rapport de vol WindPath</h1>
          <div className="crm-sub">{flight.crmNo ? `Annexe au CRM ${flight.crmNo}` : 'Rapport de mission'} · {record.missionName ?? 'mission sans nom'}</div>
        </div>
        <div className="crm-no">
          <span className="crm-label">Vol</span>
          <strong>{flight.droneCode}</strong>
          <span className="crm-label">{`${d}/${m}/${y}`} · {flight.takeoffTime.slice(0, 5)}</span>
        </div>
      </header>

      <Box title="1 · Mission">
        <Cells items={[
          ['Destination', flight.destination ?? '—'],
          ['Drone port', flight.portName ?? '—'],
          ['Équipage', flight.pilots.join(', ') || '—'],
          ['Points · distance', `${pts.length} pts · ${nf(record.summary.distanceKm, 1)} km`],
          ['Charge', record.payloadKg == null ? '—' : `${nf(record.payloadKg, 2)} kg`],
          ['Batterie', record.capacityMah == null ? '—' : `${nf(record.capacityMah)} mAh`],
          ['Tension de départ', record.departureVoltage == null ? '—' : `${nf(record.departureVoltage, 2)} V`],
          ['Vitesse de croisière', record.cruiseSpeedMs == null ? '—' : `${nf(record.cruiseSpeedMs, 1)} m/s`],
          ['Vent vérifié à', hhmm(record.windCheckedAt)],
          ['Vent max · rafale', `${nf(record.summary.maxWindMs, 1)} · ${nf(record.summary.maxGustMs, 1)} m/s`],
          ['Marge prévue', record.summary.marginPct == null ? '—' : `${nf(record.summary.marginPct, 1)} % (réserve ${record.reservePct} %)`],
          ['Écart au plan (fin)', record.summary.delayS == null ? '—' : gapMin(record.summary.delayS * 1000)],
        ]} />
      </Box>

      <Box title="2 · Bilan prévu / réel">
        <table className="crm-table">
          <thead><tr><th>Élément</th><th className="num">Prévu</th><th className="num">Réel</th><th className="num">Écart</th></tr></thead>
          <tbody>
            {rows.map((r) => <tr key={r.label}><th>{r.label}</th><td className="num">{r.est}</td><td className="num">{r.real}</td><td className="num">{r.gap}</td></tr>)}
          </tbody>
        </table>
      </Box>

      <Box title="3 · Route">
        <RouteMap points={pts} />
        <p className="crm-muted wp-legend">
          <span className="wp-sw plan" /> plan · <span className="wp-sw flown" /> partie volée (passages enregistrés) · <span className="wp-sw drop" /> largage · H drone port · flèches : vent par point
        </p>
      </Box>

      <Box title="4 · Points de passage">
        <table className="crm-table wp-points">
          <thead>
            <tr>
              <th>Pt</th><th>Phase</th><th className="num">Alt.</th><th className="num">Vent</th><th className="num">ETA</th><th className="num">Passage</th>
              <th className="num">Écart</th><th className="num">mAh prévu</th><th className="num">mAh réel</th><th className="num">Écart</th><th className="num">V prévu</th><th className="num">V réel</th>
            </tr>
          </thead>
          <tbody>
            {pts.map((p, i) => {
              const dMah = p.realCumMah != null && p.estCumMah != null ? p.realCumMah - p.estCumMah : null;
              return (
                <tr key={i} className={p.drop ? 'wp-drop' : ''}>
                  <td><b>{p.n}</b></td>
                  <td>{p.phases.map((ph) => PHASE_FR[ph] ?? ph).join(', ') || (i === 0 ? 'Départ' : '—')}</td>
                  <td className="num">{p.alt == null ? '—' : `${nf(p.alt)} m`}</td>
                  <td className="num">{p.windMs == null ? '—' : `${nf(p.windMs, 1)} m/s · ${nf(p.windDir)}°`}</td>
                  <td className="num">{hhmm(p.eta)}</td>
                  <td className="num">{hhmmss(p.pass)}<Auto on={p.passAuto} /></td>
                  <td className="num">{p.pass != null && p.eta != null ? gapMin(p.pass - p.eta) : '—'}</td>
                  <td className="num">{nf(p.estCumMah)}</td>
                  <td className="num">{nf(p.realCumMah)}<Auto on={p.mahAuto} /></td>
                  <td className="num">{dMah == null ? '—' : signed(dMah, '')}</td>
                  <td className="num">{nf(p.estV, 2)}</td>
                  <td className="num">{nf(p.realV, 2)}<Auto on={p.vAuto} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Box>

      <Box title="5 · Consommation et tension">
        <div className="wp-charts">
          <Chart title="mAh cumulés" unit="mAh" color="#2b6fd6" est={pts.map((p) => p.estCumMah)} real={pts.map((p) => p.realCumMah)} auto={pts.map((p) => p.mahAuto)} />
          <Chart title="Tension batterie" unit="V" color="#d98a10" digits={1} est={pts.map((p) => p.estV)} real={pts.map((p) => p.realV)} auto={pts.map((p) => p.vAuto)} />
        </div>
      </Box>

      <p className="crm-muted wp-note">
        Estimations WindPath (vent prévu à l'altitude de chaque point, modèle d'énergie du Tango 4) comparées aux relevés du pilote.
        Positions et heures « recalées » : plan décalé de l'écart mesuré au dernier passage, pas une position GPS.
        {hasAuto && ' ≈ : valeur appliquée automatiquement, le point n\'ayant pas été saisi pendant le vol (estimation, pas un relevé).'}
      </p>
      <footer className="crm-foot">
        <span>Rapport WindPath{flight.crmNo ? ` · CRM ${flight.crmNo}` : ''} · {flight.droneCode} · vol du {`${d}/${m}/${y}`}</span>
        <span>{flight.crmNo ? 'Mission enregistrée' : 'Édité'} le {new Date(record.capturedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} · UAV Maintenance</span>
      </footer>
    </article>
  );
});

export default WindpathReport;
