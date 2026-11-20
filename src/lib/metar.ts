/**
 * METAR synthétique (format OACI indicatif) généré à partir du modèle Open-Meteo.
 * Ce n'est PAS un message officiel : pas d'observation réelle, bases nuageuses estimées.
 */

export interface AvObs {
  time: string;      // heure locale ISO (AAAA-MM-JJTHH:MM)
  wind: number;      // m/s
  gust: number;      // m/s
  dir: number;       // degrés
  code: number;      // code météo WMO
  vis: number;       // m
  low: number;       // nébulosité basse %
  mid: number;       // nébulosité moyenne %
  high: number;      // nébulosité haute %
  temp: number;      // °C
  dew: number;       // °C
  qnh?: number;      // hPa
}

const KT = 1.943844;
const pad = (n: number, l = 2) => String(Math.round(n)).padStart(l, '0');
const dec = (v: number, d = 1) => v.toFixed(d).replace('.', ',');

/** Heure locale ISO + décalage (s) → { jour, heure, minute } UTC */
function utc(local: string, offsetSec: number) {
  const [d, t] = local.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  const u = new Date(Date.UTC(y, m - 1, day, hh, mm) - offsetSec * 1000);
  return { d: u.getUTCDate(), h: u.getUTCHours(), m: u.getUTCMinutes() };
}

/** Indicatif du drone port : nom sans accents, en majuscules (ce n'est pas un code OACI) */
export function stationId(name: string) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 14) || 'DRONEPORT';
}

const hasGust = (o: Pick<AvObs, 'wind' | 'gust'>) => (o.gust - o.wind) * KT >= 10;

export function windGroup(o: Pick<AvObs, 'wind' | 'gust' | 'dir'>) {
  const ff = o.wind * KT, gg = o.gust * KT;
  if (ff < 1) return '00000KT';
  const ddd = ff <= 3 ? 'VRB' : pad(((Math.round(o.dir / 10) * 10) % 360) || 360, 3);
  return `${ddd}${pad(ff)}${hasGust(o) ? `G${pad(gg)}` : ''}KT`;
}

export function visGroup(vis: number) {
  if (vis >= 10000) return '9999';
  if (vis < 50) return '0000';
  const step = vis < 800 ? 50 : vis < 5000 ? 100 : 1000;
  return pad(Math.floor(vis / step) * step, 4);
}

/** Phénomène significatif (codes WMO) */
export function wxGroup(code: number, vis: number) {
  if (code === 45 || code === 48) return vis < 1000 ? 'FG' : 'BR';
  if (code === 51) return '-DZ'; if (code === 53) return 'DZ'; if (code === 55) return '+DZ';
  if (code === 56 || code === 57) return 'FZDZ';
  if (code === 61) return '-RA'; if (code === 63) return 'RA'; if (code === 65) return '+RA';
  if (code === 66 || code === 67) return 'FZRA';
  if (code >= 71 && code <= 77) return 'SN';
  if (code === 80) return '-SHRA'; if (code === 81) return 'SHRA'; if (code === 82) return '+SHRA';
  if (code === 95) return 'TSRA'; if (code >= 96) return '+TSRA';
  if (vis < 5000) return 'HZ';
  return '';
}
const WX_FR: Record<string, string> = {
  FG: 'Brouillard', BR: 'Brume', HZ: 'Brume sèche', '-DZ': 'Bruine faible', DZ: 'Bruine', '+DZ': 'Bruine forte', '-RA': 'Pluie faible', RA: 'Pluie', '+RA': 'Pluie forte',
  '-SHRA': 'Averses faibles', SHRA: 'Averses', '+SHRA': 'Fortes averses', TSRA: 'Orage', '+TSRA': 'Orage fort', FZDZ: 'Bruine verglaçante', FZRA: 'Pluie verglaçante', SN: 'Neige',
};
const COV_FR: Record<string, string> = { FEW: 'Peu', SCT: 'Épars', BKN: 'Fragmenté', OVC: 'Couvert' };

const cover = (pct: number) => (pct <= 5 ? null : pct <= 25 ? 'FEW' : pct <= 50 ? 'SCT' : pct <= 87 ? 'BKN' : 'OVC');

/** Base des nuages bas estimée par l'écart température / point de rosée (≈ 400 ft par °C) */
export const lowBaseFt = (temp: number, dew: number) => Math.min(6500, Math.max(100, Math.round(((temp - dew) * 400) / 100) * 100));

export function cloudGroups(o: AvObs) {
  const out: { cov: string; ft: number; cb: boolean }[] = [];
  const lc = cover(o.low), mc = cover(o.mid), hc = cover(o.high);
  if (lc) out.push({ cov: lc, ft: lowBaseFt(o.temp, o.dew), cb: o.code >= 95 });
  if (mc) out.push({ cov: mc, ft: 10000, cb: false });
  if (hc) out.push({ cov: hc, ft: 25000, cb: false });
  return out;
}

/** Plafond (première couche BKN/OVC), en ft */
export function ceilingFt(o: AvObs) {
  const c = cloudGroups(o).find((g) => g.cov === 'BKN' || g.cov === 'OVC');
  return c ? c.ft : null;
}

export type FlightCat = 'VFR' | 'MVFR' | 'IFR' | 'LIFR';
/** Catégorie de vol VFR / MVFR / IFR / LIFR (visibilité et plafond) */
export function flightCategory(o: AvObs): FlightCat {
  const ceil = ceilingFt(o) ?? 99999, v = o.vis;
  if (ceil < 500 || v < 1600) return 'LIFR';
  if (ceil < 1000 || v < 5000) return 'IFR';
  if (ceil <= 3000 || v <= 8000) return 'MVFR';
  return 'VFR';
}
export const CAT_FR: Record<FlightCat, string> = {
  VFR: 'vue : bonnes conditions', MVFR: 'vue : conditions marginales', IFR: 'instruments : conditions dégradées', LIFR: 'instruments : conditions très dégradées',
};

const tGroup = (t: number) => (Math.round(t) < 0 ? `M${pad(-t)}` : pad(t));

export type MetarKind = 'head' | 'time' | 'wind' | 'vis' | 'wx' | 'cloud' | 'temp' | 'qnh';
export interface MetarToken { t: string; kind: MetarKind; title: string; level?: 'ok' | 'warn' | 'danger' }

/** METAR découpé en groupes, chacun avec son décodage (pour l'affichage coloré) */
export function metarTokens(station: string, o: AvObs, offsetSec: number): MetarToken[] {
  const u = utc(o.time, offsetSec);
  const kt = Math.round(o.wind * KT);
  const wx = wxGroup(o.code, o.vis);
  const clouds = cloudGroups(o);
  const cavok = o.vis >= 10000 && !wx && !clouds.some((c) => c.ft < 5000 || c.cb);
  const out: MetarToken[] = [
    { t: 'METAR', kind: 'head', title: 'Message d\'observation météo (synthétique)' },
    { t: station, kind: 'head', title: 'Drone port (indicatif interne, pas un code OACI)' },
    { t: `${pad(u.d)}${pad(u.h)}${pad(Math.floor(u.m / 30) * 30)}Z`, kind: 'time', title: `Le ${u.d} à ${pad(u.h)}:${pad(Math.floor(u.m / 30) * 30)} UTC (heure locale − 3 h)` },
    { t: 'AUTO', kind: 'head', title: 'Généré automatiquement (modèle Open-Meteo, sans observateur)' },
    { t: windGroup(o), kind: 'wind', level: o.gust >= 15 || o.wind >= 12 ? 'danger' : o.wind >= 8 ? 'warn' : 'ok',
      title: kt < 1 ? 'Vent calme' : `Vent ${kt <= 3 ? 'variable' : `du ${Math.round(o.dir / 10) * 10}°`} ${kt} kt (${dec(o.wind)} m/s)${hasGust(o) ? `, rafales ${Math.round(o.gust * KT)} kt (${dec(o.gust)} m/s)` : ''}` },
  ];
  if (cavok) out.push({ t: 'CAVOK', kind: 'vis', level: 'ok', title: 'Visibilité ≥ 10 km, pas de nuage sous 5 000 ft, pas de phénomène significatif' });
  else {
    out.push({ t: visGroup(o.vis), kind: 'vis', level: o.vis < 1500 ? 'danger' : o.vis < 5000 ? 'warn' : 'ok', title: o.vis >= 10000 ? 'Visibilité 10 km ou plus' : `Visibilité ${Math.round(o.vis)} m` });
    if (wx) out.push({ t: wx, kind: 'wx', level: wx.includes('TS') || wx === 'FG' || wx.startsWith('+') ? 'danger' : 'warn', title: WX_FR[wx] ?? wx });
    if (clouds.length) for (const c of clouds) {
      out.push({ t: `${c.cov}${pad(c.ft / 100, 3)}${c.cb ? 'CB' : ''}`, kind: 'cloud', level: (c.cov === 'BKN' || c.cov === 'OVC') && c.ft < 1000 ? 'danger' : (c.cov === 'BKN' || c.cov === 'OVC') && c.ft <= 3000 ? 'warn' : 'ok',
        title: `${COV_FR[c.cov]} à ${c.ft.toLocaleString('fr-FR')} ft${c.cb ? ' (cumulonimbus)' : ''}${c.ft < 10000 ? ' · base estimée' : ''}` });
    }
    else out.push({ t: 'NSC', kind: 'cloud', level: 'ok', title: 'Pas de nuage significatif' });
  }
  out.push({ t: `${tGroup(o.temp)}/${tGroup(o.dew)}`, kind: 'temp', title: `Température ${Math.round(o.temp)} °C, point de rosée ${Math.round(o.dew)} °C` });
  if (o.qnh) out.push({ t: `Q${pad(o.qnh, 4)}`, kind: 'qnh', title: `QNH ${Math.round(o.qnh)} hPa (pression ramenée au niveau de la mer)` });
  return out;
}

export const buildMetar = (station: string, o: AvObs, offsetSec: number) => `${metarTokens(station, o, offsetSec).map((x) => x.t).join(' ')}=`;

/** Lecture en clair, cellule par cellule */
export function decodeCells(o: AvObs) {
  const wx = wxGroup(o.code, o.vis);
  const clouds = cloudGroups(o);
  const ceil = ceilingFt(o);
  const kt = Math.round(o.wind * KT);
  return [
    { label: 'Vent', value: kt < 1 ? 'Calme' : `${kt <= 3 ? 'VRB' : `${Math.round(o.dir / 10) * 10}°`} · ${kt} kt`, sub: `${dec(o.wind)} m/s${hasGust(o) ? ` · raf. ${dec(o.gust)} m/s` : ''}` },
    { label: 'Visibilité', value: o.vis >= 10000 ? '≥ 10 km' : o.vis >= 1000 ? `${dec(o.vis / 1000)} km` : `${Math.round(o.vis)} m`, sub: wx ? WX_FR[wx] ?? wx : 'aucun phénomène' },
    { label: 'Plafond', value: ceil != null ? `${ceil.toLocaleString('fr-FR')} ft` : 'aucun', sub: clouds.length ? clouds.map((c) => `${c.cov}${pad(c.ft / 100, 3)}`).join(' ') : 'ciel dégagé' },
    { label: 'Temp. / rosée', value: `${Math.round(o.temp)} / ${Math.round(o.dew)} °C`, sub: o.temp - o.dew <= 2 ? 'écart faible : brouillard possible' : `écart ${Math.round(o.temp - o.dew)} °C` },
    { label: 'QNH', value: o.qnh ? `${Math.round(o.qnh)} hPa` : '—', sub: 'niveau de la mer' },
  ];
}
