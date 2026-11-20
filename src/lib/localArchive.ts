/**
 * Archivage local des documents (CRM…) dans un dossier de l'ordinateur choisi par l'utilisateur.
 * Utilise l'API « File System Access » (Chrome / Edge sur ordinateur) : le dossier est choisi une fois,
 * mémorisé dans le navigateur (IndexedDB), puis l'application y crée les sous-dossiers et les fichiers.
 * Sans cette API (Firefox, Safari, mobile), le fichier est simplement téléchargé.
 */

// ---- types minimaux de l'API (absents de certaines versions de lib.dom)
interface FsPermission { mode: 'read' | 'readwrite' }
interface DirHandle {
  name: string;
  getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, o?: { create?: boolean }): Promise<{ createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> }> }>;
  queryPermission?(o: FsPermission): Promise<PermissionState>;
  requestPermission?(o: FsPermission): Promise<PermissionState>;
}
type PickerWindow = Window & { showDirectoryPicker?: (o?: { id?: string; mode?: 'readwrite'; startIn?: string }) => Promise<DirHandle> };

/** Dossier racine créé dans le dossier choisi */
export const ARCHIVE_ROOT = 'UAV Maintenance - CRM';

export const archiveSupported = () => typeof window !== 'undefined' && typeof (window as PickerWindow).showDirectoryPicker === 'function';

// ---- mémorisation du dossier choisi (IndexedDB)
const DB = 'uav-archive', STORE = 'handles', KEY = 'root';
function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = fn(open.result.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}
const loadRoot = () => idb<DirHandle | undefined>('readonly', (s) => s.get(KEY) as IDBRequest<DirHandle | undefined>).catch(() => undefined);
const saveRoot = (h: DirHandle) => idb('readwrite', (s) => s.put(h, KEY)).catch(() => undefined);
export const forgetRoot = () => idb('readwrite', (s) => s.delete(KEY)).catch(() => undefined);

/** Nom du dossier actuellement mémorisé (sans demander de permission) */
export async function rememberedFolder() {
  const h = await loadRoot();
  return h?.name ?? null;
}

/** Dossier racine : celui mémorisé (avec permission renouvelée si besoin), sinon choix par l'utilisateur.
 *  À appeler directement dans le clic de l'utilisateur (le navigateur l'exige pour la fenêtre de choix). */
export type ArchiveRoot = DirHandle;
export async function getArchiveRoot(forcePick = false): Promise<DirHandle> {
  return getRoot(forcePick);
}
async function getRoot(forcePick = false): Promise<DirHandle> {
  if (!forcePick) {
    const h = await loadRoot();
    if (h) {
      const opts: FsPermission = { mode: 'readwrite' };
      if ((await h.queryPermission?.(opts)) === 'granted' || (await h.requestPermission?.(opts)) === 'granted') return h;
    }
  }
  const picked = await (window as PickerWindow).showDirectoryPicker!({ id: 'uav-archive', mode: 'readwrite', startIn: 'desktop' });
  await saveRoot(picked);
  return picked;
}

/** Nom de fichier / dossier valide sous Windows */
export const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '') || 'sans nom';

export interface SaveResult { mode: 'dossier' | 'telechargement'; path: string }

/**
 * Enregistre le fichier dans <dossier choisi>/UAV Maintenance - CRM/<segments…>/<fichier>.
 * `forcePick` : redemander le dossier (changer d'emplacement).
 */
export async function saveToArchive(segments: string[], fileName: string, blob: Blob, forcePick = false, rootHandle?: DirHandle): Promise<SaveResult> {
  const name = safeName(fileName);
  if (!archiveSupported()) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return { mode: 'telechargement', path: name };
  }
  const root = rootHandle ?? await getRoot(forcePick);
  let dir = await root.getDirectoryHandle(ARCHIVE_ROOT, { create: true });
  const parts = segments.map(safeName);
  for (const s of parts) dir = await dir.getDirectoryHandle(s, { create: true });
  const file = await dir.getFileHandle(name, { create: true });
  const w = await file.createWritable();
  await w.write(blob);
  await w.close();
  return { mode: 'dossier', path: [root.name, ARCHIVE_ROOT, ...parts, name].join(' › ') };
}

// ---- mémoire des CRM déjà archivés (sur ce poste)
const DONE_KEY = 'uav.crmArchived';
export function archivedOn(id: string): string | null {
  try { return (JSON.parse(localStorage.getItem(DONE_KEY) ?? '{}') as Record<string, string>)[id] ?? null; } catch { return null; }
}
export function markArchived(id: string) {
  try {
    const m = JSON.parse(localStorage.getItem(DONE_KEY) ?? '{}') as Record<string, string>;
    m[id] = new Date().toISOString();
    localStorage.setItem(DONE_KEY, JSON.stringify(m));
  } catch { /* stockage indisponible */ }
}

/** Capture d'un élément HTML (aspect « papier » : classe pdf-capture, éléments .no-print ignorés) */
export async function elementToCanvas(el: HTMLElement): Promise<HTMLCanvasElement> {
  const { default: html2canvas } = await import('html2canvas');
  el.classList.add('pdf-capture');
  try {
    return await html2canvas(el, {
      scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false,
      ignoreElements: (n) => n.classList?.contains('no-print') ?? false,
      windowWidth: el.scrollWidth,
    });
  } finally {
    el.classList.remove('pdf-capture');
  }
}

/**
 * Capture d'un élément HTML en PDF A4 (pages multiples si nécessaire).
 * Les sauts de page tombent entre deux blocs (`blocks`) pour ne pas couper une section en deux.
 */
export async function elementToPdf(el: HTMLElement, blocks = '.crm-box, .crm-head, .crm-foot, tr'): Promise<Blob> {
  // limites basses des blocs, en px CSS depuis le haut de l'élément (mesurées dans l'aspect « papier »)
  el.classList.add('pdf-capture');
  const top = el.getBoundingClientRect().top;
  const cssW = el.offsetWidth;
  const bottoms = Array.from(el.querySelectorAll<HTMLElement>(blocks)).map((b) => b.getBoundingClientRect().bottom - top).sort((a, b) => a - b);
  el.classList.remove('pdf-capture');
  const [canvas, { jsPDF }] = await Promise.all([elementToCanvas(el), import('jspdf')]);
  {
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
    const pageW = 210, pageH = 297, margin = 8;
    const w = pageW - margin * 2;
    const pxPerMm = canvas.width / w;
    const pagePx = Math.floor((pageH - margin * 2) * pxPerMm);
    const k = canvas.width / cssW; // px du canvas par px CSS
    const cuts = bottoms.map((b) => Math.round(b * k));
    let y = 0, first = true;
    while (y < canvas.height) {
      let h = Math.min(pagePx, canvas.height - y);
      if (y + h < canvas.height) {
        // dernier bloc qui se termine dans la page (au moins 40 % de page remplie)
        const cut = [...cuts].reverse().find((c) => c <= y + h && c >= y + pagePx * 0.4);
        if (cut) h = cut - y;
      }
      const slice = document.createElement('canvas');
      slice.width = canvas.width; slice.height = h;
      slice.getContext('2d')!.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
      if (!first) pdf.addPage();
      pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', margin, margin, w, h / pxPerMm);
      y += h; first = false;
    }
    return pdf.output('blob');
  }
}
