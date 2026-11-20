import type { WorkOrderKind, WorkOrderPriority, WorkOrderStatus } from './types';

export const WO_STATUS: Record<WorkOrderStatus, { label: string; level: 'neutral' | 'info' | 'warn' | 'ok' }> = {
  ouvert: { label: 'Ouvert', level: 'neutral' },
  en_cours: { label: 'En cours', level: 'info' },
  termine: { label: 'Terminé · à signer', level: 'warn' },
  cloture: { label: 'Clôturé', level: 'ok' },
};
export const WO_STEPS: WorkOrderStatus[] = ['ouvert', 'en_cours', 'termine', 'cloture'];
export const WO_KIND: Record<WorkOrderKind, string> = {
  visite: 'Visite', corrective: 'Corrective', remplacement: 'Remplacement de pièce', inspection: 'Inspection', autre: 'Autre',
};
export const WO_PRIORITY: Record<WorkOrderPriority, string> = { normale: 'Normale', haute: 'Haute', urgente: 'Urgente' };
