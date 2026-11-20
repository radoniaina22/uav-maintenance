import { haversineKm } from './LocationPicker';

export interface RadarBlip {
  name: string; lat: number; lon: number;
  /** livraisons sur 30 jours (taille de l'écho) */
  deliveries?: number;
  /** jours depuis la dernière livraison (écho pulsant si ≤ 7) */
  since?: number | null;
  /** CSB commun à tous les drone ports */
  common?: boolean;
}

/** Pas d'anneaux « ronds » selon la portée */
function niceRange(maxKm: number) {
  for (const r of [5, 10, 20, 30, 40, 50, 75, 100, 150, 200, 300]) if (maxKm * 1.12 <= r) return r;
  return Math.ceil((maxKm * 1.12) / 100) * 100;
}

/** Cap (0 = nord, sens horaire) de a vers b, en radians */
function bearing(a: [number, number], b: [number, number]) {
  const r = Math.PI / 180;
  const y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r);
  const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
  return Math.atan2(y, x);
}

const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
export const cardinalOf = (rad: number) => CARD[Math.round((((rad * 180) / Math.PI + 360) % 360) / 45) % 8];

/**
 * Radar de couverture d'un drone port : les CSB sont placés selon leur cap et leur distance réels,
 * avec un balayage animé. La portée s'adapte au CSB le plus éloigné.
 */
export default function PortRadar({ center, blips, size = 260, label }: {
  center: { lat: number; lon: number } | null; blips: RadarBlip[]; size?: number; label?: string;
}) {
  const S = 200, C = S / 2, R = 88;
  if (!center) {
    return (
      <div className="radar radar-off" style={{ width: size, height: size }}>
        <svg viewBox={`0 0 ${S} ${S}`} aria-hidden><circle cx={C} cy={C} r={R} className="rd-ring" /><circle cx={C} cy={C} r={R / 2} className="rd-ring" /></svg>
        <span className="radar-msg">Position GPS<br />à renseigner</span>
      </div>
    );
  }
  const pts = blips.map((b) => {
    const d = haversineKm([center.lat, center.lon], [b.lat, b.lon]);
    const br = bearing([center.lat, center.lon], [b.lat, b.lon]);
    return { ...b, d, br };
  });
  const range = niceRange(Math.max(1, ...pts.map((p) => p.d)));
  const maxDel = Math.max(1, ...pts.map((p) => p.deliveries ?? 0));
  return (
    <div className="radar" style={{ width: size, height: size }} role="img" aria-label={label ?? `Radar de couverture : ${pts.length} CSB dans un rayon de ${range} km`}>
      <div className="radar-sweep" />
      <svg viewBox={`0 0 ${S} ${S}`}>
        {[1, 0.75, 0.5, 0.25].map((k) => <circle key={k} cx={C} cy={C} r={R * k} className={`rd-ring${k === 1 ? ' outer' : ''}`} />)}
        <line x1={C} y1={C - R} x2={C} y2={C + R} className="rd-axis" />
        <line x1={C - R} y1={C} x2={C + R} y2={C} className="rd-axis" />
        {[0.5, 1].map((k) => <text key={k} x={C + 3} y={C - R * k + 9} className="rd-range">{Math.round(range * k)} km</text>)}
        {(['N', 'E', 'S', 'O'] as const).map((t, i) => {
          const a = (i * Math.PI) / 2;
          return <text key={t} x={C + Math.sin(a) * (R + 7)} y={C - Math.cos(a) * (R + 7) + 3} textAnchor="middle" className={`rd-card${t === 'N' ? ' n' : ''}`}>{t}</text>;
        })}
        {pts.map((p, i) => {
          const r = (p.d / range) * R;
          const x = C + Math.sin(p.br) * r, y = C - Math.cos(p.br) * r;
          const dot = 2.4 + 3.6 * Math.sqrt((p.deliveries ?? 0) / maxDel);
          const hot = p.since != null && p.since <= 7;
          const idle = !p.deliveries;
          return (
            <g key={i} className={`rd-blip${hot ? ' hot' : ''}${idle ? ' idle' : ''}${p.common ? ' common' : ''}`}>
              <line x1={C} y1={C} x2={x} y2={y} className="rd-route" />
              {hot && <circle cx={x} cy={y} r={dot + 2} className="rd-pulse" />}
              <circle cx={x} cy={y} r={dot} className="rd-dot">
                <title>{`${p.name}${p.common ? ' (commun)' : ''} · ${p.d.toFixed(1).replace('.', ',')} km au ${cardinalOf(p.br)} · ${p.deliveries ?? 0} livraison(s) sur 30 j`}</title>
              </circle>
            </g>
          );
        })}
        <circle cx={C} cy={C} r={5} className="rd-base" />
        <text x={C} y={C + 2.6} textAnchor="middle" className="rd-base-ico">⌂</text>
      </svg>
    </div>
  );
}
