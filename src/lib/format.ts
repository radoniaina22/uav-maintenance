const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

export const num = (v: number | null | undefined, digits = 1) =>
  v == null ? '—' : (digits === 0 ? nf0 : nf1).format(Number(v));

export const hours = (v: number | null | undefined) => (v == null ? '—' : `${num(v)} h`);

export function minutes(v: number | null | undefined) {
  if (v == null) return '—';
  const m = Math.round(Number(v));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h} h ${String(m % 60).padStart(2, '0')}` : `${m} min`;
}

export function date(v: string | null | undefined) {
  if (!v) return '—';
  const [y, m, d] = v.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/** "08:05:00" -> "08:05" */
export const time = (v: string | null | undefined) => (v ? v.slice(0, 5) : '—');

export const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

/** Convertit une chaîne de formulaire vide en null, sinon en nombre. */
export const toNum = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));
export const toStr = (v: string) => (v.trim() === '' ? null : v.trim());

export const LABELS = {
  droneStatus: { operationnel: 'Opérationnel', maintenance: 'En maintenance', immobilise: 'Immobilisé', retire: 'Retiré' },
  batteryStatus: { en_service: 'En service', stock: 'En stock', hors_service: 'Hors service' },
  reportType: { technique: 'Report technique', incident: 'Incident' },
  severity: { mineur: 'Mineur', majeur: 'Majeur', critique: 'Critique' },
  reportStatus: { ouvert: 'Ouvert', en_cours: 'En cours', clos: 'Clos' },
  visitType: { systematique: 'Visite systématique', corrective: 'Corrective', autre: 'Autre' },
  flightStatus: { ouvert: 'Ouvert', cloture: 'Clôturé' },
  flightType: { livraison: 'Livraison', controle: 'Vol de contrôle' },
  organization: { UNFPA: 'UNFPA', MINSAN: 'MINSAN', AUTRE: 'Autres' },
  qrfCause: { meteo: 'Météo', technique: 'Technique', autre: 'Autre' },
  qrfConditions: {
    vent: 'Vent fort', pluie: 'Pluie', orage: 'Orage', visibilite: 'Visibilité réduite / brouillard', turbulence: 'Turbulences',
    gps: 'Perte / dégradation GPS', liaison: 'Perte liaison radio / télémétrie', batterie: 'Alerte batterie / tension',
    moteur: 'Défaut moteur / ESC', vibrations: 'Vibrations anormales', capteurs: 'Erreur capteurs / autopilote',
    largage: 'Système de largage', autre: 'Autre',
  },
  role: { admin: 'Administrateur', pilote: 'Pilote' },
  crewRole: { pilote: 'Pilote', copilote: 'Copilote', stagiaire: 'Pilote en formation' },
} as const;

/** Seuils d'alerte */
export const THRESHOLDS = {
  visitWarnHours: 25, // alerte quand il reste moins de 25 h avant la visite
  batteryWarnPct: 90, // alerte à 90 % des cycles max (450/500)
  healthWarnPct: 85, // capacité réelle < 85 % de la nominale
  healthDangerPct: 75, // capacité réelle < 75 % de la nominale
  cells: 12, // packs Tattu 12S
  cellFull: 4.2, // V/cellule pleine charge
  cellStartWarn: 4.0, // départ en dessous : pack pas pleinement chargé
  cellEndWarn: 3.5, // arrivée en dessous : décharge profonde
  cellEndDanger: 3.3, // arrivée en dessous : décharge critique
};

const nf2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 48.25 -> "48,25 V" */
export const volts = (v: number | null | undefined) => (v == null ? '—' : `${nf2.format(Number(v))} V`);

/** Tension par cellule estimée (pack 12S) */
export const cellVolts = (v: number | null | undefined) => (v == null ? null : Number(v) / THRESHOLDS.cells);

export const cellText = (v: number | null | undefined) => {
  const c = cellVolts(v);
  return c == null ? '—' : `${nf2.format(c)} V/cell.`;
};

export function cellLevel(cell: number | null | undefined, kind: 'start' | 'end'): Level {
  if (cell == null) return 'ok';
  if (kind === 'start') return cell < THRESHOLDS.cellStartWarn ? 'warn' : 'ok';
  if (cell < THRESHOLDS.cellEndDanger) return 'danger';
  if (cell < THRESHOLDS.cellEndWarn) return 'warn';
  return 'ok';
}

/** Affichage de l'organisation */
export const orgText = (f: { organization: string; organization_other?: string | null }) =>
  f.organization === 'AUTRE' ? `Autres : ${f.organization_other ?? '?'}` : f.organization;

export const km = (v: number | null | undefined) => (v == null ? '—' : `${num(v)} km`);

export type Level = 'ok' | 'warn' | 'danger';

export function visitLevel(hoursToNext: number): Level {
  if (hoursToNext <= 0) return 'danger';
  if (hoursToNext <= THRESHOLDS.visitWarnHours) return 'warn';
  return 'ok';
}

/** Conditions de QRF regroupées pour l'affichage */
export const QRF_CONDITION_GROUPS = [
  { key: 'meteo', label: 'Météo', items: ['vent', 'pluie', 'orage', 'visibilite', 'turbulence'] },
  { key: 'technique', label: 'Technique', items: ['gps', 'liaison', 'batterie', 'moteur', 'vibrations', 'capteurs', 'largage'] },
  { key: 'autre', label: 'Autre', items: ['autre'] },
] as const;

export const isTechCondition = (c: string) => (QRF_CONDITION_GROUPS[1].items as readonly string[]).includes(c);
export const isWeatherCondition = (c: string) => (QRF_CONDITION_GROUPS[0].items as readonly string[]).includes(c);

/** Composant du rapport technique correspondant à une condition technique de QRF */
export const QRF_TECH_COMPONENT: Record<string, string> = {
  gps: 'GPS', liaison: 'Liaison radio / télémétrie', batterie: 'Batteries', moteur: 'Moteur principal',
  capteurs: 'Autopilote / capteurs', largage: 'Système de largage',
};

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];

/** 135 -> "SE" (rose des vents 16 directions, O = Ouest) */
export const cardinal = (deg: number | null | undefined) =>
  deg == null ? '' : COMPASS[Math.round((((Number(deg) % 360) + 360) % 360) / 22.5) % 16];

export const windText = (ms: number | null | undefined, deg: number | null | undefined) => {
  if (ms == null && deg == null) return '—';
  const parts = [];
  if (ms != null) parts.push(`${num(ms)} m/s`);
  if (deg != null) parts.push(`${cardinal(deg)} (${deg}°)`);
  return parts.join(' · ');
};

export const COMPASS_POINTS = COMPASS.map((c, i) => ({ label: c, deg: Math.round(i * 22.5) }));

/** Identifiant d'une batterie : "1A" si en pack, sinon numéro de série */
/** Identifiant affiché : position dans le pack (1A…), sinon n° de série, sinon « sans n° » */
export const batteryCode = (b: { code?: string | null; serial_number: string | null }) => b.code ?? b.serial_number ?? 'sans n°';

/** État de santé (capacité mesurée / nominale) */
export function healthLevel(pct: number | null | undefined): Level {
  if (pct == null) return 'ok';
  if (pct < THRESHOLDS.healthDangerPct) return 'danger';
  if (pct < THRESHOLDS.healthWarnPct) return 'warn';
  return 'ok';
}

export function batteryLevel(pct: number): Level {
  if (pct >= 100) return 'danger';
  if (pct >= THRESHOLDS.batteryWarnPct) return 'warn';
  return 'ok';
}
