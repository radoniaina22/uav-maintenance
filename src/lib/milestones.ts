/**
 * Paliers d'heures de vol : 10, 25, 50, 100, 250 h, puis tous les 500 h (500, 1000, 1500, 2000…), sans limite.
 */
export const BASE_MILESTONES = [10, 25, 50, 100, 250];
export const MILESTONE_STEP = 500;

/** Prochain palier strictement supérieur aux heures données */
export function nextMilestone(hours: number): number {
  const b = BASE_MILESTONES.find((m) => m > hours);
  return b ?? (Math.floor(hours / MILESTONE_STEP) + 1) * MILESTONE_STEP;
}

/** Dernier palier franchi (0 si aucun) */
export function prevMilestone(hours: number): number {
  if (hours >= MILESTONE_STEP) return Math.floor(hours / MILESTONE_STEP) * MILESTONE_STEP;
  return [...BASE_MILESTONES].reverse().find((m) => m <= hours) ?? 0;
}

/** Progression vers le prochain palier */
export function milestoneProgress(hours: number) {
  const next = nextMilestone(hours), prev = prevMilestone(hours);
  return { prev, next, remaining: next - hours, pct: Math.max(0, Math.min(100, (100 * (hours - prev)) / (next - prev))) };
}

/** Tous les paliers jusqu'au prochain inclus (pour afficher les distinctions) */
export function milestonesUpTo(hours: number): number[] {
  const out = [...BASE_MILESTONES];
  for (let m = MILESTONE_STEP; m <= nextMilestone(hours); m += MILESTONE_STEP) out.push(m);
  return out;
}
