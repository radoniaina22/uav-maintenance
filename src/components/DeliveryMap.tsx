import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { DronePort } from '../lib/types';
import { date } from '../lib/format';

export interface MapFacility {
  id: string; name: string; latitude: number | null; longitude: number | null; distance_km: number | null;
  deliveries: number; kg: number; last: string | null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Carte des livraisons (30 derniers jours) : drone ports et CSB, cercles proportionnels aux livraisons. */
export default function DeliveryMap({ ports, facilities, height = 340, fill = false }: { ports: DronePort[]; facilities: MapFacility[]; height?: number; fill?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  /** recadrage sur les points affichés (rappelé quand la taille change) */
  const fit = useRef<() => void>(() => {});

  useEffect(() => {
    if (!box.current || map.current) return;
    map.current = L.map(box.current, { zoomControl: true, attributionControl: true, scrollWheelZoom: false }).setView([-18.9, 47.5], 6);
    // fond OpenStreetMap, assombri en CSS (.delivery-map .leaflet-tile-pane) pour le thème sombre
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    // la carte suit la taille de son conteneur (hauteur calée sur la colonne voisine) et se recadre
    let t = 0;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = window.setTimeout(() => { if (!map.current) return; map.current.invalidateSize(); fit.current(); }, 120);
    });
    ro.observe(box.current);
    // démontage : annuler le recadrage en attente et les animations avant de détruire la carte
    return () => { clearTimeout(t); ro.disconnect(); fit.current = () => {}; map.current?.stop(); map.current?.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current, g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const pts: L.LatLngExpression[] = [];
    const maxDel = Math.max(1, ...facilities.map((f) => f.deliveries));
    for (const f of facilities) {
      if (f.latitude == null || f.longitude == null) continue;
      const ll: L.LatLngExpression = [Number(f.latitude), Number(f.longitude)];
      pts.push(ll);
      const served = f.deliveries > 0;
      // points lumineux façon radar : taille selon les livraisons, onde si livré dans les 7 derniers jours
      const size = served ? Math.round(5 + 5 * Math.sqrt(f.deliveries / maxDel)) : 6;
      const recent = f.last != null && (Date.now() - new Date(`${f.last}T12:00:00`).getTime()) / 86400000 <= 7;
      L.marker(ll, {
        icon: L.divIcon({
          className: 'map-dot-wrap',
          html: `<span class="map-dot${served ? '' : ' idle'}${recent ? ' hot' : ''}" style="width:${size}px;height:${size}px"></span>`,
          iconSize: [size, size], iconAnchor: [size / 2, size / 2],
        }),
        title: f.name,
      }).bindPopup(`<strong>${esc(f.name)}</strong><br>${served
        ? `${f.deliveries} livraison(s) · ${f.kg.toFixed(1).replace('.', ',')} kg<br>Dernière : ${date(f.last)}`
        : 'Aucune livraison depuis 30 jours'}${f.distance_km != null ? `<br>${String(f.distance_km).replace('.', ',')} km du drone port` : ''}`).addTo(g);
    }
    for (const p of ports) {
      if (p.latitude == null || p.longitude == null) continue;
      const ll: L.LatLngExpression = [Number(p.latitude), Number(p.longitude)];
      pts.push(ll);
      L.marker(ll, {
        icon: L.divIcon({ className: 'map-dot-wrap', html: '<span class="map-base"></span>', iconSize: [12, 12], iconAnchor: [6, 6] }),
        title: p.name,
      }).bindPopup(`<strong>${esc(p.name)}</strong><br>Drone port`).addTo(g);
    }
    fit.current = () => {
      if (map.current !== m) return; // carte détruite entre-temps
      if (pts.length === 1) m.setView(pts[0], 10, { animate: false });
      else if (pts.length > 1) m.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 11, animate: false });
    };
    fit.current();
  }, [ports, facilities]);

  const located = facilities.filter((f) => f.latitude != null).length + ports.filter((p) => p.latitude != null).length;
  return (
    <div className={`map-wrap${fill ? ' is-fill' : ''}`}>
      <div ref={box} className="delivery-map" style={fill ? undefined : { height }} role="img" aria-label="Carte des drone ports et des CSB desservis sur 30 jours" />
      {located === 0 && <div className="map-empty">Aucune coordonnée GPS : renseignez la latitude et la longitude des drone ports et des CSB.</div>}
    </div>
  );
}
