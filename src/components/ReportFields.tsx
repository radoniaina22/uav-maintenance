import { useRef } from 'react';
import type { ReportStatus, ReportType, Severity, TechnicalReport } from '../lib/types';
import { LABELS, today } from '../lib/format';
import { Icon } from './icons';

export interface ReportDraft {
  id?: string;
  report_type: ReportType;
  severity: Severity;
  component: string;
  description: string;
  corrective_action: string;
  status: ReportStatus;
  resolved_on: string;
}

export const COMPONENTS = [
  'Moteur VTOL 1', 'Moteur VTOL 2', 'Moteur VTOL 3', 'Moteur VTOL 4', 'Moteur principal',
  'Hélices', 'Batteries', 'ESC', 'Servos / gouvernes', 'Structure / cellule', 'Train / patins',
  'Autopilote / capteurs', 'GPS', 'Liaison radio / télémétrie', 'Système de largage', 'Parachute', 'Station sol', 'Autre',
];
/** suggestions proposées en un clic */
const QUICK_COMPONENTS = ['Hélices', 'Batteries', 'GPS', 'Système de largage', 'Liaison radio / télémétrie', 'Moteur principal', 'Servos / gouvernes', 'Structure / cellule'];

const TYPE_INFO: Record<ReportType, { icon: 'wrench' | 'alert'; desc: string }> = {
  technique: { icon: 'wrench', desc: 'Anomalie ou usure constatée sur le drone ou ses équipements' },
  incident: { icon: 'alert', desc: 'Événement en vol ou au sol ayant (pu) compromettre la sécurité' },
};
const SEVERITY_INFO: Record<Severity, string> = {
  mineur: 'Sans effet sur la sécurité, à traiter',
  majeur: 'Dégrade la mission ou la sécurité',
  critique: 'Drone indisponible jusqu\'à correction',
};
const STATUS_ORDER: ReportStatus[] = ['ouvert', 'en_cours', 'clos'];

export const emptyReport = (): ReportDraft => ({
  report_type: 'technique', severity: 'mineur', component: '', description: '',
  corrective_action: '', status: 'ouvert', resolved_on: '',
});

export const reportToDraft = (r: TechnicalReport): ReportDraft => ({
  id: r.id, report_type: r.report_type, severity: r.severity, component: r.component ?? '',
  description: r.description, corrective_action: r.corrective_action ?? '', status: r.status,
  resolved_on: r.resolved_on ?? '',
});

export const draftToPayload = (d: ReportDraft) => ({
  report_type: d.report_type,
  severity: d.severity,
  component: d.component.trim() || null,
  description: d.description.trim(),
  corrective_action: d.corrective_action.trim() || null,
  status: d.status,
  resolved_on: d.status === 'clos' ? d.resolved_on || today() : null,
});

export default function ReportFields({ value, onChange }: { value: ReportDraft; onChange: (v: ReportDraft) => void }) {
  // part toujours de la dernière valeur (plusieurs clics avant le rendu suivant ne s'écrasent pas)
  const latest = useRef(value);
  latest.current = value;
  const set = <K extends keyof ReportDraft>(k: K, v: ReportDraft[K]) => { latest.current = { ...latest.current, [k]: v }; onChange(latest.current); };
  const step = STATUS_ORDER.indexOf(value.status);
  const missingAction = value.status === 'clos' && !value.corrective_action.trim();

  return (
    <div className="rf">
      {/* ---- Type ---- */}
      <div className="rf-block">
        <span className="rf-label">Type <span className="req">*</span></span>
        <div className="rf-types" role="radiogroup" aria-label="Type de rapport">
          {(Object.keys(LABELS.reportType) as ReportType[]).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={value.report_type === t}
              className={`rf-type rt-${t}${value.report_type === t ? ' active' : ''}`} onClick={() => set('report_type', t)}>
              <span className="rf-type-icon"><Icon name={TYPE_INFO[t].icon} size={20} /></span>
              <span className="rf-type-text"><strong>{LABELS.reportType[t]}</strong><span>{TYPE_INFO[t].desc}</span></span>
            </button>
          ))}
        </div>
      </div>

      {/* ---- Gravité ---- */}
      <div className="rf-block">
        <span className="rf-label">Gravité <span className="req">*</span></span>
        <div className="rf-sev" role="radiogroup" aria-label="Gravité">
          {(Object.keys(LABELS.severity) as Severity[]).map((s) => (
            <button key={s} type="button" role="radio" aria-checked={value.severity === s}
              className={`rf-sev-btn sev-${s}${value.severity === s ? ' active' : ''}`} onClick={() => set('severity', s)}>
              <span className="rf-dot" aria-hidden />
              <strong>{LABELS.severity[s]}</strong>
              <span>{SEVERITY_INFO[s]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ---- Composant ---- */}
      <div className="rf-block">
        <label className="rf-label" htmlFor="rf-component">Composant concerné</label>
        <input id="rf-component" list="components-list" value={value.component} onChange={(e) => set('component', e.target.value)} placeholder="ex. Moteur VTOL 2" />
        <datalist id="components-list">{COMPONENTS.map((c) => <option key={c} value={c} />)}</datalist>
        <div className="rf-quick">
          {QUICK_COMPONENTS.map((c) => (
            <button key={c} type="button" className={`rf-chip${value.component === c ? ' active' : ''}`} onClick={() => set('component', value.component === c ? '' : c)}>{c}</button>
          ))}
        </div>
      </div>

      {/* ---- Constat / mesure corrective ---- */}
      <div className="rf-texts">
        <label className="rf-panel rp-constat">
          <span className="rf-panel-head"><Icon name="search" size={15} /> Constat <span className="req">*</span></span>
          <textarea rows={4} required value={value.description} onChange={(e) => set('description', e.target.value)}
            placeholder="Ce qui a été observé : symptôme, phase de vol, circonstances…" />
        </label>
        <label className={`rf-panel rp-action${missingAction ? ' is-missing' : ''}`}>
          <span className="rf-panel-head"><Icon name="wrench" size={15} /> Mesure corrective</span>
          <textarea rows={4} value={value.corrective_action} onChange={(e) => set('corrective_action', e.target.value)}
            placeholder="Actions réalisées ou à réaliser (pièce remplacée, réglage, essai au sol…)" />
        </label>
      </div>

      {/* ---- Statut ---- */}
      <div className="rf-block">
        <span className="rf-label">Statut <span className="req">*</span></span>
        <div className="rf-steps" role="radiogroup" aria-label="Statut">
          {STATUS_ORDER.map((s, i) => (
            <button key={s} type="button" role="radio" aria-checked={value.status === s}
              className={`rf-step st-${s}${i <= step ? ' done' : ''}${value.status === s ? ' active' : ''}`} onClick={() => set('status', s)}>
              <span className="rf-step-dot">{i < step || (s === 'clos' && value.status === 'clos') ? '✓' : i + 1}</span>
              <span>{LABELS.reportStatus[s]}</span>
            </button>
          ))}
        </div>
        {value.status === 'clos' && (
          <div className="rf-close">
            <label>Date de clôture <input type="date" value={value.resolved_on || today()} onChange={(e) => set('resolved_on', e.target.value)} /></label>
            {missingAction
              ? <span className="rf-warn">⚠ Renseignez la mesure corrective : elle est obligatoire pour clôturer.</span>
              : <span className="rf-ok">Une fois clôturé, seul un administrateur pourra modifier ce rapport.</span>}
          </div>
        )}
      </div>
    </div>
  );
}
