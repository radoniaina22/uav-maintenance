import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { crmNumber, useCrmTasks } from '../lib/crmTasks';
import { useApp } from '../lib/app';
import { date, time } from '../lib/format';
import { Icon } from './icons';

const SESSION_KEY = 'uav.crmReminderShown';

const TASK_LABEL = { pilote: 'visa commandant de bord', copilote: 'visa copilote', rapports: 'mesures correctives', suivi: 'comptes rendus' } as const;

/** Cloche de notifications : visas du CRM à signer (pilotes du drone port du vol) ;
 *  pour l'administrateur, suivi des comptes rendus techniques / incidents de tous les drone ports. */
export default function NotificationBell() {
  const { session, isAdmin } = useApp();
  const sessionKey = `${SESSION_KEY}.${session.user.id}`;
  const { tasks, loaded, fresh, clearFresh } = useCrmTasks();
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const count = tasks.length;
  const toTreat = tasks.filter((t) => t.kind === 'rapports' && t.open_reports > 0).length;

  // rappel une fois par session à la connexion
  useEffect(() => {
    if (!loaded || !count) return;
    try {
      if (sessionStorage.getItem(sessionKey)) return;
      sessionStorage.setItem(sessionKey, '1');
    } catch { /* sans stockage : on affiche quand même */ }
    setToast(isAdmin
      ? `${count} vol(s) avec des comptes rendus techniques ou incidents en attente`
      : `${count} CRM ${count > 1 ? 'attendent' : 'attend'} votre signature`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // nouveau CRM à signer pendant la session
  useEffect(() => {
    if (!fresh.length) return;
    const t = fresh[0];
    if (t.kind === 'suivi') setToast(fresh.length > 1 ? `${fresh.length} nouveaux comptes rendus à suivre` : `Nouveau compte rendu : ${t.drone_code} · ${t.drone_port_name ?? '—'}`);
    else setToast(fresh.length > 1 ? `${fresh.length} nouveaux CRM à signer` : `Nouveau CRM à signer : ${crmNumber(t.drone_code, t.flight_seq)}`);
    clearFresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="notif" ref={box}>
      <button type="button" className={`icon-btn notif-btn${count ? ' has-items' : ''}`} aria-expanded={open} aria-haspopup="true"
        aria-label={count ? `${count} notification(s)` : 'Notifications'} title="Notifications" onClick={() => setOpen(!open)}>
        <Icon name="bell" />
        {count > 0 && <span className="notif-count">{count > 99 ? '99+' : count}</span>}
      </button>

      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <div className="notif-head">
            <strong>Notifications</strong>
            <span className="muted small">{count ? (isAdmin ? `${count} vol(s) à suivre` : `${count} CRM à signer`) : 'À jour'}</span>
          </div>
          {count === 0 ? (
            <div className="notif-empty">
              <Icon name="shield" size={22} />
              <span>{isAdmin ? 'Aucun compte rendu technique ou incident en attente.' : 'Aucun CRM en attente de votre signature.'}</span>
            </div>
          ) : (
            <ul className="notif-list">
              {tasks.map((t) => (
                <li key={`${t.flight_id}|${t.kind}`}>
                  <Link to={t.flight_status === 'cloture' ? `/vols/${t.flight_id}/crm` : `/vols/${t.flight_id}`} onClick={() => setOpen(false)} className="notif-item">
                    <span className={`notif-dot ${t.kind}`} aria-hidden />
                    <span className="notif-body">
                      <strong>{t.kind === 'suivi' ? <>{t.drone_code} · {t.drone_port_name ?? '—'}</> : <>CRM {crmNumber(t.drone_code, t.flight_seq)}</>} · {TASK_LABEL[t.kind]}</strong>
                      <span className="small muted">
                        Vol du {date(t.flight_date)} à {time(t.takeoff_time)}{t.destination_name ? ` · ${t.destination_name}` : ''}
                      </span>
                      {t.kind === 'suivi' && (
                        <span className={`small ${t.open_reports ? 'text-warn' : 'text-ok'}`}>
                          {t.open_reports ? `${t.open_reports} / ${t.report_count} rapport(s) ouvert(s)` : `Rapports clos : visa « mesures correctives » en attente`}
                          {t.flight_status === 'ouvert' ? ' · vol non clôturé' : ''}
                        </span>
                      )}
                      {t.kind === 'rapports' && (
                        <span className={`small ${t.open_reports ? 'text-warn' : 'text-ok'}`}>
                          {t.open_reports ? `${t.open_reports} rapport(s) à traiter et clôturer` : `Rapports clos (${t.report_count}) : visa à signer`}
                        </span>
                      )}
                    </span>
                    <span className="notif-go" aria-hidden>{t.kind === 'suivi' ? 'Voir →' : t.kind === 'rapports' && t.open_reports ? 'Traiter →' : 'Signer →'}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="notif-foot small muted">
            {isAdmin
              ? 'Comptes rendus de tous les drone ports, jusqu\'au visa « mesures correctives » · 60 derniers jours.'
              : <>{toTreat > 0 ? `${toTreat} vol(s) avec des comptes rendus à traiter. ` : ''}Vols de votre drone port clôturés depuis moins de 60 jours.</>}
          </div>
        </div>
      )}

      {toast && createPortal(
        <div className="toast" role="status">
          <Icon name="bell" size={16} />
          <span>{toast}</span>
          <button type="button" className="btn btn-sm" onClick={() => { setToast(null); setOpen(true); }}>Voir</button>
          <button type="button" className="toast-close" aria-label="Fermer" onClick={() => setToast(null)}>×</button>
        </div>,
        document.body,
      )}
    </div>
  );
}
