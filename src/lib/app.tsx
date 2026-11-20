import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, unwrap } from './supabase';
import type { DronePort, MgDistrict, MgRegion, Pilot, Profile } from './types';

const PORT_KEY = 'uav.portFilter';

/** Découpage administratif de Madagascar (référentiel chargé une fois) */
export interface Geo {
  regions: MgRegion[];
  districts: MgDistrict[];
  regionName: (id: number | null | undefined) => string | null;
  districtName: (id: number | null | undefined) => string | null;
  districtsOf: (regionId: number | null | undefined) => MgDistrict[];
  /** « District (Région) », « Région » ou null */
  placeText: (regionId: number | null | undefined, districtId: number | null | undefined) => string | null;
}

function makeGeo(regions: MgRegion[], districts: MgDistrict[]): Geo {
  const r = new Map(regions.map((x) => [x.id, x.name]));
  const d = new Map(districts.map((x) => [x.id, x.name]));
  const regionName = (id: number | null | undefined) => (id == null ? null : r.get(id) ?? null);
  const districtName = (id: number | null | undefined) => (id == null ? null : d.get(id) ?? null);
  return {
    regions, districts, regionName, districtName,
    districtsOf: (regionId) => (regionId == null ? [] : districts.filter((x) => x.region_id === regionId)),
    placeText: (regionId, districtId) => {
      const rn = regionName(regionId), dn = districtName(districtId);
      return dn ? `${dn}${rn ? ` (${rn})` : ''}` : rn;
    },
  };
}

interface AppState {
  geo: Geo;
  session: Session;
  profile: Profile | null;
  pilot: Pilot | null;
  isAdmin: boolean;
  ports: DronePort[];
  /** drone port du pilote connecté */
  myPort: DronePort | null;
  /** filtre actif : '' = tous (admin uniquement), sinon id de drone port */
  portFilter: string;
  setPortFilter: (id: string) => void;
  reloadContext: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function useApp() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp hors AppProvider');
  return c;
}

function readStored() {
  try { return localStorage.getItem(PORT_KEY) ?? ''; } catch { return ''; }
}

export function AppProvider({ session, children }: { session: Session; children: ReactNode }) {
  const [state, setState] = useState<{ profile: Profile | null; pilot: Pilot | null; ports: DronePort[]; geo: Geo } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adminFilter, setAdminFilter] = useState(readStored);

  const load = useCallback(async () => {
    try {
      const profile = unwrap(await supabase.from('profiles').select('*').eq('user_id', session.user.id).maybeSingle()) as Profile | null;
      const [pilot, ports, regions, districts] = await Promise.all([
        profile?.pilot_id
          ? supabase.from('pilots').select('*').eq('id', profile.pilot_id).maybeSingle().then((r) => unwrap(r) as Pilot | null)
          : Promise.resolve(null),
        supabase.from('drone_ports').select('*').order('name').then((r) => unwrap(r) as DronePort[]),
        supabase.from('mg_regions').select('*').order('name').then((r) => unwrap(r) as MgRegion[]),
        supabase.from('mg_districts').select('*').order('name').then((r) => unwrap(r) as MgDistrict[]),
      ]);
      setState({ profile, pilot, ports, geo: makeGeo(regions, districts) });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [session.user.id]);

  useEffect(() => { load(); }, [load]);

  const setPortFilter = (id: string) => {
    setAdminFilter(id);
    try { localStorage.setItem(PORT_KEY, id); } catch { /* stockage indisponible */ }
  };

  if (error) {
    return <div className="center-screen"><div className="card narrow"><div className="alert alert-danger">{error}</div>
      <button className="btn" onClick={() => supabase.auth.signOut()}>Se déconnecter</button></div></div>;
  }
  if (!state) return <div className="center-screen muted">Chargement du profil…</div>;

  const isAdmin = state.profile?.role === 'admin';
  const myPort = state.ports.find((p) => p.id === state.pilot?.drone_port_id) ?? null;

  if (!isAdmin && !myPort) {
    const meta = (session.user.user_metadata ?? {}) as { full_name?: string; requested_port_name?: string };
    const linkedNoPort = !!state.pilot && !state.pilot.drone_port_id;
    return (
      <div className="center-screen login-bg">
        <div className="card pending-card">
          <div className="pending-icon">⏳</div>
          <h1>{meta.full_name ? `Bienvenue, ${meta.full_name.split(' ')[0]} !` : 'Compte en attente'}</h1>
          <p>Votre compte <strong>{session.user.email}</strong> a bien été créé{meta.requested_port_name ? <> pour <strong>{meta.requested_port_name}</strong></> : ''}.</p>
          <ol className="pending-steps">
            <li className="done"><span>✓</span> Compte pilote créé</li>
            <li className={linkedNoPort ? 'done' : 'current'}><span>{linkedNoPort ? '✓' : '2'}</span> Validation par un administrateur</li>
            <li className={linkedNoPort ? 'current' : ''}><span>3</span> Rattachement à un drone port{linkedNoPort ? ' (en cours)' : ''}</li>
          </ol>
          <p className="muted small">Dès la validation, cliquez sur « Vérifier » : vous accéderez aux vols, au carnet de vol et aux données de votre drone port.</p>
          <div className="actions">
            <button className="btn btn-primary" onClick={load}>↺ Vérifier</button>
            <button className="btn btn-ghost" onClick={() => supabase.auth.signOut()}>Se déconnecter</button>
          </div>
        </div>
      </div>
    );
  }

  const portFilter = isAdmin ? (state.ports.some((p) => p.id === adminFilter) ? adminFilter : '') : myPort!.id;

  return (
    <Ctx.Provider value={{ session, ...state, isAdmin, myPort, portFilter, setPortFilter, reloadContext: load }}>
      {children}
    </Ctx.Provider>
  );
}

/** Applique le filtre drone port à une requête (colonne drone_port_id). */
export function byPort<Q>(q: Q, portFilter: string): Q {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return portFilter ? (q as any).eq('drone_port_id', portFilter) : q;
}
