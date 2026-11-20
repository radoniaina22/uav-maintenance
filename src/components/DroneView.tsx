import type { DroneSlot, PartRow } from '../lib/types';
import { TANGO4_ZONES } from '../lib/parts';
import { potentialLevel } from '../lib/parts';

export type ZoneState = 'ok' | 'warn' | 'danger' | 'empty';

export interface ZoneSummary {
  code: string;
  label: string;
  slots: DroneSlot[];
  filled: number;
  multiCount: number;
  state: ZoneState;
  issues: number;
}

/** État d'une zone : pire cas entre potentiel dépassé, potentiel proche et emplacement vide */
export function summarizeZones(slots: DroneSlot[], mounted: PartRow[]): ZoneSummary[] {
  return TANGO4_ZONES.map((z) => {
    const zs = slots.filter((s) => s.zone === z.code).sort((a, b) => a.sort - b.sort);
    const parts = mounted.filter((p) => p.zone === z.code);
    const bySlot = new Map(parts.filter((p) => p.slot).map((p) => [p.slot!, p]));
    const empty = zs.filter((s) => !bySlot.has(s.code)).length;
    const levels = parts.map((p) => potentialLevel(p));
    const danger = levels.filter((l) => l === 'danger').length;
    const warn = levels.filter((l) => l === 'warn').length;
    const state: ZoneState = danger ? 'danger' : warn ? 'warn' : empty ? 'empty' : 'ok';
    return {
      code: z.code, label: z.label, slots: zs, filled: zs.length - empty,
      multiCount: parts.filter((p) => !p.slot).length, state, issues: danger + warn + empty,
    };
  });
}

const STATE_LABEL: Record<ZoneState, string> = {
  ok: 'Complet', warn: 'Potentiel bientôt atteint', danger: 'Potentiel dépassé', empty: 'Emplacement vide',
};

/** Photo du drone avec les zones cliquables */
export default function DroneView({ zones, selected, onSelect }: { zones: ZoneSummary[]; selected: string | null; onSelect: (code: string) => void }) {
  return (
    <div>
      <div className="drone-view">
        <img src="./tango4.png" alt="Drone Tango 4 vu de dessus" draggable={false} />
        {zones.map((z) => {
          const pos = TANGO4_ZONES.find((t) => t.code === z.code)!;
          return (
            <button key={z.code} type="button" className={`zone-marker zone-${z.state}${selected === z.code ? ' is-selected' : ''}`}
              style={{ left: `${pos.x}%`, top: `${pos.y}%` }} onClick={() => onSelect(z.code)}
              aria-label={`${z.label} : ${z.filled}/${z.slots.length} emplacements, ${STATE_LABEL[z.state]}`} title={`${z.label} – ${STATE_LABEL[z.state]}`}>
              <span className="zone-icon" aria-hidden>{z.state === 'danger' ? '!' : z.state === 'warn' ? '!' : z.state === 'empty' ? '○' : '✓'}</span>
              <span className="zone-tag">{z.label}</span>
            </button>
          );
        })}
      </div>
      <div className="zone-legend small">
        <span><i className="zone-dot zone-ok" /> Complet</span>
        <span><i className="zone-dot zone-warn" /> Potentiel ≥ 90 %</span>
        <span><i className="zone-dot zone-danger" /> Potentiel dépassé</span>
        <span><i className="zone-dot zone-empty" /> Emplacement vide</span>
      </div>
    </div>
  );
}
