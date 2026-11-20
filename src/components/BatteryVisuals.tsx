import type { BatteryStatusRow, CapacityTest } from '../lib/types';
import { healthLevel, num, THRESHOLDS } from '../lib/format';
import { addDays, iso } from '../lib/stats';

/** Fenêtre de calcul du rythme d'utilisation (jours) */
export const RATE_WINDOW_DAYS = 30;

/** Cellule de batterie verticale : remplissage = santé (capacité réelle / nominale) */
export function BatteryCell({ b, label, size = 'md' }: { b: Pick<BatteryStatusRow, 'health_pct' | 'last_measured_mah'>; label?: string; size?: 'sm' | 'md' | 'lg' }) {
  const known = b.health_pct != null;
  const pct = known ? Math.max(4, Math.min(100, Number(b.health_pct))) : 100;
  const lvl = known ? healthLevel(b.health_pct) : 'unknown';
  return (
    <div className={`bcell bcell-${size} lv-${lvl}`} role="img" aria-label={known ? `Santé ${num(b.health_pct)} %` : 'Santé non mesurée'}>
      <span className="bcell-cap" />
      <span className="bcell-body">
        <span className="bcell-fill" style={{ height: `${pct}%` }} />
        <span className="bcell-text">
          {label && <b>{label}</b>}
          <em>{known ? `${num(b.health_pct, 0)} %` : '?'}</em>
        </span>
      </span>
    </div>
  );
}

/** Anneau de mesure (santé, cycles…) */
export function GaugeRing({ value, max = 100, level, center, sub, size = 120 }: {
  value: number; max?: number; level: string; center: string; sub: string; size?: number;
}) {
  const R = 48, C = 2 * Math.PI * R;
  const pct = Math.max(0, Math.min(1, value / max));
  return (
    <div className={`gring lv-${level}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 120 120" aria-hidden>
        <circle cx="60" cy="60" r={R} className="gr-track" />
        <circle cx="60" cy="60" r={R} className="gr-val" strokeDasharray={`${C * pct} ${C}`} transform="rotate(-90 60 60)" />
      </svg>
      <div className="gr-center"><strong>{center}</strong><span>{sub}</span></div>
    </div>
  );
}

/** Cycles par jour de chaque batterie sur les 30 derniers jours (1 vol = 1 cycle par batterie) */
export function cycleRates(flights: { battery_1_id: string | null; battery_2_id: string | null }[]) {
  const m = new Map<string, number>();
  for (const f of flights) for (const id of [f.battery_1_id, f.battery_2_id]) if (id) m.set(id, (m.get(id) ?? 0) + 1 / RATE_WINDOW_DAYS);
  return m;
}
export const rateSince = () => addDays(iso(new Date()), -(RATE_WINDOW_DAYS - 1));

/** Fin de vie estimée en cycles : jours restants et date au rythme actuel */
export function endOfLife(b: Pick<BatteryStatusRow, 'remaining_cycles'>, perDay: number) {
  const rest = Number(b.remaining_cycles);
  if (rest <= 0) return { days: 0, date: iso(new Date()) };
  if (perDay <= 0) return null;
  const days = Math.ceil(rest / perDay);
  return { days, date: addDays(iso(new Date()), days) };
}

/**
 * Tendance de la santé selon les cycles (moindres carrés sur les relevés qui ont un nombre de cycles).
 * Renvoie la pente (points de % par cycle) et le cycle auquel la santé atteindrait chaque seuil.
 */
export function healthTrend(tests: Pick<CapacityTest, 'measured_mah' | 'cycles_at_test' | 'test_date'>[], nominal: number) {
  const pts = tests.filter((t) => t.cycles_at_test != null).map((t) => ({ x: Number(t.cycles_at_test), y: (100 * t.measured_mah) / nominal }));
  const xs = new Set(pts.map((p) => p.x));
  if (pts.length < 2 || xs.size < 2) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxy = 0, sxx = 0;
  for (const p of pts) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; }
  const slope = sxy / sxx, intercept = my - slope * mx;
  const at = (target: number) => (slope < 0 ? (target - intercept) / slope : null);
  return { slope, intercept, pts, warnAt: at(THRESHOLDS.healthWarnPct), dangerAt: at(THRESHOLDS.healthDangerPct) };
}
