import { useId } from 'react';

/** Emblème seul (carré), même dessin que l'icône de l'application (public/favicon.svg). */
export function UavEmblem({ size = 24, className }: { size?: number | string; className?: string }) {
  return <img src="./favicon.svg" width={size} height={size} alt="" aria-hidden className={className} />;
}

/**
 * Logo « UAV Maintenance » : emblème (drone VTOL vu de dessus, aile orange) + logotype.
 * Vectoriel en ligne : reprend la police Inter de l'application, net à l'impression.
 * `variant="light"` pour fond clair (impression), `"dark"` pour fond sombre.
 */
export default function UavLogo({ variant = 'light', width = 200, tagline = 'Tango 4 · UNFPA Madagascar', className }: {
  variant?: 'light' | 'dark'; width?: number | string; tagline?: string | null; className?: string;
}) {
  const id = useId().replace(/:/g, '');
  const ink = variant === 'light' ? '#1f3a5f' : '#ffffff';
  const sub = variant === 'light' ? '#2b7be0' : '#7fb6ff';
  const muted = variant === 'light' ? '#6b7280' : '#9fb0cc';
  return (
    <svg className={className} width={width} viewBox="0 0 300 80" role="img" aria-label="UAV Maintenance" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2b7be0" />
          <stop offset="1" stopColor="#1f3a5f" />
        </linearGradient>
        <linearGradient id={`w${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#f5b83d" />
          <stop offset="1" stopColor="#f59e0b" />
        </linearGradient>
      </defs>

      {/* Emblème */}
      <rect x="2" y="4" width="72" height="72" rx="18" fill={`url(#g${id})`} />
      <rect x="2" y="4" width="72" height="72" rx="18" fill="none" stroke="#ffffff" strokeOpacity="0.18" />
      {/* aile principale */}
      <path d="M10 41 L66 41 L60 36 L16 36 Z" fill={`url(#w${id})`} />
      {/* fuselage + empennage */}
      <rect x="35" y="15" width="6" height="46" rx="3" fill="#ffffff" />
      <path d="M28 62 L48 62 L44 58 L32 58 Z" fill="#ffffff" />
      {/* poutres et rotors VTOL */}
      <path d="M22 22 L22 56 M54 22 L54 56" stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" />
      {[[22, 20], [54, 20], [22, 58], [54, 58]].map(([cx, cy]) => (
        <g key={`${cx}-${cy}`}>
          <circle cx={cx} cy={cy} r="7.5" fill="#ffffff" fillOpacity="0.12" stroke="#ffffff" strokeWidth="2" />
          <circle cx={cx} cy={cy} r="1.8" fill="#ffffff" />
        </g>
      ))}

      {/* Logotype */}
      <text x="88" y="38" fontFamily="Inter, 'Segoe UI', Arial, sans-serif" fontSize="31" fontWeight="800" letterSpacing="1" fill={ink}>UAV</text>
      <rect x="160" y="22" width="22" height="4" rx="2" fill="#f59e0b" />
      <text x="89" y="58" fontFamily="Inter, 'Segoe UI', Arial, sans-serif" fontSize="14.5" fontWeight="700" letterSpacing="4.2" fill={sub}>MAINTENANCE</text>
      {tagline && <text x="89" y="74" fontFamily="Inter, 'Segoe UI', Arial, sans-serif" fontSize="9" fontWeight="500" letterSpacing="0.6" fill={muted}>{tagline}</text>}
    </svg>
  );
}
