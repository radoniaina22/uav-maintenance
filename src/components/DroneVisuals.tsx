import type { DroneStatusRow } from '../lib/types';
import { num, visitLevel } from '../lib/format';

/**
 * Jauge du potentiel avant la visite systématique : arc de 270° qui se remplit avec les heures
 * effectuées depuis la dernière visite ; au centre, les heures restantes.
 */
export function PotentialGauge({ d, size = 150 }: { d: Pick<DroneStatusRow, 'hours_to_next_visit' | 'visit_interval_hours'>; size?: number }) {
  const interval = Number(d.visit_interval_hours) || 250;
  const left = Number(d.hours_to_next_visit);
  const used = Math.min(1, Math.max(0, (interval - left) / interval));
  const lvl = visitLevel(left);
  const R = 52, C = 2 * Math.PI * R, arc = 0.75;
  const ticks = Array.from({ length: 11 }, (_, i) => i);
  return (
    <div className={`pgauge lvl-${lvl}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 128 128" aria-hidden>
        <g transform="rotate(135 64 64)">
          <circle cx="64" cy="64" r={R} className="pg-track" strokeDasharray={`${C * arc} ${C}`} />
          <circle cx="64" cy="64" r={R} className="pg-value" strokeDasharray={`${C * arc * used} ${C}`} />
        </g>
        {ticks.map((i) => {
          const a = ((135 + 27 * i) * Math.PI) / 180;
          return <line key={i} x1={64 + 61 * Math.cos(a)} y1={64 + 61 * Math.sin(a)} x2={64 + (i % 5 === 0 ? 55 : 58) * Math.cos(a)} y2={64 + (i % 5 === 0 ? 55 : 58) * Math.sin(a)} className="pg-tick" />;
        })}
      </svg>
      <div className="pg-center">
        <strong>{left <= 0 ? 'Dépassée' : `${num(left, left < 10 ? 1 : 0)} h`}</strong>
        <span>{left <= 0 ? `de ${num(-left, 1)} h` : `avant visite ${num(interval, 0)} h`}</span>
      </div>
    </div>
  );
}

/** Photo du drone (Tango 4) avec halo coloré selon l'état */
export function DronePhoto({ state, className = '' }: { state: 'pret' | 'reserve' | 'indisponible'; className?: string }) {
  return (
    <div className={`drone-photo ready-glow-${state} ${className}`}>
      <img src="./tango4.png" alt="" loading="lazy" />
    </div>
  );
}
