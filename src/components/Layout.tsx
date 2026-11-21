import { Suspense, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useApp } from '../lib/app';
import { LABELS } from '../lib/format';
import { NAV_SECTIONS, pageTitle } from '../lib/nav';
import ErrorBoundary from './ErrorBoundary';
import CommandPalette from './CommandPalette';
import NotificationBell from './Notifications';
import { Icon } from './icons';
import { PageLoading } from '../lib/lazyPage';

const COLLAPSE_KEY = 'uav.sidebarCollapsed';
const readCollapsed = () => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } };

/** Heure locale de Madagascar (EAT), utile aux équipes sur le terrain */
function MgClock() {
  const fmt = () => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Indian/Antananarivo', hour: '2-digit', minute: '2-digit' }).format(new Date());
  const day = () => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Indian/Antananarivo', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date());
  const [t, setT] = useState(fmt);
  const [d, setD] = useState(day);
  useEffect(() => {
    const id = setInterval(() => { setT(fmt()); setD(day()); }, 15000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="appbar-clock" title="Heure de Madagascar (EAT, UTC+3)">
      <Icon name="clock" size={16} />
      <span><strong>{t}</strong> <span className="muted">{d}</span></span>
    </div>
  );
}

const initials = (s: string) => s.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');

export default function Layout() {
  const { session, isAdmin, profile, pilot, ports, myPort, portFilter, setPortFilter } = useApp();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [palette, setPalette] = useState(false);
  const loc = useLocation();
  const currentPort = ports.find((p) => p.id === portFilter);
  const { section, title } = pageTitle(loc.pathname);
  const fullBleed = loc.pathname === '/planification';
  // pages de saisie et fiches : largeur de lecture confortable ; les pages de données utilisent toute la largeur
  const narrow = /^\/vols\/(nouveau|[^/]+(\/modifier|\/crm)?)$/.test(loc.pathname)
    || /^\/drones\/[^/]+(\/historique)?$/.test(loc.pathname)
    || (/^\/(pieces|batteries)\/[^/]+$/.test(loc.pathname) && loc.pathname !== '/pieces/etiquettes');
  const displayName = pilot?.full_name ?? session.user.email ?? '';

  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* stockage indisponible */ }
  }, [collapsed]);

  // Ctrl+K / ⌘K : palette de commandes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Pendant le défilement : animations en pause et survols désactivés (classe html.is-scrolling, voir theme.css)
  useEffect(() => {
    const root = document.documentElement;
    let timer = 0;
    const onScroll = () => {
      if (!timer) root.classList.add('is-scrolling');
      else clearTimeout(timer);
      timer = window.setTimeout(() => { root.classList.remove('is-scrolling'); timer = 0; }, 160);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); clearTimeout(timer); root.classList.remove('is-scrolling'); };
  }, []);

  useEffect(() => { setOpen(false); }, [loc.pathname]);
  useEffect(() => { document.title = `${title} · UAV Maintenance`; }, [title]);

  return (
    <div className={`shell${collapsed ? ' is-collapsed' : ''}`}>
      <aside className={`sidebar${open ? ' open' : ''}`}>
        <div className="brand">
          <div className="brand-logo"><img src="./favicon.svg" alt="" width={34} height={34} /></div>
          <div className="brand-text">
            <div className="brand-title">UAV Maintenance</div>
            <div className="brand-sub">Tango 4 · UNFPA</div>
          </div>
          <button className="collapse-btn" type="button" onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? 'Déplier le menu' : 'Replier le menu'} title={collapsed ? 'Déplier le menu' : 'Replier le menu'}>
            <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={16} />
          </button>
        </div>

        <div className="port-box" title={currentPort?.name ?? myPort?.name ?? 'Tous les drone ports'}>
          <div className="port-label"><Icon name="pin" size={13} /> <span>Drone port</span></div>
          {isAdmin ? (
            <select value={portFilter} onChange={(e) => setPortFilter(e.target.value)} aria-label="Filtrer par drone port">
              <option value="">Tous les drone ports</option>
              {ports.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          ) : (
            <div className="port-name">{myPort?.name}</div>
          )}
        </div>

        <nav aria-label="Navigation principale">
          {NAV_SECTIONS.map((s) => {
            const items = s.items.filter((i) => !i.adminOnly || isAdmin);
            if (!items.length) return null;
            return (
              <div key={s.title} className="nav-group">
                <div className="nav-section">{s.title}</div>
                {items.map((n) => (
                  <NavLink key={n.to} to={n.to} end={n.end} title={collapsed ? n.label : undefined}
                    className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
                    <span className="nav-icon"><Icon name={n.icon} /></span>
                    <span className="nav-text">{n.label}</span>
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <div className="user-card">
            <span className="avatar" aria-hidden>{initials(displayName)}</span>
            <div className="user-meta">
              <div className="user-name" title={session.user.email}>{displayName}</div>
              <div className="user-role">{LABELS.role[profile?.role ?? 'pilote']}</div>
            </div>
            <button className="icon-btn" type="button" onClick={() => supabase.auth.signOut()} title="Se déconnecter" aria-label="Se déconnecter">
              <Icon name="logout" size={17} />
            </button>
          </div>
        </div>
      </aside>
      {open && <div className="sidebar-backdrop" onClick={() => setOpen(false)} />}

      <main className="content">
        <header className="appbar">
          <button className="icon-btn appbar-menu" onClick={() => setOpen(true)} aria-label="Menu"><Icon name="menu" /></button>
          <div className="appbar-title">
            {section && <span className="appbar-section">{section}</span>}
            <span className="appbar-page">{title}</span>
          </div>
          <button type="button" className="appbar-search" onClick={() => setPalette(true)} aria-label="Rechercher (Ctrl+K)">
            <Icon name="search" size={16} />
            <span>Rechercher, aller à…</span>
            <kbd>Ctrl K</kbd>
          </button>
          <MgClock />
          <NotificationBell />
          <span className="appbar-port" title="Drone port affiché"><Icon name="pin" size={14} /> {currentPort?.name ?? 'Tous les ports'}</span>
          <Link to="/vols/nouveau" className="btn btn-primary btn-glow appbar-cta"><Icon name="plus" size={16} /> <span>Nouveau vol</span></Link>
        </header>
        <div className={`container${fullBleed ? ' container-full' : narrow ? ' container-narrow' : ''}`} key={loc.pathname + portFilter}>
          <ErrorBoundary>
            <Suspense fallback={<PageLoading />}><Outlet /></Suspense>
          </ErrorBoundary>
        </div>
      </main>
      {loc.pathname !== '/scan' && (
        <Link to="/scan" className="scan-fab" aria-label="Mode atelier : scanner une pièce" title="Scanner une pièce ou un drone"><Icon name="scan" size={24} /></Link>
      )}
      <CommandPalette open={palette} onClose={() => setPalette(false)} isAdmin={isAdmin} />
    </div>
  );
}
