import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/** Distance à vol d'oiseau (km) entre deux points GPS */
export function haversineKm(a: [number, number], b: [number, number]) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const valid = (lat: number | null, lon: number | null): lat is number =>
  lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/**
 * Carte de position GPS : affiche le point, permet de le placer d'un clic ou en faisant glisser le repère.
 * `reference` = drone port (repère et trait de distance).
 */
export default function LocationPicker({ lat, lon, onChange, reference, others = [], kind = 'csb', height = 240, readOnly = false }: {
  lat: number | null; lon: number | null; onChange?: (lat: number, lon: number) => void;
  reference?: { name: string; lat: number | null; lon: number | null } | null;
  /** autres points affichés en lecture seule (ex. CSB desservis par le drone port) */
  others?: { name: string; lat: number | null; lon: number | null }[];
  /** objet positionné : CSB (✚ bleu) ou drone port (⌂ orange) */
  kind?: 'csb' | 'port'; height?: number; readOnly?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);
  const refLayer = useRef<L.LayerGroup | null>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  // création de la carte
  useEffect(() => {
    if (!box.current || map.current) return;
    const m = L.map(box.current, { scrollWheelZoom: true, attributionControl: true }).setView([-18.9, 47.0], 5);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(m);
    refLayer.current = L.layerGroup().addTo(m);
    if (!readOnly) m.on('click', (e: L.LeafletMouseEvent) => cb.current?.(+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)));
    map.current = m;
    // la carte est créée dans une fenêtre animée : recalcul de la taille une fois affichée
    const t = setTimeout(() => m.invalidateSize(), 250);
    return () => { clearTimeout(t); m.stop(); m.remove(); map.current = null; marker.current = null; };
  }, [readOnly]);

  // repère du CSB + drone port de référence
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const hasPoint = valid(lat, lon);
    if (hasPoint) {
      const ll: L.LatLngExpression = [lat!, lon!];
      if (!marker.current) {
        marker.current = L.marker(ll, {
          draggable: !readOnly, title: kind === 'port' ? 'Position du drone port' : 'Position du CSB',
          icon: kind === 'port'
            ? L.divIcon({ className: 'map-port map-port-edit', html: '<span>⌂</span>', iconSize: [32, 32], iconAnchor: [16, 16] })
            : L.divIcon({ className: 'map-csb', html: '<span>✚</span>', iconSize: [30, 30], iconAnchor: [15, 15] }),
        }).addTo(m);
        marker.current.on('dragend', () => { const p = marker.current!.getLatLng(); cb.current?.(+p.lat.toFixed(6), +p.lng.toFixed(6)); });
      } else marker.current.setLatLng(ll);
    } else if (marker.current) { marker.current.remove(); marker.current = null; }

    const g = refLayer.current!;
    g.clearLayers();
    const refOk = reference && valid(reference.lat, reference.lon);
    if (refOk) {
      const r: L.LatLngExpression = [reference!.lat!, reference!.lon!];
      L.marker(r, { title: reference!.name, icon: L.divIcon({ className: 'map-port', html: '<span>⌂</span>', iconSize: [28, 28], iconAnchor: [14, 14] }) })
        .bindTooltip(reference!.name).addTo(g);
      if (hasPoint) L.polyline([r, [lat!, lon!]], { color: '#f5b83d', weight: 2, dashArray: '6 6', opacity: 0.9 }).addTo(g);
    }
    const pts: [number, number][] = [];
    for (const o of others) {
      if (!valid(o.lat, o.lon)) continue;
      pts.push([o.lat!, o.lon!]);
      const d = hasPoint ? ` · ${haversineKm([lat!, lon!], [o.lat!, o.lon!]).toFixed(1).replace('.', ',')} km` : '';
      L.circleMarker([o.lat!, o.lon!], { radius: 6, color: '#3987e5', weight: 1.5, fillColor: '#3987e5', fillOpacity: 0.5 })
        .bindTooltip(`${o.name}${d}`).addTo(g);
      if (hasPoint) L.polyline([[lat!, lon!], [o.lat!, o.lon!]], { color: '#3987e5', weight: 1, opacity: 0.45, dashArray: '3 5' }).addTo(g);
    }
    if (pts.length && hasPoint) m.fitBounds(L.latLngBounds([...pts, [lat!, lon!]]), { padding: [36, 36], maxZoom: 13 });
    else if (hasPoint && refOk) m.fitBounds(L.latLngBounds([[lat!, lon!], [reference!.lat!, reference!.lon!]]), { padding: [36, 36], maxZoom: 14 });
    else if (hasPoint) m.setView([lat!, lon!], Math.max(m.getZoom(), 13));
    else if (refOk) m.setView([reference!.lat!, reference!.lon!], 10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lon, reference?.lat, reference?.lon, reference?.name, readOnly, kind, others.map((o) => `${o.name}:${o.lat},${o.lon}`).join('|')]);

  function locate() {
    if (!navigator.geolocation) { setGeoError('Géolocalisation non disponible sur cet appareil.'); return; }
    setLocating(true); setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (p) => { setLocating(false); cb.current?.(+p.coords.latitude.toFixed(6), +p.coords.longitude.toFixed(6)); },
      () => { setLocating(false); setGeoError('Position refusée ou indisponible.'); },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }

  const dist = valid(lat, lon) && reference && valid(reference.lat, reference.lon) ? haversineKm([lat!, lon!], [reference.lat!, reference.lon!]) : null;

  return (
    <div className="loc-picker">
      <div className="map-wrap">
        <div ref={box} className="delivery-map" style={{ height }} role="application" aria-label={`Carte : position GPS du ${kind === 'port' ? 'drone port' : 'CSB'}`} />
        {!valid(lat, lon) && (
          <div className="loc-hint">{readOnly ? 'Position GPS non renseignée' : `Cliquez sur la carte pour placer le ${kind === 'port' ? 'drone port' : 'CSB'}, ou saisissez la latitude et la longitude`}</div>
        )}
      </div>
      <div className="loc-bar small">
        <span className="muted">
          {valid(lat, lon) ? <>📍 {lat!.toFixed(5)}, {lon!.toFixed(5)}</> : 'Aucune position'}
          {dist != null && <> · <strong className="text">{dist.toFixed(1).replace('.', ',')} km</strong> à vol d'oiseau de {reference!.name}</>}
          {others.length > 0 && <> · {others.filter((o) => valid(o.lat, o.lon)).length} / {others.length} CSB localisé(s)</>}
        </span>
        {!readOnly && <button type="button" className="btn btn-sm" onClick={locate} disabled={locating}>{locating ? 'Localisation…' : '◎ Ma position'}</button>}
      </div>
      {geoError && <div className="small text-warn">{geoError}</div>}
      {!readOnly && <div className="small muted">Astuce : faites glisser le repère pour ajuster la position.</div>}
    </div>
  );
}
