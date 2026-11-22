// Mise en forme des e-mails d'alerte (HTML compatible messageries : tableaux, attributs bgcolor, styles en ligne).
// Module sans dépendance (fonction send-alerts, Deno ; prévisualisable sous Node).
// Le contenu (titres, détails, niveaux) vient tel quel des fonctions SQL alerts_* : aucun calcul métier ici.
//
// Structure : texte d'aperçu caché · liseré UNFPA · en-tête (logo, date) · bandeau titre + compteurs ·
// bilan par drone port (hebdomadaire) · alertes par catégorie (fiches, ou tableau compact quand un même type
// revient 3 fois ou plus) · bouton « Ouvrir l'application » · pied de page.

export type AlertMode = 'immediat' | 'quotidien' | 'hebdomadaire' | 'meteo' | 'test';
export type Level = 'info' | 'warn' | 'danger';

export interface AlertItem {
  event_id: string; kind: string; kind_label: string; category: 'maintenance' | 'securite' | 'suivi';
  level: Level; title: string; detail: string | null; link: string | null;
  drone_port_name: string | null; first_seen_at: string; reminder: boolean;
}

export interface PortSummary {
  port_id: string; port_name: string; from: string; to: string;
  flights: number; hours: number; payload_kg: number; qrf: number; incidents: number;
  drones: { id: string; code: string; status: string; total_hours: number; next_visit_hours: number; hours_to_next_visit: number; week_hours: number }[];
  alerts: { danger: number; warn: number; info: number };
}

export interface AlertEmailInput {
  mode: AlertMode;
  name: string;
  alerts: AlertItem[];
  summary?: PortSummary[];
  appUrl?: string | null;
  visitWarnHours?: number;
  /** intervalle des visites systématiques (barre d'avancement du bilan) */
  visitInterval?: number;
}

const FONT = "'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const C = {
  navy: '#0f2a4a', navy2: '#1d4370', ink: '#101828', text: '#344054', muted: '#667085', line: '#e4e7ec', soft: '#f6f8fb',
  page: '#e9eef5', orange: '#f7941d', ok: '#12a150', okBg: '#e7f6ee',
};
const LEVEL: Record<Level, { label: string; color: string; bg: string; border: string; dot: string }> = {
  danger: { label: 'Urgent', color: '#b42318', bg: '#fef3f2', border: '#f04438', dot: '●' },
  warn: { label: 'À prévoir', color: '#b54708', bg: '#fffaeb', border: '#f79009', dot: '●' },
  info: { label: 'Info', color: '#175cd3', bg: '#eff8ff', border: '#2e90fa', dot: '●' },
};
const CATEGORY: Record<AlertItem['category'], { label: string; icon: string }> = {
  securite: { label: 'Sécurité des vols', icon: '🛡️' },
  maintenance: { label: 'Maintenance', icon: '🔧' },
  suivi: { label: 'Suivi administratif', icon: '📋' },
};
const CAT_ORDER: AlertItem['category'][] = ['securite', 'maintenance', 'suivi'];
const DRONE_STATUS: Record<string, string> = { maintenance: 'en maintenance', immobilise: 'immobilisé', retire: 'retiré' };
const LEVEL_RANK: Record<Level, number> = { danger: 0, warn: 1, info: 2 };
const GROUP_FROM = 3; // un même type répété au moins 3 fois -> tableau compact
const GROUP_MAX = 6;  // lignes affichées dans un tableau compact (le reste : lien vers la page Alertes)

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const nf = (d: number) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d });
const num = (v: unknown, d = 1) => (v == null ? '—' : nf(d).format(Number(v)));
const date = (v: string) => { const [y, m, d] = v.slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
function todayLong() {
  const d = new Date(Date.now() + 3 * 3600_000); // heure de Madagascar
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Lien vers l'application (HashRouter) */
const appLink = (appUrl: string | null | undefined, path: string | null) =>
  appUrl && path ? `${appUrl.replace(/\/+$/, '')}/#${path.startsWith('/') ? path : `/${path}`}` : null;

const table = (inner: string, style = '') =>
  `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate;${style}">${inner}</table>`;

/** Bouton compatible Outlook (cellule colorée + lien) */
function button(label: string, href: string, color: string = C.navy) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto"><tr>
    <td bgcolor="${color}" style="background:${color};border-radius:8px">
      <a href="${esc(href)}" style="display:inline-block;padding:12px 26px;font-family:${FONT};font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px">${esc(label)}</a>
    </td></tr></table>`;
}

function pill(level: Level, text?: string) {
  const l = LEVEL[level];
  return `<span style="display:inline-block;font-family:${FONT};background:${l.bg};color:${l.color};border:1px solid ${l.border}33;font-size:11px;font-weight:700;letter-spacing:.03em;border-radius:999px;padding:2px 9px;white-space:nowrap">${l.dot} ${esc(text ?? l.label)}</span>`;
}

// ---------------------------------------------------------------------
// Bandeau titre : intitulé, phrase d'accueil, compteurs par niveau
// ---------------------------------------------------------------------
function hero(o: { kicker: string; title: string; intro: string; counts?: Record<Level, number> }) {
  const counter = (level: Level, n: number) => {
    const l = LEVEL[level];
    return `<td width="33%" style="padding:0 4px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
        <td bgcolor="#ffffff" style="background:#ffffff;border-radius:10px;padding:10px 12px;border-top:3px solid ${l.border}">
          <div style="font-family:${FONT};font-size:24px;line-height:1;font-weight:800;color:${n ? l.color : C.muted}">${n}</div>
          <div style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${C.muted};margin-top:5px">${l.label}</div>
        </td></tr></table></td>`;
  };
  return `<tr><td bgcolor="${C.navy}" style="background:${C.navy};background-image:linear-gradient(135deg,${C.navy} 0%,${C.navy2} 100%);padding:26px 28px ${o.counts ? '22px' : '26px'}">
    <div style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${C.orange}">${esc(o.kicker)}</div>
    <div style="font-family:${FONT};font-size:26px;line-height:1.2;font-weight:800;color:#ffffff;margin:6px 0 8px">${esc(o.title)}</div>
    <div style="font-family:${FONT};font-size:14px;line-height:1.5;color:#c7d4e6">${o.intro}</div>
    ${o.counts ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:18px"><tr>
      ${counter('danger', o.counts.danger)}${counter('warn', o.counts.warn)}${counter('info', o.counts.info)}</tr></table>` : ''}
  </td></tr>`;
}

// ---------------------------------------------------------------------
// Alertes
// ---------------------------------------------------------------------
function card(a: AlertItem, appUrl: string | null | undefined) {
  const l = LEVEL[a.level];
  const href = appLink(appUrl, a.link);
  const meta = [a.kind_label, a.drone_port_name, a.reminder ? 'rappel' : null].filter(Boolean).map(esc).join(' · ');
  return `<tr><td style="padding:0 0 10px">
    ${table(`<tr><td bgcolor="${l.bg}" style="background:${l.bg};border-left:4px solid ${l.border};border-radius:10px;padding:14px 16px">
      <div style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${l.color}">${l.dot} ${l.label}<span style="color:${C.muted};font-weight:600"> · ${meta}</span></div>
      <div style="font-family:${FONT};font-size:16px;line-height:1.35;font-weight:700;color:${C.ink};margin:5px 0 0">${esc(a.title)}</div>
      ${a.detail ? `<div style="font-family:${FONT};font-size:13.5px;line-height:1.5;color:${C.text};margin-top:4px">${esc(a.detail)}</div>` : ''}
      ${href ? `<div style="margin-top:10px"><a href="${esc(href)}" style="font-family:${FONT};font-size:13px;font-weight:700;color:${C.navy2};text-decoration:none">Ouvrir dans l'application&nbsp;→</a></div>` : ''}
    </td></tr>`)}
  </td></tr>`;
}

/** Un même type d'alerte répété : tableau compact */
function compact(items: AlertItem[], appUrl: string | null | undefined) {
  const worst = items.reduce<Level>((w, a) => (LEVEL_RANK[a.level] < LEVEL_RANK[w] ? a.level : w), 'info');
  const l = LEVEL[worst];
  const shown = items.slice(0, GROUP_MAX);
  const rest = items.length - shown.length;
  const more = appLink(appUrl, '/alertes');
  const rows = shown.map((a, i) => {
    const href = appLink(appUrl, a.link);
    const title = href ? `<a href="${esc(href)}" style="color:${C.ink};text-decoration:none;font-weight:700">${esc(a.title)}</a>` : `<strong>${esc(a.title)}</strong>`;
    return `<tr><td style="padding:9px 14px;border-top:${i ? `1px solid ${C.line}` : '0'};font-family:${FONT};font-size:13px;line-height:1.45;color:${C.text}">
      ${a.level !== worst ? `${pill(a.level)} ` : ''}${title}${a.reminder ? ` <span style="color:${C.muted};font-size:11px">(rappel)</span>` : ''}
      ${a.detail ? `<div style="color:${C.muted};font-size:12.5px;margin-top:2px">${esc(a.detail)}</div>` : ''}
    </td></tr>`;
  }).join('') + (rest > 0 ? `<tr><td style="padding:9px 14px;border-top:1px solid ${C.line};font-family:${FONT};font-size:13px;color:${C.muted}">… et <strong style="color:${C.ink}">${rest} autre(s)</strong>${more ? ` · <a href="${esc(more)}" style="color:${C.navy2};font-weight:700;text-decoration:none">tout voir dans l'application&nbsp;→</a>` : " dans la page Alertes de l'application"}</td></tr>` : '');
  return `<tr><td style="padding:0 0 10px">
    ${table(`<tr><td bgcolor="${l.bg}" style="background:${l.bg};border-left:4px solid ${l.border};border-radius:10px 10px 0 0;padding:11px 14px">
        <span style="font-family:${FONT};font-size:14px;font-weight:700;color:${C.ink}">${esc(items[0].kind_label)}</span>
        <span style="font-family:${FONT};font-size:12px;color:${C.muted}"> · ${items.length} éléments</span>&nbsp; ${pill(worst)}
      </td></tr>
      <tr><td style="border:1px solid ${C.line};border-top:0;border-radius:0 0 10px 10px">${table(rows)}</td></tr>`)}
  </td></tr>`;
}

function alertSections(alerts: AlertItem[], appUrl: string | null | undefined) {
  return CAT_ORDER.map((cat) => {
    const items = alerts.filter((a) => a.category === cat)
      .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
    if (!items.length) return '';
    // regroupement par type (ordre : le plus urgent d'abord)
    const byKind = new Map<string, AlertItem[]>();
    for (const a of items) byKind.set(a.kind, [...(byKind.get(a.kind) ?? []), a]);
    const blocks = [...byKind.values()].map((list) => (list.length >= GROUP_FROM ? compact(list, appUrl) : list.map((a) => card(a, appUrl)).join(''))).join('');
    const c = CATEGORY[cat];
    return `<tr><td style="padding:22px 28px 0">
      <div style="font-family:${FONT};font-size:13px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:${C.navy};padding-bottom:10px;border-bottom:2px solid ${C.line};margin-bottom:12px">
        ${c.icon}&nbsp; ${c.label} <span style="color:${C.muted};font-weight:600">· ${items.length}</span></div>
      ${table(blocks)}
    </td></tr>`;
  }).join('');
}

// ---------------------------------------------------------------------
// Bilan hebdomadaire par drone port
// ---------------------------------------------------------------------
function progress(pct: number, color: string) {
  const w = Math.max(2, Math.min(100, Math.round(pct)));
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse"><tr>
    <td width="${w}%" bgcolor="${color}" style="background:${color};height:6px;line-height:6px;font-size:0;border-radius:3px">&nbsp;</td>
    ${w < 100 ? `<td bgcolor="${C.line}" style="background:${C.line};height:6px;line-height:6px;font-size:0;border-radius:3px">&nbsp;</td>` : ''}
  </tr></table>`;
}

function summaryBlock(ports: PortSummary[], appUrl: string | null | undefined, warn: number, interval: number) {
  return ports.map((p) => {
    const kpi = (label: string, value: string, sub?: string) => `<td width="25%" style="padding:0 4px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
      <td bgcolor="${C.soft}" style="background:${C.soft};border-radius:10px;padding:12px 10px;text-align:center">
        <div style="font-family:${FONT};font-size:21px;line-height:1;font-weight:800;color:${C.ink}">${value}</div>
        <div style="font-family:${FONT};font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${C.muted};margin-top:6px">${label}</div>
        ${sub ? `<div style="font-family:${FONT};font-size:11px;color:${C.muted};margin-top:2px">${sub}</div>` : ''}
      </td></tr></table></td>`;
    const drones = p.drones.map((d) => {
      const left = Number(d.hours_to_next_visit);
      const color = left <= 0 ? LEVEL.danger.border : left <= warn ? LEVEL.warn.border : C.ok;
      const used = ((interval - Math.max(0, left)) / interval) * 100;
      const status = d.status !== 'operationnel' ? ` <span style="font-size:11px;font-weight:600;color:${LEVEL.warn.color}">${esc(DRONE_STATUS[d.status] ?? d.status)}</span>` : '';
      return `<tr>
        <td style="padding:10px 0;border-top:1px solid ${C.line};font-family:${FONT};font-size:14px;font-weight:800;color:${C.ink};white-space:nowrap" width="26%">${esc(d.code)}${status}</td>
        <td style="padding:10px 10px;border-top:1px solid ${C.line};font-family:${FONT};font-size:12px;color:${C.muted}" width="44%">
          ${progress(used, color)}
          <div style="margin-top:5px">${left <= 0 ? `<strong style="color:${LEVEL.danger.color}">visite dépassée de ${num(-left)} h</strong>` : `<strong style="color:${left <= warn ? LEVEL.warn.color : C.text}">${num(left)} h</strong> avant la visite 250 h`}</div>
        </td>
        <td style="padding:10px 0;border-top:1px solid ${C.line};font-family:${FONT};font-size:12px;color:${C.muted};text-align:right;white-space:nowrap" width="30%">
          <strong style="color:${C.ink};font-size:13px">${num(d.week_hours)} h</strong> cette semaine<br>${num(d.total_hours)} h au total</td>
      </tr>`;
    }).join('');
    const al = p.alerts;
    return `<tr><td style="padding:22px 28px 0">
      <div style="font-family:${FONT};font-size:18px;font-weight:800;color:${C.navy}">📍 ${esc(p.port_name)}
        <span style="font-size:12px;font-weight:500;color:${C.muted}">&nbsp; du ${date(p.from)} au ${date(p.to)}</span></div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:12px 0 4px"><tr>
        ${kpi('Vols', num(p.flights, 0), 'sur 7 jours')}${kpi('Heures', `${num(p.hours)}`, 'h de vol')}${kpi('Livré', num(p.payload_kg), 'kg')}${kpi('QRF · incid.', `${num(p.qrf, 0)} · ${num(p.incidents, 0)}`, 'retours · incidents')}
      </tr></table>
      ${p.drones.length ? table(drones, 'margin-top:8px') : ''}
      <div style="font-family:${FONT};font-size:13px;color:${C.text};margin-top:10px">Alertes en cours :&nbsp; ${pill('danger', `${al.danger} urgente(s)`)} ${pill('warn', `${al.warn} à prévoir`)} ${pill('info', `${al.info} info`)}</div>
    </td></tr>`;
  }).join('');
}

// ---------------------------------------------------------------------
// Gabarit
// ---------------------------------------------------------------------
function layout(o: { preheader: string; heroHtml: string; body: string; appUrl?: string | null; test?: boolean; cta?: string | null }) {
  const base = o.appUrl ? o.appUrl.replace(/\/+$/, '') : null;
  const prefs = appLink(o.appUrl, '/alertes');
  const logo = base
    ? `<img src="${esc(base)}/logo-unfpa.png" alt="UNFPA" height="36" style="display:block;height:36px;width:auto;border:0">`
    : `<span style="display:inline-block;background:${C.orange};color:#fff;font-family:${FONT};font-size:12px;font-weight:800;letter-spacing:.06em;border-radius:4px;padding:3px 8px">UNFPA</span>`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>UAV Maintenance</title></head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(o.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${C.page}" style="background:${C.page}"><tr><td align="center" style="padding:24px 10px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(16,24,40,.08)">
  <tr><td bgcolor="${C.orange}" style="background:${C.orange};height:5px;line-height:5px;font-size:0">&nbsp;</td></tr>
  ${o.test ? `<tr><td bgcolor="#fffaeb" style="background:#fffaeb;padding:10px 28px;font-family:${FONT};font-size:13px;font-weight:700;color:#b54708">🧪 Aperçu de test : toutes les alertes en cours vous concernant. Rien n'est marqué comme envoyé.</td></tr>` : ''}
  <tr><td style="padding:16px 28px">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
      <td style="vertical-align:middle">${logo}</td>
      <td style="vertical-align:middle;text-align:right;font-family:${FONT};font-size:12px;line-height:1.4;color:${C.muted}">
        <strong style="color:${C.navy}">UAV Maintenance</strong><br>${esc(todayLong())}</td>
    </tr></table>
  </td></tr>
  ${o.heroHtml}
  ${o.body}
  ${o.cta ? `<tr><td style="padding:26px 28px 6px" align="center">${button('Ouvrir l\'application', o.cta)}</td></tr>` : ''}
  <tr><td style="padding:24px 28px 26px">
    <div style="border-top:1px solid ${C.line};padding-top:16px;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.muted}">
      Livraisons médicales par drone · UNFPA Madagascar<br>
      E-mail envoyé automatiquement par l'application UAV Maintenance.
      ${prefs ? `<a href="${esc(prefs)}" style="color:${C.navy2};font-weight:600">Choisir les alertes que je reçois</a>` : 'Les alertes reçues se règlent dans la page Alertes de l\'application.'}
    </div>
  </td></tr>
</table>
</td></tr></table></body></html>`;
}

function textVersion(title: string, alerts: AlertItem[], summary: PortSummary[] | undefined, appUrl: string | null | undefined) {
  const lines = [title, ''];
  for (const p of summary ?? []) {
    lines.push(`${p.port_name} (du ${date(p.from)} au ${date(p.to)}) : ${p.flights} vols, ${num(p.hours)} h, ${num(p.payload_kg)} kg livrés, ${p.qrf} QRF, ${p.incidents} incident(s)`);
    for (const d of p.drones) lines.push(`  ${d.code} : ${num(d.total_hours)} h, reste ${num(d.hours_to_next_visit)} h avant la visite 250 h`);
    lines.push('');
  }
  for (const a of alerts) {
    lines.push(`[${LEVEL[a.level].label}] ${a.title}${a.reminder ? ' (rappel)' : ''}`);
    if (a.detail) lines.push(`  ${a.detail}`);
    const href = appLink(appUrl, a.link);
    if (href) lines.push(`  ${href}`);
  }
  return lines.join('\n');
}

export function renderAlertEmail(i: AlertEmailInput): { subject: string; html: string; text: string } {
  const n = i.alerts.length;
  const counts: Record<Level, number> = { danger: 0, warn: 0, info: 0 };
  for (const a of i.alerts) counts[a.level]++;
  const first = i.alerts[0];
  const name = esc(i.name);
  let subject: string, kicker: string, title: string, intro: string, preheader: string;
  switch (i.mode) {
    case 'immediat':
      subject = n === 1 ? `⚠ ${first.title}` : `⚠ ${n} alertes : ${first.title}…`;
      kicker = 'Alerte immédiate';
      title = n === 1 ? first.kind_label : `${n} alertes à traiter`;
      intro = `Bonjour ${name}, ${n === 1 ? 'cette situation demande' : 'ces situations demandent'} votre attention dès maintenant.`;
      preheader = first ? `${first.title}${first.detail ? ` — ${first.detail}` : ''}` : '';
      break;
    case 'meteo':
      subject = `🌬 Météo défavorable demain : ${i.alerts.map((a) => a.drone_port_name).filter(Boolean).join(', ') || first.title}`;
      kicker = 'Prévision Open-Meteo · créneau 06 h – 18 h';
      title = 'Météo défavorable demain';
      intro = `Bonjour ${name}, la prévision dépasse les limites de vol : adaptez le planning (créneaux plus calmes ou report).`;
      preheader = first?.detail ?? '';
      break;
    case 'hebdomadaire':
      subject = `Bilan de la semaine${n ? ` · ${n} point(s) à suivre` : ''}`;
      kicker = 'Bilan hebdomadaire';
      title = 'Votre semaine en un coup d\'œil';
      intro = `Bonjour ${name}, voici l'activité des 7 derniers jours, les échéances de la flotte et les points à suivre.`;
      preheader = `${(i.summary ?? []).map((p) => `${p.port_name} : ${p.flights} vols, ${num(p.hours)} h`).join(' · ')}${n ? ` · ${n} point(s) à suivre` : ''}`;
      break;
    case 'test':
      subject = `[TEST] Alertes en cours · ${n} point(s)`;
      kicker = 'Aperçu';
      title = 'Vos alertes en cours';
      intro = `Bonjour ${name}, voici ce que les e-mails d'alerte contiendraient aujourd'hui.`;
      preheader = `${counts.danger} urgente(s), ${counts.warn} à prévoir, ${counts.info} info`;
      break;
    default:
      subject = `Alertes du jour · ${n} point(s)${counts.danger ? ` dont ${counts.danger} urgent(s)` : ''}`;
      kicker = 'Récapitulatif du jour';
      title = counts.danger ? `${counts.danger} point(s) urgent(s) aujourd'hui` : 'Les points à suivre aujourd\'hui';
      intro = `Bonjour ${name}, voici les nouvelles alertes et les rappels du jour.`;
      preheader = i.alerts.slice(0, 3).map((a) => a.title).join(' · ');
  }
  const body = [
    i.summary?.length ? summaryBlock(i.summary, i.appUrl, i.visitWarnHours ?? 25, i.visitInterval ?? 250) : '',
    n ? alertSections(i.alerts, i.appUrl)
      : (i.mode === 'hebdomadaire' || i.mode === 'test')
        ? `<tr><td style="padding:22px 28px 0">${table(`<tr><td bgcolor="${C.okBg}" style="background:${C.okBg};border-radius:10px;padding:14px 16px;font-family:${FONT};font-size:14px;font-weight:600;color:${C.ok}">✓ Aucune alerte en cours : tout est en ordre.</td></tr>`)}</td></tr>`
        : '',
  ].join('');
  const showCounts = i.mode !== 'meteo' && (n > 1 || i.mode === 'hebdomadaire' || i.mode === 'test' || i.mode === 'quotidien');
  return {
    subject,
    html: layout({
      preheader, appUrl: i.appUrl, test: i.mode === 'test', body,
      heroHtml: hero({ kicker, title, intro, counts: showCounts ? counts : undefined }),
      cta: appLink(i.appUrl, i.mode === 'meteo' ? '/planification' : '/alertes'),
    }),
    text: textVersion(title, i.alerts, i.summary, i.appUrl),
  };
}
