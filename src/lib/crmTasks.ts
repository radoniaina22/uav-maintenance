import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import type { CrmTask } from './types';

/** Événement émis après une signature, une annulation ou une clôture de vol : rafraîchit les notifications. */
export const CRM_CHANGED = 'uav:crm-changed';
export const notifyCrmChanged = () => window.dispatchEvent(new Event(CRM_CHANGED));

export const crmNumber = (droneCode: string, seq: number) => `${droneCode}-${String(seq).padStart(4, '0')}`;

const POLL_MS = 60_000;

/**
 * CRM qui attendent la signature de l'utilisateur connecté
 * (visa pilote pour le commandant de bord, visa maintenance pour le responsable de maintenance).
 * Rafraîchi toutes les minutes, au retour sur l'onglet et après chaque signature.
 */
export function useCrmTasks() {
  const [tasks, setTasks] = useState<CrmTask[] | null>(null);
  const [fresh, setFresh] = useState<CrmTask[]>([]);
  const known = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('my_crm_tasks');
    if (error) return;
    const list = (data ?? []) as CrmTask[];
    const keys = new Set(list.map((t) => `${t.flight_id}|${t.kind}`));
    // nouvelles tâches apparues depuis le dernier chargement (pas au premier chargement)
    if (known.current) setFresh(list.filter((t) => !known.current!.has(`${t.flight_id}|${t.kind}`)));
    known.current = keys;
    setTasks(list);
  }, []);

  useEffect(() => {
    load();
    const id = window.setInterval(load, POLL_MS);
    const onFocus = () => { if (document.visibilityState === 'visible') load(); };
    window.addEventListener(CRM_CHANGED, load);
    document.addEventListener('visibilitychange', onFocus);
    return () => { clearInterval(id); window.removeEventListener(CRM_CHANGED, load); document.removeEventListener('visibilitychange', onFocus); };
  }, [load]);

  return { tasks: tasks ?? [], loaded: tasks != null, fresh, clearFresh: () => setFresh([]), reload: load };
}
