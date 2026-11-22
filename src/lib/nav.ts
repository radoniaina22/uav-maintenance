import type { IconName } from '../components/icons';

export interface NavItem { to: string; label: string; icon: IconName; end?: boolean; adminOnly?: boolean; keywords?: string }
export interface NavSection { title: string; items: NavItem[] }

/** Navigation principale, regroupée par usage */
export const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Opérations',
    items: [
      { to: '/', label: 'Tableau de bord', icon: 'dashboard', end: true, keywords: 'accueil alertes' },
      { to: '/vols', label: 'Vols', icon: 'flight', keywords: 'livraison journal' },
      { to: '/planification', label: 'Planification', icon: 'wind', keywords: 'windpath vent météo mission waypoints' },
      { to: '/carnet', label: 'Carnet de vol', icon: 'book', keywords: 'heures pilote' },
      { to: '/classement', label: 'Classement', icon: 'trophy', keywords: 'podium rang heures de vol palier meilleur pilote drone flotte nombre de vols' },
      { to: '/statistiques', label: 'Statistiques', icon: 'stats', keywords: 'graphiques indicateurs export' },
      { to: '/rapports-mensuels', label: 'Rapports mensuels', icon: 'book', keywords: 'rapport mois bilan unfpa livraisons pdf district csb email' },
      { to: '/consommation', label: 'Consommation', icon: 'bolt', keywords: 'mah énergie batterie autonomie csb drone analyse' },
    ],
  },
  {
    title: 'Maintenance',
    items: [
      { to: '/alertes', label: 'Alertes', icon: 'bell', keywords: 'e-mail mail notification visite potentiel météo retard crm seuil' },
      { to: '/rapports', label: 'Rapports & incidents', icon: 'alert', keywords: 'technique défaillance' },
      { to: '/drones', label: 'Drones & visites', icon: 'drone', keywords: '250 h visite systématique mal1 mal2 mal3' },
      { to: '/ordres-travail', label: 'Ordres de travail', icon: 'wrench', keywords: 'ot intervention maintenance signature responsable' },
      { to: '/pieces', label: 'Pièces & stock', icon: 'chip', keywords: 'moteur esc hélice servo quarantaine potentiel' },
      { to: '/batteries', label: 'Batteries', icon: 'battery', keywords: 'pack cycles capacité tattu' },
    ],
  },
  {
    title: 'Référentiels',
    items: [
      { to: '/pilotes', label: 'Pilotes', icon: 'users', keywords: 'équipage' },
      { to: '/csb', label: 'Formations sanitaires', icon: 'health', keywords: 'csb destination région district' },
    ],
  },
  {
    title: 'Administration',
    items: [
      { to: '/drone-ports', label: 'Drone ports', icon: 'pin', adminOnly: true, keywords: 'base' },
      { to: '/utilisateurs', label: 'Utilisateurs', icon: 'shield', adminOnly: true, keywords: 'comptes rôles' },
      { to: '/audit', label: "Journal d'audit", icon: 'book', adminOnly: true, keywords: 'historique modifications traçabilité qui quand' },
    ],
  },
];

/** Actions rapides proposées dans la palette de commandes */
export const QUICK_ACTIONS: NavItem[] = [
  { to: '/vols/nouveau', label: 'Saisir un nouveau vol', icon: 'plus', keywords: 'créer vol livraison' },
  { to: '/ordres-travail?nouveau=1', label: 'Ouvrir un ordre de travail', icon: 'wrench', keywords: 'ot intervention maintenance' },
  { to: '/crm/export', label: 'Exporter plusieurs CRM (PDF)', icon: 'box', keywords: 'compte rendu matériel export pdf archive dossier semaine' },
  { to: '/vols?statut=ouvert', label: 'Vols à clôturer', icon: 'book', keywords: 'ouvert clôture carnet' },
  { to: '/vols?qrf=oui', label: 'Voir les QRF', icon: 'wind', keywords: 'retour météo demi-tour' },
  { to: '/pieces?onglet=stock', label: 'Stock de pièces par drone port', icon: 'box', keywords: 'rechange minimum rupture' },
  { to: '/pieces?onglet=quarantaine', label: 'Pièces en quarantaine', icon: 'wrench', keywords: 'défaillance rebut' },
  { to: '/scan', label: 'Mode atelier : scanner une pièce ou un drone', icon: 'scan', keywords: 'qr code scanner caméra douchette étiquette monter démonter quarantaine téléphone' },
  { to: '/rapports', label: 'Rapports non clos', icon: 'alert', keywords: 'incident ouvert' },
];

/** Titre de la page courante (barre supérieure) */
export function pageTitle(pathname: string): { section: string; title: string } {
  if (pathname.startsWith('/vols/nouveau')) return { section: 'Opérations', title: 'Nouveau vol' };
  if (pathname === '/crm/export') return { section: 'Opérations · Vols', title: 'Export des CRM' };
  if (/^\/ordres-travail\/[^/]+/.test(pathname)) return { section: 'Maintenance · Ordres de travail', title: 'Fiche OT' };
  if (/^\/vols\/[^/]+\/crm/.test(pathname)) return { section: 'Opérations · Vols', title: 'Compte rendu matériel' };
  if (/^\/vols\/[^/]+\/modifier/.test(pathname)) return { section: 'Opérations · Vols', title: 'Modifier le vol' };
  if (/^\/vols\/[^/]+/.test(pathname)) return { section: 'Opérations · Vols', title: 'Fiche du vol' };
  if (/^\/drones\/[^/]+\/historique/.test(pathname)) return { section: 'Maintenance · Drones', title: 'Historique technique' };
  if (/^\/drones\/[^/]+/.test(pathname)) return { section: 'Maintenance · Drones', title: 'Fiche drone' };
  if (pathname === '/pieces/etiquettes') return { section: 'Maintenance · Pièces', title: 'Étiquettes QR' };
  if (pathname === '/scan') return { section: 'Maintenance · Pièces', title: 'Mode atelier' };
  if (/^\/pieces\/[^/]+/.test(pathname)) return { section: 'Maintenance · Pièces', title: 'Fiche pièce' };
  if (/^\/batteries\/[^/]+/.test(pathname)) return { section: 'Maintenance · Batteries', title: 'Fiche batterie' };
  if (/^\/carnet\/[^/]+/.test(pathname)) return { section: 'Opérations', title: 'Carnet de vol' };
  for (const s of NAV_SECTIONS) {
    const item = s.items.find((i) => (i.end ? pathname === i.to : pathname === i.to || pathname.startsWith(`${i.to}/`)));
    if (item) return { section: s.title, title: item.label };
  }
  return { section: '', title: 'UAV Maintenance' };
}
