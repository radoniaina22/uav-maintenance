import type { ReactNode } from 'react';
import { Icon, IconName } from './icons';

/** Briques communes des fenêtres de saisie (sections numérotées, cartes de choix, puces rapides) */

export function FormSection({ n, icon, title, hint, children }: { n?: number; icon: IconName; title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="bm-section">
      <div className="bm-sec-head">
        {n != null && <span className="bm-sec-n">{n}</span>}
        <Icon name={icon} size={15} />
        <strong>{title}</strong>
        {hint && <span className="bm-sec-hint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';
export interface Choice<V extends string> { value: V; label: string; desc?: string; icon?: IconName; tone?: Tone }

/** Cartes de choix exclusif (remplacent un menu déroulant ou un segmenté) */
export function ChoiceCards<V extends string>({ value, onChange, options, label, cols }: {
  value: V; onChange: (v: V) => void; options: Choice<V>[]; label: string; cols?: number;
}) {
  return (
    <div className="fk-choices" role="radiogroup" aria-label={label} style={{ gridTemplateColumns: `repeat(${cols ?? options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value}
          className={`fk-choice tone-${o.tone ?? 'info'}${value === o.value ? ' active' : ''}`} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size={16} />}
          <strong>{o.label}</strong>
          {o.desc && <span>{o.desc}</span>}
        </button>
      ))}
    </div>
  );
}

/** Puces de saisie rapide : ajoutent / retirent une ligne d'un texte (ou remplacent la valeur si `replace`) */
export function QuickChips({ items, value, onChange, replace }: { items: string[]; value: string; onChange: (v: string) => void; replace?: boolean }) {
  const lines = value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const has = (s: string) => (replace ? value.trim() === s : lines.includes(s));
  const toggle = (s: string) => {
    if (replace) return onChange(has(s) ? '' : s);
    onChange((has(s) ? lines.filter((l) => l !== s) : [...lines, s]).join('\n'));
  };
  return (
    <div className="rf-quick">
      {items.map((s) => <button key={s} type="button" className={`rf-chip${has(s) ? ' active' : ''}`} onClick={() => toggle(s)}>{has(s) ? '✓ ' : '+ '}{s}</button>)}
    </div>
  );
}

/** Bandeau de contexte en tête de fenêtre (objet concerné) */
export function ContextBanner({ icon, title, sub, children, tone = 'info' }: { icon: IconName; title: ReactNode; sub?: ReactNode; children?: ReactNode; tone?: Tone }) {
  return (
    <div className={`fk-context tone-${tone}`}>
      <span className="fk-context-icon"><Icon name={icon} size={18} /></span>
      <div className="fk-context-body"><strong>{title}</strong>{sub && <span>{sub}</span>}{children}</div>
    </div>
  );
}

/** Trajet « depuis → vers » (transferts) */
export function RouteView({ from, to }: { from: string; to?: string | null }) {
  return (
    <div className="bm-route field-wide">
      <div><span className="pd-kicker">Depuis</span><strong>{from}</strong></div>
      <span className="bm-route-arrow">→</span>
      <div className={to ? '' : 'muted'}><span className="pd-kicker">Vers</span><strong>{to ?? 'à choisir'}</strong></div>
    </div>
  );
}
