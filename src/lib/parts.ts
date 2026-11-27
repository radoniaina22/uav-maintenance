import type { Level } from './format';
import { supabase } from './supabase';
import type { PartEventRow, PartRow, PartStatus, PartType } from './types';

/** Zones cliquables sur la photo du Tango 4 (positions en % de l'image public/tango4.png).
 *  La photo montre le drone vu de face : gauche / droite s'entendent pour un pilote placé
 *  derrière le drone, donc la gauche du drone apparaît à droite de l'image. */
export const TANGO4_ZONES: { code: string; label: string; x: number; y: number }[] = [
  { code: 'vtol_avd', label: 'VTOL avant droit', x: 24.4, y: 67.7 },
  { code: 'vtol_ard', label: 'VTOL arrière droit', x: 35.6, y: 42.2 },
  { code: 'vtol_avg', label: 'VTOL avant gauche', x: 47.8, y: 83.1 },
  { code: 'vtol_arg', label: 'VTOL arrière gauche', x: 57.2, y: 50.9 },
  { code: 'propulsion', label: 'Propulsion arrière', x: 47.6, y: 41.5 },
  { code: 'aile_d', label: 'Aile droite', x: 18.3, y: 36.2 },
  { code: 'aile_g', label: 'Aile gauche', x: 80.6, y: 60.3 },
  { code: 'empennage', label: 'Empennage', x: 55.6, y: 22.8 },
  { code: 'avionique', label: 'Avionique (fuselage)', x: 41.1, y: 57.5 },
  { code: 'soute', label: 'Soute & largage', x: 37.2, y: 77.5 },
];

export const zoneLabel = (code: string | null | undefined) => TANGO4_ZONES.find((z) => z.code === code)?.label ?? code ?? '—';

export const PART_STATUS: Record<PartStatus, { label: string; level: Level | 'neutral' | 'info' }> = {
  stock: { label: 'En stock', level: 'ok' },
  monte: { label: 'Montée', level: 'info' },
  quarantaine: { label: 'Quarantaine', level: 'warn' },
  rebut: { label: 'Rebut', level: 'neutral' },
};

export const PART_EVENT: Record<PartEventRow['event_type'], { label: string; icon: string }> = {
  entree_stock: { label: 'Entrée en stock', icon: '＋' },
  montage: { label: 'Montage', icon: '⤓' },
  demontage: { label: 'Démontage', icon: '⤒' },
  quarantaine: { label: 'Mise en quarantaine', icon: '⚠' },
  remise_en_stock: { label: 'Remise en stock', icon: '↺' },
  rebut: { label: 'Mise au rebut', icon: '✕' },
  transfert: { label: 'Transfert', icon: '⇄' },
};

/** Seuils d'alerte sur le potentiel (heures consommées / potentiel) */
export const POTENTIAL_WARN_PCT = 90;

export function potentialLevel(p: Pick<PartRow, 'potential_pct'>): Level | 'unknown' {
  if (p.potential_pct == null) return 'unknown';
  if (p.potential_pct >= 100) return 'danger';
  if (p.potential_pct >= POTENTIAL_WARN_PCT) return 'warn';
  return 'ok';
}

/** Niveau d'un pourcentage de potentiel (heures ou cycles) */
export const pctLevel = (pct: number | null | undefined): Level | 'unknown' =>
  pct == null ? 'unknown' : Number(pct) >= 100 ? 'danger' : Number(pct) >= POTENTIAL_WARN_PCT ? 'warn' : 'ok';

export const remainingCycles = (p: Pick<PartRow, 'total_cycles' | 'max_cycles_effective'>) =>
  p.max_cycles_effective == null ? null : Number(p.max_cycles_effective) - Number(p.total_cycles);

/** Cycles : « 1 cycle », « 12 cycles » */
export const cycles = (n: number | null | undefined) => (n == null ? '—' : `${Number(n).toLocaleString('fr-FR')} cycle${Math.abs(Number(n)) > 1 ? 's' : ''}`);

export const remainingHours = (p: Pick<PartRow, 'total_hours' | 'max_hours_effective'>) =>
  p.max_hours_effective == null ? null : Number(p.max_hours_effective) - Number(p.total_hours);

/** Types montables sur un emplacement de type `slotType` : lui-même et les types du même
 *  groupe d'interchangeabilité (`part_types.swap_group`, ex. servo d'aileron <-> servo de gouverne).
 *  La règle est vérifiée en base par `mount_part`. */
export function compatibleTypes(types: Pick<PartType, 'code' | 'swap_group'>[], slotType: string): string[] {
  const group = types.find((t) => t.code === slotType)?.swap_group;
  if (!group) return [slotType];
  return [slotType, ...types.filter((t) => t.swap_group === group && t.code !== slotType).map((t) => t.code)];
}

/** Même calcul en chargeant les types depuis la base */
export async function fetchCompatibleTypes(slotType: string): Promise<string[]> {
  const { data } = await supabase.from('part_types').select('code, swap_group');
  return compatibleTypes((data ?? []) as Pick<PartType, 'code' | 'swap_group'>[], slotType);
}

/** Avertissements non bloquants avant un montage (montage croisé, marque différente…) */
export async function fetchMountWarnings(partId: string, droneId: string, slot: string | null): Promise<string[]> {
  if (!slot) return [];
  const { data } = await supabase.rpc('part_mount_warnings', { p_part: partId, p_drone: droneId, p_slot: slot });
  return (data ?? []) as string[];
}

/** Valeur par défaut d'un champ datetime-local : maintenant, heure locale */
export const nowLocal = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

export const dateTime = (v: string | null | undefined) => {
  if (!v) return '—';
  const [d, t] = v.split('T');
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}${t ? ` ${t.slice(0, 5)}` : ''}`;
};
