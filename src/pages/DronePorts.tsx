import { FormEvent, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { useApp } from '../lib/app';
import { useData } from '../lib/useData';
import type { DronePort } from '../lib/types';
import { LABELS, toNum, toStr } from '../lib/format';
import { addDays, daysBetween, iso } from '../lib/stats';
import { flightVerdict, useWeather } from '../lib/dashboard';
import { Badge, Empty, ErrorBox, Field, GeoFields, Loading, Modal, PageHeader } from '../components/ui';
import LocationPicker, { haversineKm } from '../components/LocationPicker';
import PortRadar, { RadarBlip } from '../components/PortRadar';
import { Icon } from '../components/icons';
import { ChoiceCards, FormSection, QuickChips } from '../components/FormKit';

const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join('') || '?';
const hue = (s: string) => Math.round(([...s].reduce((h, c) => h + c.charCodeAt(0) * 7, 0) * 137.508) % 360);
const kmTxt = (v: number) => `${v.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`;

interface Fac { id: string; name: string; latitude: number | null; longitude: number | null; drone_port_id: string | null; active: boolean }

// ---------------------------------------------------------------------
// Fenêtre de création / modification
// ---------------------------------------------------------------------
function PortModal({ port, onClose, onSaved }: { port: DronePort | null; onClose: () => void; onSaved: () => void }) {
  const { geo } = useApp();
  const [f, setF] = useState({
    name: port?.name ?? '', code: port?.code ?? '',
    region_id: port?.region_id ?? null, district_id: port?.district_id ?? null,
    latitude: port?.latitude?.toString() ?? '', longitude: port?.longitude?.toString() ?? '',
    active: port?.active ?? true, notes: port?.notes ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((cur) => ({ ...cur, [k]: v }));
  // CSB desservis par ce drone port, affichés sur la carte et le radar
  const csbs = useData(async () => (port
    ? unwrap(await supabase.from('health_facilities').select('name, latitude, longitude').eq('drone_port_id', port.id).eq('active', true).order('name')) as
      { name: string; latitude: number | null; longitude: number | null }[]
    : []), [port?.id]);
  const num = (s: string) => (s.trim() === '' || Number.isNaN(Number(s)) ? null : Number(s));
  const others = (csbs.data ?? []).map((c) => ({ name: c.name, lat: c.latitude != null ? Number(c.latitude) : null, lon: c.longitude != null ? Number(c.longitude) : null }));
  const lat = num(f.latitude), lon = num(f.longitude);
  const located = others.filter((o) => o.lat != null && o.lon != null) as { name: string; lat: number; lon: number }[];
  const dists = lat != null && lon != null ? located.map((o) => haversineKm([lat, lon], [o.lat, o.lon])) : [];
  const moved = port?.latitude != null && lat != null && lon != null ? haversineKm([Number(port.latitude), Number(port.longitude)], [lat, lon]) : 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const payload = {
      name: f.name.trim(), code: toStr(f.code), region_id: f.region_id, district_id: f.district_id,
      latitude: toNum(f.latitude), longitude: toNum(f.longitude), active: f.active, notes: toStr(f.notes),
    };
    try {
      if (port) unwrap(await supabase.from('drone_ports').update(payload).eq('id', port.id));
      else unwrap(await supabase.from('drone_ports').insert(payload));
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.includes('duplicate') ? 'Ce nom ou ce code existe déjà.' : msg);
      setBusy(false);
    }
  }

  return (
    <Modal title={port ? `Modifier ${port.name}` : 'Nouveau drone port'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Annuler</button><button className="btn btn-primary" form="port-form" disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button></>}>
      <div className="bm port-modal">
        <form id="port-form" className="bm-form" onSubmit={submit}>
          <FormSection n={1} icon="pin" title="Identité">
            <div className="form-grid">
              <Field label="Nom" required><input required value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="ex. Port Nord" /></Field>
              <Field label="Code"><input className="fk-code-input" value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase())} placeholder="ex. PN" /></Field>
            </div>
          </FormSection>
          <FormSection n={2} icon="search" title="Localisation" hint="cliquez sur la carte ou faites glisser le repère">
            <div className="form-grid">
              <GeoFields regions={geo.regions} districtsOf={geo.districtsOf} regionId={f.region_id} districtId={f.district_id}
                onChange={(r, d) => setF((cur) => ({ ...cur, region_id: r, district_id: d }))} />
              <Field label="Latitude"><input className="mono" type="number" step="0.000001" min="-90" max="90" value={f.latitude} onChange={(e) => set('latitude', e.target.value)} /></Field>
              <Field label="Longitude"><input className="mono" type="number" step="0.000001" min="-180" max="180" value={f.longitude} onChange={(e) => set('longitude', e.target.value)} /></Field>
            </div>
            <div className="hf-map">
              <LocationPicker kind="port" lat={lat} lon={lon} others={others} height={260}
                onChange={(la, lo) => setF((cur) => ({ ...cur, latitude: String(la), longitude: String(lo) }))} />
            </div>
            {others.length > 0 && <span className="field-hint">Les points bleus sont les CSB desservis par ce drone port (survolez-les pour la distance à vol d'oiseau).</span>}
          </FormSection>
          <FormSection n={3} icon="shield" title="Statut & notes">
            <ChoiceCards label="Statut" value={f.active ? 'on' : 'off'} onChange={(v) => set('active', v === 'on')} options={[
              { value: 'on', label: 'Base active', desc: 'drones, pilotes et vols peuvent y être rattachés', icon: 'flight', tone: 'ok' },
              { value: 'off', label: 'Inactive', desc: 'historique conservé, plus proposée', icon: 'box', tone: 'neutral' },
            ]} />
            <QuickChips items={['Hangar sécurisé', 'Groupe électrogène', 'Panneaux solaires', 'Réseau mobile faible', 'Contact chef de site : ']} value={f.notes} onChange={(v) => set('notes', v)} />
            <textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} aria-label="Notes" placeholder="Infrastructure, énergie, accès, contacts…" />
          </FormSection>
          <ErrorBox error={error} />
        </form>

        <aside className="bm-aside">
          <span className="pd-kicker">Couverture</span>
          <div className="fk-aside-ring">
            <PortRadar center={lat != null && lon != null ? { lat, lon } : null} size={220}
              blips={located.map((o) => ({ name: o.name, lat: o.lat, lon: o.lon, deliveries: 1 }))} />
          </div>
          <div className="fk-kv"><span>CSB desservis</span><b>{others.length}</b></div>
          <div className="fk-kv"><span>Plus proche</span><b>{dists.length ? kmTxt(Math.min(...dists)) : '—'}</b></div>
          <div className="fk-kv"><span>Plus éloigné</span><b>{dists.length ? kmTxt(Math.max(...dists)) : '—'}</b></div>
          {others.length > located.length && <span className="small text-warn">{others.length - located.length} CSB sans position GPS.</span>}
          {moved > 0.05 && <div className="fk-note warn"><Icon name="alert" size={14} /> Base déplacée de {kmTxt(moved)} : vérifiez les distances de vol des CSB.</div>}
        </aside>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Page : les tours de contrôle
// ---------------------------------------------------------------------
export default function DronePorts() {
  const { reloadContext, geo } = useApp();
  const [modal, setModal] = useState<{ port: DronePort | null } | null>(null);
  const todayIso = iso(new Date());

  const { data, error, loading, reload } = useData(async () => {
    const [ports, drones, pilots, packs, batteries, facilities, flights, reports] = await Promise.all([
      supabase.from('drone_ports').select('*').order('name'),
      supabase.from('v_drone_status').select('id, code, status, drone_port_id, hours_to_next_visit'),
      supabase.from('pilots').select('id, full_name, drone_port_id, active'),
      supabase.from('v_pack_status').select('id, pack_number, status, drone_port_id'),
      supabase.from('batteries').select('drone_port_id').neq('status', 'hors_service'),
      supabase.from('health_facilities').select('id, name, latitude, longitude, drone_port_id, active'),
      supabase.from('v_flights').select('drone_port_id, destination_id, flight_type, qrf, payload_kg, flight_date, duration_min').gte('flight_date', addDays(todayIso, -29)).limit(10000),
      supabase.from('v_reports').select('drone_port_id').neq('status', 'clos'),
    ]);
    return {
      ports: unwrap(ports) as DronePort[],
      drones: unwrap(drones) as { id: string; code: string; status: string; drone_port_id: string | null; hours_to_next_visit: number }[],
      pilots: unwrap(pilots) as { id: string; full_name: string; drone_port_id: string | null; active: boolean }[],
      packs: unwrap(packs) as { id: string; pack_number: number; status: string; drone_port_id: string | null }[],
      batteries: unwrap(batteries) as { drone_port_id: string | null }[],
      facilities: unwrap(facilities) as Fac[],
      flights: unwrap(flights) as { drone_port_id: string | null; destination_id: string | null; flight_type: string; qrf: boolean; payload_kg: number | null; flight_date: string; duration_min: number | null }[],
      reports: unwrap(reports) as { drone_port_id: string | null }[],
    };
  });
  const weather = useWeather(data?.ports.filter((p) => p.active) ?? []);

  // livraisons réussies par CSB et par drone port (30 jours)
  const deliveries = useMemo(() => {
    const m = new Map<string, { n: number; last: string }>();
    for (const f of data?.flights ?? []) {
      if (f.flight_type !== 'livraison' || f.qrf || !f.destination_id || !f.drone_port_id) continue;
      const k = `${f.drone_port_id}|${f.destination_id}`;
      const x = m.get(k) ?? { n: 0, last: f.flight_date };
      x.n++; if (f.flight_date > x.last) x.last = f.flight_date;
      m.set(k, x);
    }
    return m;
  }, [data]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const activePorts = data.ports.filter((p) => p.active);
  const un = {
    drones: data.drones.filter((d) => !d.drone_port_id).length,
    pilots: data.pilots.filter((p) => p.active && !p.drone_port_id).length,
    batteries: data.batteries.filter((b) => !b.drone_port_id).length,
  };
  const activeFac = data.facilities.filter((h) => h.active);
  const flights30 = data.flights.length;

  return (
    <div className="ports-page">
      <PageHeader title="Drone ports" subtitle="Les bases d'exploitation : couverture, flotte, équipage, énergie et météo en un coup d'œil"
        actions={<button className="btn btn-primary" onClick={() => setModal({ port: null })}>+ Nouveau drone port</button>} />

      <div className="flight-kpis pl-kpis">
        <div className="fk"><span className="fk-icon"><Icon name="pin" size={18} /></span><div><strong>{activePorts.length}</strong><span>base(s) active(s){data.ports.length > activePorts.length ? ` · ${data.ports.length - activePorts.length} inactive(s)` : ''}</span></div></div>
        <div className="fk"><span className="fk-icon"><Icon name="drone" size={18} /></span><div><strong>{data.drones.filter((d) => d.status !== 'retire').length}</strong><span>drone(s) en flotte</span></div></div>
        <div className="fk"><span className="fk-icon"><Icon name="users" size={18} /></span><div><strong>{data.pilots.filter((p) => p.active).length}</strong><span>pilote(s) actif(s)</span></div></div>
        <div className="fk"><span className="fk-icon"><Icon name="health" size={18} /></span><div><strong>{activeFac.length}</strong><span>CSB couverts dont {activeFac.filter((h) => !h.drone_port_id).length} commun(s)</span></div></div>
        <div className="fk"><span className="fk-icon"><Icon name="flight" size={18} /></span><div><strong>{flights30}</strong><span>vol(s) sur 30 jours</span></div></div>
      </div>

      {(un.drones > 0 || un.pilots > 0 || un.batteries > 0) && (
        <div className="fk-note warn"><Icon name="alert" size={14} /> Non affectés : {un.drones} drone(s), {un.pilots} pilote(s), {un.batteries} batterie(s). Les pilotes non affectés ne voient aucune donnée.</div>
      )}

      {data.ports.length === 0 ? <Empty>Aucun drone port. Créez le premier pour pouvoir y affecter drones et pilotes.</Empty> : (
        <div className="towers">
          {data.ports.map((p) => {
            const center = p.latitude != null && p.longitude != null ? { lat: Number(p.latitude), lon: Number(p.longitude) } : null;
            const drones = data.drones.filter((d) => d.drone_port_id === p.id && d.status !== 'retire');
            const crew = data.pilots.filter((x) => x.drone_port_id === p.id && x.active);
            const packs = data.packs.filter((x) => x.drone_port_id === p.id && x.status !== 'hors_service');
            const packsOk = packs.filter((x) => x.status === 'en_service').length;
            const fl = data.flights.filter((f) => f.drone_port_id === p.id);
            const deliv = fl.filter((f) => f.flight_type === 'livraison' && !f.qrf);
            const qrf = fl.filter((f) => f.qrf).length;
            const kg = deliv.reduce((s, f) => s + Number(f.payload_kg ?? 0), 0);
            const hrs = fl.reduce((s, f) => s + Number(f.duration_min ?? 0), 0) / 60;
            const openReports = data.reports.filter((r) => r.drone_port_id === p.id).length;
            // CSB communs : retenus seulement s'ils sont livrés par cette base (30 j) ou à moins de 60 km
            const facs = activeFac.filter((h) => h.drone_port_id === p.id || (!h.drone_port_id && (deliveries.has(`${p.id}|${h.id}`)
              || (center != null && h.latitude != null && h.longitude != null && haversineKm([center.lat, center.lon], [Number(h.latitude), Number(h.longitude)]) <= 60))));
            const blips: RadarBlip[] = facs.filter((h) => h.latitude != null && h.longitude != null).map((h) => {
              const dv = deliveries.get(`${p.id}|${h.id}`);
              return { name: h.name, lat: Number(h.latitude), lon: Number(h.longitude), deliveries: dv?.n ?? 0, since: dv ? daysBetween(dv.last, todayIso) : null, common: !h.drone_port_id };
            });
            const dists = center ? blips.map((b) => haversineKm([center.lat, center.lon], [b.lat, b.lon])) : [];
            const servedCsb = blips.filter((b) => b.deliveries).length;
            const w = weather[p.id]?.w;
            const v = w ? flightVerdict({ wind: w.current.wind, gust: w.current.gust, code: w.current.code }) : null;
            return (
              <article key={p.id} className={`tower${p.active ? '' : ' is-off'}`}>
                <header className="tower-head">
                  <div className="tower-title">
                    <span className="pd-kicker">Drone port{p.code ? ` · ${p.code}` : ''}</span>
                    <h2>{p.name}</h2>
                    <span className="small muted">{[geo.regionName(p.region_id), geo.districtName(p.district_id)].filter(Boolean).join(' · ') || <span className="text-warn">région à renseigner</span>}</span>
                  </div>
                  <div className="tower-badges">
                    {!p.active && <Badge level="neutral">Inactive</Badge>}
                    {v && w && <span className={`tower-wx verdict-${v.level}`} title={v.why.join(', ') || 'conditions favorables'}>
                      <Icon name="wind" size={14} /> {w.current.wind.toFixed(1).replace('.', ',')} m/s · {v.label}</span>}
                    <button className="btn btn-sm" onClick={() => setModal({ port: p })}>Modifier</button>
                  </div>
                </header>

                <div className="tower-body">
                  <div className="tower-radar">
                    <PortRadar center={center} blips={blips} size={250} />
                    <div className="tower-cover">
                      <div><b>{facs.length}</b><span>CSB couverts</span></div>
                      <div><b>{servedCsb}</b><span>livrés · 30 j</span></div>
                      <div><b>{dists.length ? kmTxt(Math.max(...dists)) : '—'}</b><span>rayon d'action</span></div>
                    </div>
                  </div>

                  <div className="tower-panels">
                    <section className="tp">
                      <div className="tp-head"><Icon name="drone" size={14} /> Flotte <Link to="/drones" className="tp-link">{drones.length} →</Link></div>
                      {drones.length === 0 ? <span className="small muted">Aucun drone affecté</span> : (
                        <div className="tp-drones">
                          {drones.map((d) => (
                            <Link key={d.id} to={`/drones/${d.id}`} className={`tp-drone st-${d.status}`} title={`${LABELS.droneStatus[d.status as keyof typeof LABELS.droneStatus] ?? d.status} · visite dans ${Math.round(d.hours_to_next_visit)} h`}>
                              <i /> {d.code}
                            </Link>
                          ))}
                        </div>
                      )}
                    </section>
                    <section className="tp">
                      <div className="tp-head"><Icon name="users" size={14} /> Équipage <Link to="/pilotes" className="tp-link">{crew.length} →</Link></div>
                      {crew.length === 0 ? <span className="small muted">Aucun pilote actif</span> : (
                        <div className="tp-crew">
                          {crew.slice(0, 7).map((c) => <Link key={c.id} to={`/carnet/${c.id}`} className="tp-avatar" style={{ ['--h' as string]: hue(c.full_name) }} title={c.full_name}>{initials(c.full_name)}</Link>)}
                          {crew.length > 7 && <span className="tp-avatar more">+{crew.length - 7}</span>}
                        </div>
                      )}
                    </section>
                    <section className="tp">
                      <div className="tp-head"><Icon name="battery" size={14} /> Énergie <Link to="/batteries" className="tp-link">→</Link></div>
                      <div className="tp-packs">
                        {packs.length === 0 ? <span className="small muted">Aucun pack</span> : packs.map((x) => (
                          <span key={x.id} className={`tp-pack st-${x.status}`} title={`Pack ${x.pack_number} · ${LABELS.batteryStatus[x.status as keyof typeof LABELS.batteryStatus] ?? x.status}`}>{x.pack_number}</span>
                        ))}
                        {packs.length > 0 && <span className="small muted">{packsOk}/{packs.length} en service</span>}
                      </div>
                    </section>
                    <section className="tp tp-activity">
                      <div className="tp-head"><Icon name="stats" size={14} /> Activité · 30 jours</div>
                      <div className="tp-figs">
                        <div><b>{fl.length}</b><span>vols</span></div>
                        <div><b>{deliv.length}</b><span>livraisons</span></div>
                        <div><b>{kg.toLocaleString('fr-FR', { maximumFractionDigits: 1 })}</b><span>kg livrés</span></div>
                        <div><b>{hrs.toLocaleString('fr-FR', { maximumFractionDigits: 1 })}</b><span>heures</span></div>
                      </div>
                      <div className="tp-flags">
                        <span className={qrf ? 'text-warn' : 'muted'}>{fl.length ? `QRF ${Math.round((100 * qrf) / fl.length)} %` : 'QRF —'}</span>
                        <Link to="/rapports" className={openReports ? 'text-warn' : 'muted'}>{openReports} rapport(s) ouvert(s)</Link>
                      </div>
                    </section>
                  </div>
                </div>

                <footer className="tower-foot small muted">
                  {center ? <a href={`https://www.openstreetmap.org/?mlat=${center.lat}&mlon=${center.lon}#map=13/${center.lat}/${center.lon}`} target="_blank" rel="noreferrer" className="mono">{center.lat.toFixed(4)}, {center.lon.toFixed(4)} ↗</a> : <span className="text-warn">Position GPS à renseigner (radar et météo indisponibles)</span>}
                  {p.notes && <span className="tower-notes">{p.notes}</span>}
                </footer>
              </article>
            );
          })}
        </div>
      )}
      <p className="muted small">L'affectation des drones, pilotes et batteries se fait depuis leurs fiches. Le radar place chaque CSB selon son cap et sa distance réels depuis la base ; l'écho pulse si une livraison a eu lieu dans les 7 derniers jours.</p>
      {modal && <PortModal port={modal.port} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); reloadContext(); }} />}
    </div>
  );
}
