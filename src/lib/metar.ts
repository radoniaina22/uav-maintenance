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
  nowMm?: number;    // pluie de l'heure en cours (mm)
  prevMm?: number;   // pluie de l'heure précédente (mm), pour le temps récent (RE..)
  prevCode?: number; // code météo WMO de l'heure précédente
  next?: AvHour[];   // prochaines heures, pour la tendance (PROB30 / PROB40 / TEMPO / NOSIG)
}
/** Créneau horaire prévu : [start, end[ en heure locale ISO */
export interface AvHour { start: string; end: string; prob: number; mm: number; code: number }

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
/** Précipitation codée selon l'intensité (mm/h, seuils OMM : faible < 2,5, modérée < 10, forte au-delà) */
export function precipGroup(mm: number, shower = false) {
  const base = shower ? 'SHRA' : 'RA';
  return mm >= 10 ? `+${base}` : mm >= 2.5 ? base : `-${base}`;
}
const isPrecip = (wx: string) => /DZ|RA|SN|TS/.test(wx);
/** Temps présent : code WMO, complété par le cumul horaire quand le modèle annonce de la pluie sans code de pluie */
function presentWx(code: number, vis: number, mm?: number) {
  const wx = wxGroup(code, vis);
  if (isPrecip(wx) || mm == null || mm < 0.1) return wx;
  return precipGroup(mm);
}
/** Phénomène prévu pour un créneau (tendance) */
function forecastWx(h: AvHour) {
  const wx = wxGroup(h.code, 10000);
  return isPrecip(wx) ? wx : precipGroup(h.mm, true);
}
/** Temps récent (RE..) : précipitation de l'heure précédente terminée */
function recentWx(o: AvObs, nowWx: string) {
  if (isPrecip(nowWx) || o.prevCode == null) return '';
  const prev = wxGroup(o.prevCode, 10000);
  if (prev.includes('TS')) return 'RETS';
  if (isPrecip(prev) || (o.prevMm ?? 0) >= 0.1) return prev.includes('SH') ? 'RESHRA' : prev.includes('DZ') ? 'REDZ' : 'RERA';
  return '';
}
const WX_FR: Record<string, string> = {
  FG: 'Brouillard', BR: 'Brume', HZ: 'Brume sèche', '-DZ': 'Bruine faible', DZ: 'Bruine', '+DZ': 'Bruine forte', '-RA': 'Pluie faible', RA: 'Pluie', '+RA': 'Pluie forte',
  '-SHRA': 'Averses faibles', SHRA: 'Averses', '+SHRA': 'Fortes averses', TSRA: 'Orage', '+TSRA': 'Orage fort', FZDZ: 'Bruine verglaçante', FZRA: 'Pluie verglaçante', SN: 'Neige',
  RERA: 'Pluie récente (dernière heure)', RESHRA: 'Averses récentes (dernière heure)', REDZ: 'Bruine récente (dernière heure)', RETS: 'Orage récent (dernière heure)',
};
const mmFr = (mm: number) => (mm >= 0.1 ? ` · ${dec(mm)} mm/h` : '');
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

export type MetarKind = 'head' | 'time' | 'wind' | 'vis' | 'wx' | 'cloud' | 'temp' | 'qnh' | 'trend';

/** Groupe de période TAF JJHH/JJHH (UTC) */
function periodGroup(start: string, end: string, offsetSec: number) {
  const a = utc(start, offsetSec);
  // fin notée sur l'heure qui précède + 1 : 00 UTC devient 24 sur le jour précédent (usage OACI)
  const b = utc(end, offsetSec + 3600);
  const bh = b.h + 1;
  return { t: `${pad(a.d)}${pad(a.h)}/${pad(b.d)}${pad(bh)}`, fr: `du ${a.d} à ${pad(a.h)} h au ${b.d} à ${pad(bh)} h UTC` };
}

/**
 * Tendance des prochaines heures (syntaxe TAF) :
 * < 30 % → NOSIG ; 30–39 % → PROB30 TEMPO ; 40–49 % → PROB40 TEMPO ; ≥ 50 % → TEMPO (OACI : PROB limité à 30 et 40)
 */
function trendTokens(o: AvObs, offsetSec: number): MetarToken[] {
  const hrs = (o.next ?? []).filter((h) => h.prob >= 30);
  if (!o.next?.length) return [];
  if (!hrs.length) return [{ t: 'NOSIG', kind: 'trend', level: 'ok', title: 'Pas de changement significatif prévu (pluie < 30 % sur les prochaines heures)' }];
  const max = Math.max(...hrs.map((h) => h.prob));
  const worst = hrs.reduce((a, b) => (b.prob > a.prob || (b.prob === a.prob && b.mm > a.mm) ? b : a));
  const per = periodGroup(hrs[0].start, hrs[hrs.length - 1].end, offsetSec);
  const wx = forecastWx(worst);
  const out: MetarToken[] = [];
  if (max < 50) out.push({ t: max < 40 ? 'PROB30' : 'PROB40', kind: 'trend', level: 'warn', title: `Probabilité ${max < 40 ? '30' : '40'} % (modèle : ${Math.round(max)} %)` });
  out.push({ t: 'TEMPO', kind: 'trend', level: max >= 50 ? 'warn' : undefined, title: `Variations temporaires${max >= 50 ? ` (probabilité ≥ 50 % : ${Math.round(max)} %)` : ''}` });
  out.push({ t: per.t, kind: 'time', title: `Période ${per.fr}` });
  out.push({ t: wx, kind: 'wx', level: wx.includes('TS') || wx.startsWith('+') ? 'danger' : 'warn', title: `${WX_FR[wx] ?? wx} prévue${mmFr(worst.mm)}` });
  return out;
}
export interface MetarToken { t: string; kind: MetarKind; title: string; level?: 'ok' | 'warn' | 'danger' }

/** METAR découpé en groupes, chacun avec son décodage (pour l'affichage coloré) */
export function metarTokens(station: string, o: AvObs, offsetSec: number): MetarToken[] {
  const u = utc(o.time, offsetSec);
  const kt = Math.round(o.wind * KT);
  const wx = presentWx(o.code, o.vis, o.nowMm);
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
    if (wx) out.push({ t: wx, kind: 'wx', level: wx.includes('TS') || wx === 'FG' || wx.startsWith('+') ? 'danger' : 'warn', title: `${WX_FR[wx] ?? wx}${isPrecip(wx) ? mmFr(o.nowMm ?? 0) : ''}` });
    if (clouds.length) for (const c of clouds) {
      out.push({ t: `${c.cov}${pad(c.ft / 100, 3)}${c.cb ? 'CB' : ''}`, kind: 'cloud', level: (c.cov === 'BKN' || c.cov === 'OVC') && c.ft < 1000 ? 'danger' : (c.cov === 'BKN' || c.cov === 'OVC') && c.ft <= 3000 ? 'warn' : 'ok',
        title: `${COV_FR[c.cov]} à ${c.ft.toLocaleString('fr-FR')} ft${c.cb ? ' (cumulonimbus)' : ''}${c.ft < 10000 ? ' · base estimée' : ''}` });
    }
    else out.push({ t: 'NSC', kind: 'cloud', level: 'ok', title: 'Pas de nuage significatif' });
  }
  out.push({ t: `${tGroup(o.temp)}/${tGroup(o.dew)}`, kind: 'temp', title: `Température ${Math.round(o.temp)} °C, point de rosée ${Math.round(o.dew)} °C` });
  if (o.qnh) out.push({ t: `Q${pad(o.qnh, 4)}`, kind: 'qnh', title: `QNH ${Math.round(o.qnh)} hPa (pression ramenée au niveau de la mer)` });
  // Temps récent (REww) puis tendance, dans l'ordre OACI
  const re = recentWx(o, wx);
  if (re) out.push({ t: re, kind: 'wx', level: re === 'RETS' ? 'danger' : 'warn', title: `${WX_FR[re]}${mmFr(o.prevMm ?? 0)}` });
  out.push(...trendTokens(o, offsetSec));
  return out;
}

export const buildMetar = (station: string, o: AvObs, offsetSec: number) => `${metarTokens(station, o, offsetSec).map((x) => x.t).join(' ')}=`;

/** Lecture en clair, cellule par cellule */
export function decodeCells(o: AvObs) {
  const wx = presentWx(o.code, o.vis, o.nowMm);
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
