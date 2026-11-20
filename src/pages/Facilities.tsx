import { FormEvent, useMemo, useState } from 'react';
import { supabase, unwrap } from '../lib/supabase';
import { useData } from '../lib/useData';
import type { HealthFacility } from '../lib/types';
import { date, toNum, toStr } from '../lib/format';
import { addDays, daysBetween, iso } from '../lib/stats';
import { Badge, Empty, ErrorBox, Field, GeoFields, Loading, Modal, PageHeader } from '../components/ui';
import { byPort, useApp } from '../lib/app';
import LocationPicker, { haversineKm } from '../components/LocationPicker';
import DeliveryMap, { MapFacility } from '../components/DeliveryMap';
import { Icon } from '../components/icons';
import { ChoiceCards, FormSection, QuickChips } from '../components/FormKit';

const km = (v: number) => `${v.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`;

// ---------------------------------------------------------------------
// Fenêtre de création / modification
// ---------------------------------------------------------------------
function FacilityModal({ facility, onClose, onSaved }: { facility: HealthFacility | null; onClose: () => void; onSaved: () => void }) {
  const { ports, portFilter, geo, myPort, isAdmin } = useApp();
  // un pilote crée et gère les CSB de son propre drone port
  const initialPort = facility ? facility.drone_port_id ?? '' : isAdmin ? portFilter : myPort?.id ?? '';
  const portRegion = (portId: string) => ports.find((p) => p.id === portId)?.region_id ?? null;
  const [f, setF] = useState({
    drone_port_id: initialPort,
    name: facility?.name ?? '',
    code: facility?.code ?? '',
    category: facility?.category ?? 'CSB2',
    // nouveau CSB : région du drone port par défaut
    region_id: facility ? facility.region_id : portRegion(initialPort),
    district_id: facility?.district_id ?? null,
    latitude: facility?.latitude?.toString() ?? '',
    longitude: facility?.longitude?.toString() ?? '',
    distance_km: facility?.distance_km?.toString() ?? '',
    active: facility?.active ?? true,
    notes: facility?.notes ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((cur) => ({ ...cur, [k]: v }));
  // position et drone port de référence pour la carte
  const num = (s: string) => (s.trim() === '' || Number.isNaN(Number(s)) ? null : Number(s));
  const lat = num(f.latitude), lon = num(f.longitude);
  const refPort = ports.find((p) => p.id === f.drone_port_id) ?? myPort;
  const reference = refPort ? { name: refPort.name, lat: refPort.latitude != null ? Number(refPort.latitude) : null, lon: refPort.longitude != null ? Number(refPort.longitude) : null } : null;
  const crowKm = lat != null && lon != null && reference?.lat != null && reference.lon != null ? haversineKm([lat, lon], [reference.lat, reference.lon]) : null;
  const dist = num(f.distance_km);
  const missing = [!f.region_id && 'région', (lat == null || lon == null) && 'position GPS', dist == null && 'distance de vol'].filter(Boolean) as string[];

  function pickPort(v: string) {
    // si aucune région n'est encore choisie, on reprend celle du drone port
    setF((cur) => ({ ...cur, drone_port_id: v, region_id: cur.region_id ?? portRegion(v), district_id: cur.region_id ? cur.district_id : null }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const payload = {
      drone_port_id: toStr(f.drone_port_id),
      name: f.name.trim(), code: toStr(f.code), category: f.category as 'CSB1' | 'CSB2',
      region_id: f.region_id, district_id: f.district_id,
      latitude: toNum(f.latitude), longitude: toNum(f.longitude), distance_km: toNum(f.distance_km),
      active: f.active, notes: toStr(f.notes),
    };
    try {
      if (facility) unwrap(await supabase.from('health_facilities').update(payload).eq('id', facility.id));
      else unwrap(await supabase.from('health_facilities').insert(payload));
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.includes('duplicate') ? 'Ce code existe déjà.' : msg.includes('hf_district_in_region') ? "Le district n'appartient pas à la région choisie."
        : msg.includes('row-level security') ? 'Vous ne pouvez gérer que les CSB de votre drone port.' : msg);
      setBusy(false);
    }
  }

  async function remove() {
    if (!facility || !window.confirm(`Supprimer définitivement « ${facility.name} » ?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await supabase.from('health_facilities').delete().eq('id', facility.id).select('id');
      unwrap(res);
      if (!res.data?.length) throw new Error('Suppression refusée : vous ne pouvez supprimer que les CSB de votre drone port.');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={facility ? `Modifier ${facility.name}` : 'Nouvelle formation sanitaire'} onClose={onClose}
      footer={<>
        {facility && <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={remove} disabled={busy}>Supprimer</button>}
        <button className="btn" onClick={onClose}>Annuler</button>
        <button className="btn btn-primary" form="hf-form" disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button>
      </>}>
      <form id="hf-form" className="bm-form hf-form" onSubmit={submit}>
        <FormSection n={1} icon="health" title="Identification">
          <div className="form-grid">
            <Field label="Nom" required><input required value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="ex. Ambohimanga" /></Field>
            <Field label="Code"><input className="mono" value={f.code} onChange={(e) => set('code', e.target.value)} placeholder="facultatif" /></Field>
          </div>
          <ChoiceCards label="Catégorie" value={f.category as 'CSB1' | 'CSB2'} onChange={(v) => set('category', v)} options={[
            { value: 'CSB1', label: 'CSB1', desc: 'Centre de santé de base niveau 1 (paramédical)', icon: 'health', tone: 'info' },
            { value: 'CSB2', label: 'CSB2', desc: 'Centre de santé de base niveau 2 (avec médecin)', icon: 'health', tone: 'ok' },
          ]} />
        </FormSection>

        <FormSection n={2} icon="pin" title="Desservi par" hint={isAdmin ? '« Tous » = destination commune à tous les drone ports' : 'rattaché à votre drone port'}>
          {isAdmin ? (
            <div className="bm-packs">
              <button type="button" className={`bm-pack${!f.drone_port_id ? ' active' : ''}`} onClick={() => pickPort('')}><strong>Tous les drone ports</strong><small>commun</small></button>
              {ports.filter((p) => p.active !== false || p.id === f.drone_port_id).map((p) => (
                <button key={p.id} type="button" className={`bm-pack${f.drone_port_id === p.id ? ' active' : ''}`} onClick={() => pickPort(p.id)}><strong>{p.name}</strong></button>
              ))}
            </div>
          ) : <div className="bm-packs"><span className="bm-pack active"><strong>{myPort?.name}</strong></span></div>}
        </FormSection>

        <FormSection n={3} icon="search" title="Localisation" hint="cliquez sur la carte pour placer le CSB">
          <div className="form-grid">
            <GeoFields regions={geo.regions} districtsOf={geo.districtsOf} regionId={f.region_id} districtId={f.district_id}
              onChange={(r, d) => setF((cur) => ({ ...cur, region_id: r, district_id: d }))} />
            <Field label="Latitude"><input className="mono" type="number" step="0.000001" min="-90" max="90" value={f.latitude} onChange={(e) => set('latitude', e.target.value)} /></Field>
            <Field label="Longitude"><input className="mono" type="number" step="0.000001" min="-180" max="180" value={f.longitude} onChange={(e) => set('longitude', e.target.value)} /></Field>
          </div>
          <div className="hf-map">
            <LocationPicker lat={lat} lon={lon} reference={reference}
              onChange={(la, lo) => setF((cur) => ({ ...cur, latitude: String(la), longitude: String(lo) }))} />
          </div>
        </FormSection>

        <FormSection n={4} icon="flight" title="Distance de vol" hint="reprise automatiquement dans les vols">
          <div className="hf-dist">
            <Field label="Distance depuis le drone port (km)">
              <input type="number" step="0.1" min="0" inputMode="decimal" value={f.distance_km} onChange={(e) => set('distance_km', e.target.value)} />
            </Field>
            {crowKm != null ? (
              <div className="hf-crow">
                <span className="pd-kicker">À vol d'oiseau depuis {reference!.name}</span>
                <strong>{km(crowKm)}</strong>
                <button type="button" className="rf-chip" onClick={() => set('distance_km', crowKm.toFixed(1))}>↺ reprendre comme distance de vol</button>
                {dist != null && dist < crowKm - 0.2 && <span className="small text-warn">La distance saisie est plus courte que la ligne droite.</span>}
              </div>
            ) : <p className="small muted">Placez le CSB sur la carte pour obtenir la distance à vol d'oiseau.</p>}
          </div>
        </FormSection>

        <FormSection n={5} icon="shield" title="Statut & notes">
          <ChoiceCards label="Statut" value={f.active ? 'on' : 'off'} onChange={(v) => set('active', v === 'on')} options={[
            { value: 'on', label: 'Destination active', desc: 'proposée dans les nouveaux vols', icon: 'flight', tone: 'ok' },
            { value: 'off', label: 'Inactive', desc: 'historique conservé, plus proposée', icon: 'box', tone: 'neutral' },
          ]} />
          <QuickChips items={['Zone de largage dégagée', 'Contact sur place : ', 'Accès difficile en saison des pluies', 'Obstacles (arbres, lignes)']} value={f.notes} onChange={(v) => set('notes', v)} />
          <textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} aria-label="Notes" placeholder="Zone de largage, contact, accès…" />
        </FormSection>

        {missing.length > 0 && <div className="fk-note warn"><Icon name="alert" size={14} /> À compléter : {missing.join(', ')}. Ces informations servent à la carte, aux statistiques et au calcul des vols.</div>}
        <ErrorBox error={error} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Page : le réseau des formations sanitaires
// ---------------------------------------------------------------------
type View = 'cartes' | 'tableau';
const VIEW_KEY = 'uav.facilitiesView';

export default function Facilities() {
  const [modal, setModal] = useState<{ facility: HealthFacility | null } | null>(null);
  const [region, setRegion] = useState('');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<'' | 'CSB1' | 'CSB2'>('');
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [view, setViewState] = useState<View>(() => { try { return localStorage.getItem(VIEW_KEY) === 'tableau' ? 'tableau' : 'cartes'; } catch { return 'cartes'; } });
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* stockage indisponible */ } };
  const { portFilter, isAdmin, ports, geo, myPort } = useApp();
  const todayIso = iso(new Date());
  // administrateur : tous les CSB ; pilote : les CSB de son drone port (les CSB communs restent à l'administrateur)
  const canEdit = (h: HealthFacility) => isAdmin || (!!myPort && h.drone_port_id === myPort.id);

  const { data, error, loading, reload } = useData(async () => {
    let fq = supabase.from('health_facilities').select('*');
    if (portFilter) fq = fq.or(`drone_port_id.is.null,drone_port_id.eq.${portFilter}`);
    const [hf, fl] = await Promise.all([
      fq.order('active', { ascending: false }).order('name'),
      byPort(supabase.from('v_flights').select('destination_id, flight_type, qrf, payload_kg, flight_date'), portFilter)
        .gte('flight_date', addDays(todayIso, -89)).not('destination_id', 'is', null).limit(10000),
    ]);
    return {
      facilities: unwrap(hf) as HealthFacility[],
      flights: (unwrap(fl) ?? []) as { destination_id: string; flight_type: string; qrf: boolean; payload_kg: number | null; flight_date: string }[],
    };
  }, [portFilter]);

  // livraisons réussies par CSB (30 et 90 jours)
  const stats = useMemo(() => {
    const m = new Map<string, { d30: number; d90: number; kg30: number; last: string | null }>();
    for (const f of data?.flights ?? []) {
      if (f.flight_type !== 'livraison' || f.qrf) continue;
      const s = m.get(f.destination_id) ?? { d30: 0, d90: 0, kg30: 0, last: null };
      s.d90++;
      if (daysBetween(f.flight_date, todayIso) < 30) { s.d30++; s.kg30 += Number(f.payload_kg ?? 0); }
      if (!s.last || f.flight_date > s.last) s.last = f.flight_date;
      m.set(f.destination_id, s);
    }
    return m;
  }, [data, todayIso]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const portName = (id: string | null) => (id ? ports.find((p) => p.id === id)?.name ?? '—' : 'Tous les drone ports');
  const incomplete = (h: HealthFacility) => [
    !h.region_id && 'région', (h.latitude == null || h.longitude == null) && 'GPS', h.distance_km == null && 'distance',
  ].filter(Boolean) as string[];
  const all = data.facilities;
  const active = all.filter((h) => h.active);
  const rows = all.filter((h) => (showInactive || h.active) && (!region || String(h.region_id) === region) && (!cat || h.category === cat)
    && (!onlyIncomplete || incomplete(h).length > 0)
    && (!q || `${h.name} ${h.code ?? ''} ${geo.regionName(h.region_id) ?? ''} ${geo.districtName(h.district_id) ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  const served = active.filter((h) => (stats.get(h.id)?.d30 ?? 0) > 0);
  const toComplete = active.filter((h) => incomplete(h).length > 0);
  const dists = active.map((h) => h.distance_km).filter((d): d is number => d != null).map(Number);
  const avgDist = dists.length ? dists.reduce((a, b) => a + b, 0) / dists.length : null;
  const maxDist = dists.length ? Math.max(...dists) : null;
  const shownPorts = portFilter ? ports.filter((p) => p.id === portFilter) : ports;
  const mapFacilities: MapFacility[] = rows.filter((h) => h.active).map((h) => ({
    id: h.id, name: h.name, latitude: h.latitude, longitude: h.longitude, distance_km: h.distance_km,
    deliveries: stats.get(h.id)?.d30 ?? 0, kg: stats.get(h.id)?.kg30 ?? 0, last: stats.get(h.id)?.last ?? null,
  }));

  return (
    <div className="hf-page">
      <PageHeader title="Formations sanitaires" subtitle="Le réseau des destinations : Centres de Santé de Base desservis par drone"
        actions={(isAdmin || myPort) && <button className="btn btn-primary" onClick={() => setModal({ facility: null })}>+ Nouveau CSB</button>} />

      <div className="flight-kpis pl-kpis">
        <div className="fk"><span className="fk-icon"><Icon name="health" size={18} /></span>
          <div><strong>{active.length}</strong><span>CSB actif(s) · {active.filter((h) => h.category === 'CSB1').length} CSB1 / {active.filter((h) => h.category === 'CSB2').length} CSB2</span></div></div>
        <div className="fk fk-ok"><span className="fk-icon"><Icon name="flight" size={18} /></span>
          <div><strong>{served.length}</strong><span>desservi(s) sur 30 jours</span></div></div>
        <div className={`fk${active.length - served.length ? ' fk-warn' : ''}`}><span className="fk-icon"><Icon name="clock" size={18} /></span>
          <div><strong>{active.length - served.length}</strong><span>sans livraison depuis 30 jours</span></div></div>
        <div className="fk"><span className="fk-icon"><Icon name="pin" size={18} /></span>
          <div><strong>{avgDist != null ? km(avgDist) : '—'}</strong><span>distance moyenne{maxDist != null ? ` · max ${km(maxDist)}` : ''}</span></div></div>
        <button type="button" className={`fk fk-action${toComplete.length ? ' fk-warn' : ' fk-ok'}`} onClick={() => setOnlyIncomplete(!onlyIncomplete)}>
          <span className="fk-icon"><Icon name="pen" size={18} /></span>
          <div><strong>{toComplete.length}</strong><span>{toComplete.length ? 'fiche(s) à compléter (GPS, distance, région)' : 'toutes les fiches sont complètes'}</span></div></button>
      </div>

      <section className="card hf-map-card">
        <div className="row-between">
          <h2 className="card-title">Carte du réseau</h2>
          <span className="small muted">{mapFacilities.filter((f) => f.latitude != null).length} CSB localisé(s) · taille = livraisons sur 30 jours</span>
        </div>
        <DeliveryMap ports={shownPorts} facilities={mapFacilities} height={360} />
        <div className="map-legend small muted">
          <span><i className="dot dot-served" /> CSB desservi</span>
          <span><i className="dot dot-idle" /> sans livraison depuis 30 jours</span>
          <span><i className="dot-base" />Drone port</span>
        </div>
      </section>

      <div className="card filters pl-filters">
        <label className="field field-grow"><span className="field-label">Recherche</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nom, code, région, district…" /></label>
        <label className="field"><span className="field-label">Région</span>
          <select value={region} onChange={(e) => setRegion(e.target.value)}>
            <option value="">Toutes</option>
            {geo.regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select></label>
        <div className="field pl-sort"><span className="field-label">Catégorie</span>
          <div className="segmented segmented-sm">
            {([['', 'Toutes'], ['CSB1', 'CSB1'], ['CSB2', 'CSB2']] as const).map(([k, l]) => <button key={k} type="button" className={cat === k ? 'active' : ''} onClick={() => setCat(k)}>{l}</button>)}
          </div></div>
        <div className="field pl-sort"><span className="field-label">Affichage</span>
          <div className="segmented segmented-sm">
            <button type="button" className={view === 'cartes' ? 'active' : ''} onClick={() => setView('cartes')}>Cartes</button>
            <button type="button" className={view === 'tableau' ? 'active' : ''} onClick={() => setView('tableau')}>Tableau</button>
          </div></div>
        <label className="check"><input type="checkbox" checked={onlyIncomplete} onChange={(e) => setOnlyIncomplete(e.target.checked)} /> À compléter</label>
        <label className="check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Inactives</label>
      </div>

      {rows.length === 0 ? <Empty>Aucune formation sanitaire pour ces critères.</Empty> : view === 'cartes' ? (
        <div className="hf-grid">
          {rows.map((h) => {
            const s = stats.get(h.id);
            const miss = incomplete(h);
            const since = s?.last ? daysBetween(s.last, todayIso) : null;
            const freshness = since == null ? 'none' : since <= 7 ? 'fresh' : since <= 30 ? 'ok' : 'old';
            return (
              <article key={h.id} className={`hf-card cat-${h.category}${h.active ? '' : ' is-off'}`}>
                <header className="hf-head">
                  <span className={`hf-cat cat-${h.category}`}>{h.category}</span>
                  <div className="hf-id">
                    <strong>{h.name}</strong>
                    <span>{[geo.regionName(h.region_id), geo.districtName(h.district_id)].filter(Boolean).join(' · ') || <span className="text-warn">région à renseigner</span>}</span>
                  </div>
                  {!h.active && <Badge level="neutral">Inactive</Badge>}
                </header>
                <div className="hf-figures">
                  <div><b>{h.distance_km != null ? km(Number(h.distance_km)) : '—'}</b><span>distance de vol</span></div>
                  <div><b>{s?.d30 ?? 0}</b><span>livraisons · 30 j</span></div>
                  <div><b>{s?.kg30 ? `${s.kg30.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} kg` : '—'}</b><span>livrés · 30 j</span></div>
                </div>
                <div className="hf-meta">
                  <span><Icon name="pin" size={12} /> {portName(h.drone_port_id)}</span>
                  <span className={`hf-fresh f-${freshness}`}>{since == null ? 'aucune livraison (90 j)' : since === 0 ? 'livré aujourd\'hui' : `dernière livraison ${date(s!.last)} (${since} j)`}</span>
                </div>
                {miss.length > 0 && <div className="hf-missing"><Icon name="alert" size={12} /> à compléter : {miss.join(', ')}</div>}
                {h.notes && <p className="hf-notes">{h.notes}</p>}
                <footer className="hf-foot">
                  {h.code && <span className="mono small muted">{h.code}</span>}
                  <span className="hf-actions">
                    {h.latitude != null && h.longitude != null && (
                      <a className="btn btn-sm btn-ghost" href={`https://www.openstreetmap.org/?mlat=${h.latitude}&mlon=${h.longitude}#map=14/${h.latitude}/${h.longitude}`} target="_blank" rel="noreferrer">Carte ↗</a>
                    )}
                    {canEdit(h)
                      ? <button className="btn btn-sm" onClick={() => setModal({ facility: h })}>Modifier</button>
                      : <span className="small muted" title="CSB commun à tous les drone ports : géré par l'administrateur">Commun</span>}
                  </span>
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="card no-pad">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Nom</th><th>Catégorie</th><th>Région</th><th>District</th><th>Desservi par</th><th className="num">Distance</th><th className="num">Livraisons 30 j</th><th>Dernière</th><th>Statut</th><th></th></tr></thead>
              <tbody>
                {rows.map((h) => {
                  const s = stats.get(h.id);
                  return (
                    <tr key={h.id} className={h.active ? '' : 'row-muted'}>
                      <td><strong>{h.name}</strong>{h.code && <div className="small muted mono">{h.code}</div>}</td>
                      <td><span className={`hf-cat cat-${h.category}`}>{h.category}</span></td>
                      <td>{geo.regionName(h.region_id) ?? <span className="text-warn">À renseigner</span>}</td>
                      <td>{geo.districtName(h.district_id) ?? '—'}</td>
                      <td>{portName(h.drone_port_id)}</td>
                      <td className="num nowrap">{h.distance_km != null ? km(Number(h.distance_km)) : <span className="text-warn">À renseigner</span>}</td>
                      <td className="num">{s?.d30 ?? 0}</td>
                      <td>{s?.last ? date(s.last) : '—'}</td>
                      <td><Badge level={h.active ? 'ok' : 'neutral'}>{h.active ? 'Active' : 'Inactive'}</Badge></td>
                      <td>{canEdit(h)
                        ? <button className="btn btn-sm" onClick={() => setModal({ facility: h })}>Modifier</button>
                        : <span className="small muted nowrap" title="CSB commun à tous les drone ports : géré par l'administrateur">Commun</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {modal && <FacilityModal facility={modal.facility} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
    </div>
  );
}
