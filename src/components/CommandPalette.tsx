import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NAV_SECTIONS, NavItem, QUICK_ACTIONS } from '../lib/nav';
import { Icon } from './icons';

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Palette de commandes (Ctrl+K / ⌘K) : aller à une page ou lancer une action au clavier */
export default function CommandPalette({ open, onClose, isAdmin }: { open: boolean; onClose: () => void; isAdmin: boolean }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => {
    const match = (i: NavItem) => !q.trim() || norm(`${i.label} ${i.keywords ?? ''}`).includes(norm(q.trim()));
    const pages = NAV_SECTIONS.flatMap((s) => s.items.filter((i) => !i.adminOnly || isAdmin)).filter(match);
    const actions = QUICK_ACTIONS.filter(match);
    return [
      { title: 'Actions rapides', items: actions },
      { title: 'Aller à', items: pages },
    ].filter((g) => g.items.length);
  }, [q, isAdmin]);
  const flat = groups.flatMap((g) => g.items);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setActive(0);
    setTimeout(() => input.current?.focus(), 30);
  }, [open]);
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const go = (item?: NavItem) => {
    if (!item) return;
    onClose();
    nav(item.to);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    if (e.key === 'Enter') { e.preventDefault(); go(flat[active]); }
    if (e.key === 'Escape') onClose();
  };

  let index = -1;
  return (
    <div className="cmdk-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Palette de commandes" onKeyDown={onKey}>
        <div className="cmdk-input">
          <Icon name="search" />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Aller à une page ou lancer une action…"
            aria-label="Rechercher une page ou une action" />
          <kbd>Échap</kbd>
        </div>
        <div className="cmdk-list" ref={list} role="listbox">
          {flat.length === 0 && <div className="cmdk-empty">Aucun résultat pour « {q} »</div>}
          {groups.map((g) => (
            <div key={g.title}>
              <div className="cmdk-group">{g.title}</div>
              {g.items.map((item) => {
                index += 1;
                const i = index;
                return (
                  <button key={item.to + item.label} type="button" role="option" aria-selected={i === active} data-active={i === active}
                    className={`cmdk-item${i === active ? ' active' : ''}`} onMouseMove={() => setActive(i)} onClick={() => go(item)}>
                    <span className="cmdk-icon"><Icon name={item.icon} /></span>
                    <span className="cmdk-label">{item.label}</span>
                    {i === active && <Icon name="enter" size={15} className="cmdk-enter" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="cmdk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> naviguer</span><span><kbd>Entrée</kbd> ouvrir</span><span><kbd>Ctrl</kbd><kbd>K</kbd> ouvrir / fermer</span></div>
      </div>
    </div>
  );
}
