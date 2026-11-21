import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { LiveFlight } from './types';
import type { WindpathLive } from './windpath';

/** Une ligne sans mise à jour depuis 10 min n'est plus affichée */
const STALE_MS = 10 * 60_000;
/** Après l'arrivée, la ligne reste visible 2 min puis est supprimée */
const ARRIVED_KEEP_MS = 2 * 60_000;

interface Options {
  /** drone port affiché ('' = tous, admin) */
  portId: string;
  /** drone choisi pour ce laptop ('' = position non partagée) */
  droneId: string;
  dronePortId: string | null;
  droneCode: string | null;
  userId: string;
  ready: boolean;
  post: (msg: Record<string, unknown>) => void;
}

/**
 * Vols en cours du drone port (table live_flights, temps réel Supabase) :
 *  - partage l'état du vol de ce laptop, reçu de la passerelle WindPath (`share`) ;
 *  - reçoit les vols des autres laptops et les transmet à WindPath (message `traffic`).
 * La visibilité par drone port est assurée par la base (RLS), pas par ce filtre.
 */
export function useLiveTraffic({ portId, droneId, dronePortId, droneCode, userId, ready, post }: Options) {
  const [flights, setFlights] = useState<Record<string, LiveFlight>>({});
  const [shared, setShared] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [hasMission, setHasMission] = useState(false);
  const busy = useRef(false);
  const lastLive = useRef<WindpathLive | null>(null);
  const arrivedAt = useRef<number | null>(null);

  // vols en cours : chargement puis temps réel
  useEffect(() => {
    let alive = true;
    const keep = (f: LiveFlight) => setFlights((s) => ({ ...s, [f.user_id]: f }));
    const drop = (id: string | undefined) => { if (id) setFlights((s) => { const n = { ...s }; delete n[id]; return n; }); };
    let q = supabase.from('live_flights').select('*').gt('updated_at', new Date(Date.now() - STALE_MS).toISOString());
    if (portId) q = q.eq('drone_port_id', portId);
    void q.then(({ data }) => { if (alive) setFlights(Object.fromEntries(((data ?? []) as LiveFlight[]).map((f) => [f.user_id, f]))); });
    const filter = portId ? { filter: `drone_port_id=eq.${portId}` } : {};
    const onRow = (p: RealtimePostgresChangesPayload<LiveFlight>) => { if (p.new && 'user_id' in p.new) keep(p.new as LiveFlight); };
    const ch = supabase.channel(`live-flights-${portId || 'all'}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'live_flights', ...filter }, onRow)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'live_flights', ...filter }, onRow)
      // suppressions : non filtrables par colonne, seule la clé (user_id) est transmise
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'live_flights' },
        (p: RealtimePostgresChangesPayload<LiveFlight>) => drop((p.old as Partial<LiveFlight>)?.user_id))
      .subscribe();
    return () => { alive = false; void supabase.removeChannel(ch); };
  }, [portId]);

  const removeOwn = useCallback(async () => {
    await supabase.from('live_flights').delete().eq('user_id', userId);
    setShared(false);
  }, [userId]);

  /** état du vol envoyé par la passerelle (null = aucune mission) */
  const share = useCallback(async (live: WindpathLive | null) => {
    lastLive.current = live;
    setHasMission(Boolean(live));
    if (!droneId || !dronePortId || busy.current) return;
    busy.current = true;
    try {
      if (live?.status === 'arrive') arrivedAt.current ??= Date.now();
      else arrivedAt.current = null;
      if (!live || (arrivedAt.current && Date.now() - arrivedAt.current > ARRIVED_KEEP_MS)) { await removeOwn(); return; }
      const { error } = await supabase.from('live_flights')
        .upsert({ user_id: userId, drone_id: droneId, drone_port_id: dronePortId, ...live }, { onConflict: 'user_id' });
      if (error) { setShared(false); setShareError(`Position non partagée : ${error.message}`); }
      else { setShared(true); setShareError(null); }
    } finally {
      busy.current = false;
    }
  }, [droneId, dronePortId, userId, removeOwn]);

  // changement de drone : nouvelle ligne tout de suite, ou retrait si plus de drone choisi
  useEffect(() => {
    if (!droneId) { void removeOwn(); return; }
    if (lastLive.current) void share(lastLive.current);
  }, [droneId]); // eslint-disable-line react-hooks/exhaustive-deps

  // autres vols transmis à WindPath (et toutes les 5 s, pour l'âge du signal)
  const reason = !droneId ? 'Position non partagée : choisissez le drone dans la barre de la page.'
    : shareError ?? (!hasMission ? 'Position non partagée : aucune mission chargée.' : null);
  useEffect(() => {
    if (!ready) return;
    const send = () => post({
      type: 'traffic',
      flights: Object.values(flights).filter((f) => f.user_id !== userId && Date.now() - Date.parse(f.updated_at) < STALE_MS),
      self: { sharing: shared && !reason, droneCode, reason },
    });
    send();
    const t = window.setInterval(send, 5000);
    return () => window.clearInterval(t);
  }, [flights, ready, shared, reason, droneCode, userId, post]);

  const others = Object.values(flights).filter((f) => f.user_id !== userId && Date.now() - Date.parse(f.updated_at) < STALE_MS);
  return { share, sharing: shared && !reason, reason, others };
}
