import { ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Level } from '../lib/format';

export function Badge({ level = 'neutral', children }: { level?: Level | 'neutral' | 'info'; children: ReactNode }) {
  return <span className={`badge badge-${level}`}>{children}</span>;
}

export function PortSelect({ value, onChange, ports, emptyLabel = '— Non affecté —' }: {
  value: string; onChange: (v: string) => void; ports: { id: string; name: string; active?: boolean }[]; emptyLabel?: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{emptyLabel}</option>
      {ports.filter((p) => p.active !== false || p.id === value).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );
}

/** Sélection Région puis District (filtré sur la région) — découpage officiel de Madagascar */
export function GeoFields({ regions, districtsOf, regionId, districtId, onChange }: {
  regions: { id: number; name: string }[];
  districtsOf: (regionId: number | null) => { id: number; name: string }[];
  regionId: number | null;
  districtId: number | null;
  onChange: (regionId: number | null, districtId: number | null) => void;
}) {
  const districts = districtsOf(regionId);
  return <>
    <Field label="Région">
      <select value={regionId ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null, null)}>
        <option value="">— Choisir une région —</option>
        {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
    </Field>
    <Field label="District" hint={regionId == null ? "Choisissez d'abord la région" : `${districts.length} districts dans cette région`}>
      <select value={districtId ?? ''} disabled={regionId == null} onChange={(e) => onChange(regionId, e.target.value ? Number(e.target.value) : null)}>
        <option value="">— Choisir un district —</option>
        {districts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
    </Field>
  </>;
}

export function FlightStatusBadge({ status }: { status: 'ouvert' | 'cloture' }) {
  return status === 'cloture' ? <Badge level="ok">✓ Clôturé</Badge> : <Badge level="warn">Ouvert</Badge>;
}

export function Progress({ value, max, level }: { value: number; max: number; level: Level }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <div className={`progress-bar progress-${level}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="alert alert-danger">{error}</div>;
}

/** Chargement : squelette scintillant (pas de saut de mise en page) */
export function Loading() {
  return (
    <div className="skeleton-page" role="status" aria-label="Chargement">
      <div className="skeleton skeleton-title" />
      <div className="skeleton-row">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton skeleton-tile" />)}</div>
      <div className="skeleton skeleton-block" />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <svg className="empty-icon" viewBox="0 0 48 48" fill="none" aria-hidden>
        <circle cx="24" cy="24" r="20" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" strokeDasharray="3 4" />
        <path d="M16 26h16M20 20h8" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <div>{children}</div>
    </div>
  );
}

/** Nombre qui défile jusqu'à sa valeur (respecte « réduire les animations ») */
export function CountUp({ value, decimals = 0 }: { value: number; decimals?: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !Number.isFinite(value)) { setShown(value); return; }
    let raf = 0;
    const t0 = performance.now(), dur = 900;
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / dur);
      setShown(value * (1 - (1 - k) ** 3));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{shown.toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</>;
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Field({ label, required, hint, children, wide }: {
  label: string; required?: boolean; hint?: ReactNode; children: ReactNode; wide?: boolean;
}) {
  return (
    <label className={`field${wide ? ' field-wide' : ''}`}>
      <span className="field-label">{label}{required && <span className="req"> *</span>}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Modal({ title, onClose, children, footer }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // pas de défilement de la page derrière la fenêtre
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
  // rendue dans <body> : un parent avec transform / contain / content-visibility ne peut plus la rogner
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn-icon" onClick={onClose} aria-label="Fermer">×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Stat({ label, value, sub, level }: { label: string; value: ReactNode; sub?: ReactNode; level?: Level }) {
  return (
    <div className={`stat${level ? ` stat-${level}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{typeof value === 'number' ? <CountUp value={value} /> : value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}
