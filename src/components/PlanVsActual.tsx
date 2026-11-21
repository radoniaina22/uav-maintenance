import type { FlightPlanEstimate, FlightRow } from '../lib/types';

/** Écart relatif signé, en % */
const pct = (planned: number, actual: number) => (planned ? ((actual - planned) / planned) * 100 : null);
const fr = (v: number, d = 0) => v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
/** Écart entre deux heures « HH:MM », en minutes (passage de minuit géré) */
const minDiff = (planned: string, actual: string) => {
  let d = toMin(actual.slice(0, 5)) - toMin(planned.slice(0, 5));
  if (d > 720) d -= 1440; if (d < -720) d += 1440;
  return d;
};

interface Row { label: string; planned: string; actual: string; delta: string | null; level: 'ok' | 'warn' | 'danger' | null; hint?: string }

/**
 * Prévu (estimation WindPath retenue au moment du report) / réel (valeurs du vol).
 * Une consommation réelle nettement supérieure à l'estimation est signalée : c'est elle qui compte pour la sécurité.
 */
export default function PlanVsActual({ estimate: e, flight: f }: { estimate: FlightPlanEstimate; flight: FlightRow }) {
  const rows: Row[] = [];
  if (e.consumption_mah != null) {
    const a = f.consumption_mah != null ? Number(f.consumption_mah) : null;
    const d = a != null ? pct(Number(e.consumption_mah), a) : null;
    rows.push({
      label: 'Consommation', planned: `${fr(Number(e.consumption_mah))} mAh`, actual: a != null ? `${fr(a)} mAh` : '—',
      delta: d == null ? null : `${d > 0 ? '+' : ''}${fr(d)} %`, level: d == null ? null : d > 20 ? 'danger' : d > 10 ? 'warn' : 'ok',
      hint: 'Au-delà de +10 %, l\'estimation a été optimiste pour ce vol',
    });
  }
  if (e.voltage_end_v != null) {
    const a = f.voltage_end_v != null ? Number(f.voltage_end_v) : null;
    const d = a != null ? a - Number(e.voltage_end_v) : null;
    rows.push({
      label: 'Tension d\'arrivée', planned: `${fr(Number(e.voltage_end_v), 2)} V`, actual: a != null ? `${fr(a, 2)} V` : '—',
      delta: d == null ? null : `${d > 0 ? '+' : ''}${fr(d, 2)} V`, level: d == null ? null : d < -1 ? 'danger' : d < -0.5 ? 'warn' : 'ok',
    });
  }
  if (e.duration_min != null) {
    const a = f.duration_min != null ? Number(f.duration_min) : null;
    const d = a != null ? a - Number(e.duration_min) : null;
    rows.push({
      label: 'Durée', planned: `${fr(Number(e.duration_min))} min`, actual: a != null ? `${fr(a)} min` : '—',
      delta: d == null ? null : `${d > 0 ? '+' : ''}${fr(d)} min`, level: d == null ? null : Math.abs(d) > 15 ? 'warn' : 'ok',
    });
  }
  for (const [label, p, a] of [['Largage', e.drop_time, f.drop_time], ['Atterrissage', e.landing_time, f.landing_time]] as const) {
    if (!p) continue;
    const d = a ? minDiff(p, a) : null;
    rows.push({ label, planned: p.slice(0, 5), actual: a ? a.slice(0, 5) : '—', delta: d == null ? null : `${d > 0 ? '+' : ''}${d} min`, level: d == null ? null : Math.abs(d) > 15 ? 'warn' : 'ok' });
  }
  if (e.wind_ms != null) {
    const a = f.avg_wind_ms != null ? Number(f.avg_wind_ms) : null;
    const d = a != null ? a - Number(e.wind_ms) : null;
    rows.push({ label: 'Vent moyen', planned: `${fr(Number(e.wind_ms), 1)} m/s`, actual: a != null ? `${fr(a, 1)} m/s` : '—', delta: d == null ? null : `${d > 0 ? '+' : ''}${fr(d, 1)} m/s`, level: null });
  }
  if (e.distance_km != null) {
    const a = f.distance_km != null ? Number(f.distance_km) : null;
    rows.push({ label: 'Distance', planned: `${fr(Number(e.distance_km), 1)} km`, actual: a != null ? `${fr(a, 1)} km` : '—', delta: null, level: null });
  }

  return (
    <section className="card pva">
      <div className="row-between">
        <h2 className="card-title">Prévu (WindPath) / réel</h2>
        <span className="small muted">
          {e.mission_name ? <>{e.mission_name} · </> : null}estimé le {new Date(e.created_at).toLocaleDateString('fr-FR')}
          {e.margin_pct != null && <> · marge prévue {Math.round(Number(e.margin_pct))} %</>}
        </span>
      </div>
      <table className="pva-table">
        <thead><tr><th /><th>Prévu</th><th>Réel</th><th>Écart</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} title={r.hint}>
              <th scope="row">{r.label}</th>
              <td>{r.planned}</td>
              <td><strong>{r.actual}</strong></td>
              <td>{r.delta ? <span className={r.level ? `pva-delta lv-${r.level}` : 'pva-delta'}>{r.delta}</span> : <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!e.wind_checked_at && <p className="small text-warn">Estimation faite sans vérification du vent : écarts peu significatifs.</p>}
    </section>
  );
}
