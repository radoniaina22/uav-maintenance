import { ComponentType, lazy } from 'react';

const RELOAD_KEY = 'uav.chunkReload';

/**
 * Page chargée à la demande (React.lazy).
 * Si le fichier de la page est introuvable (nouvelle version déployée pendant que l'onglet était ouvert,
 * ou coupure réseau), la page est rechargée une fois pour récupérer la version à jour.
 */
export function lazyPage<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      const mod = await load();
      try { sessionStorage.removeItem(RELOAD_KEY); } catch { /* stockage indisponible */ }
      return mod;
    } catch (err) {
      let reloaded = false;
      try { reloaded = sessionStorage.getItem(RELOAD_KEY) === '1'; sessionStorage.setItem(RELOAD_KEY, '1'); } catch { /* stockage indisponible */ }
      if (!reloaded && navigator.onLine) {
        window.location.reload();
        return new Promise<never>(() => {}); // la page se recharge
      }
      throw err;
    }
  });
}

/** Affiché pendant le téléchargement d'une page */
export function PageLoading() {
  return (
    <div className="page-loading" role="status" aria-live="polite">
      <span className="page-loading-bar" />
      <span className="muted small">Chargement de la page…</span>
    </div>
  );
}
