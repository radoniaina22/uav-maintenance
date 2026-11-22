// Mise en forme des e-mails d'alerte (HTML compatible messageries : tableaux + styles en ligne).
// Module sans dépendance (fonction send-alerts, Deno ; prévisualisable sous Node).
// Le contenu (titres, détails, niveaux) vient tel quel des fonctions SQL alerts_* : aucun calcul ici.

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
}

const C = { navy: '#1f3a5f', ink: '#111827', muted: '#5b6b80', line: '#d6dde8', soft: '#f3f6fa', ok: '#15803d', warn: '#b45309', danger: '#b91c1c', info: '#1d4ed8' };
const LEVEL: Record<Level, { label: string; color: string; bg: string }> = {
  danger: { label: 'Urgent', color: C.danger, bg: '#fee2e2' },
  warn: { label: 'À prévoir', color: C.warn, bg: '#fef3c7' },
  info: { label: 'Info', color: C.info, bg: '#dbeafe' },
};
const CATEGORY: Record<AlertItem['category'], string> = { securite: 'Sécurité des vols', maintenance: 'Maintenance', suivi: 'Suivi administratif' };
const CAT_ORDER: AlertItem['category'][] = ['securite', 'maintenance', 'suivi'];
const DRONE_STATUS: Record<string, string> = { maintenance: 'en maintenance', immobilise: 'immobilisé', retire: 'retiré' };

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const nf = (d: number) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d });
const num = (v: unknown, d = 1) => (v == null ? '—' : nf(d).format(Number(v)));
const date = (v: string) => { const [y, m, d] = v.slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
const todayMg = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

/** Lien vers l'application (HashRouter) */
const appLink = (appUrl: string | null | undefined, path: string | null) =>
  appUrl && path ? `${appUrl.replace(/\/+$/, '')}/#${path.startsWith('/') ? path : `/${path}`}` : null;

function chip(level: Level) {
  const l = LEVEL[level];
  return `<span style="display:inline-block;background:${l.bg};color:${l.color};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;border-radius:3px;padding:1px 6px">${l.label}</span>`;
}

function alertRow(a: AlertItem, appUrl: string | null | undefined) {
  const href = appLink(appUrl, a.link);
  const title = href ? `<a href="${esc(href)}" style="color:${C.ink};text-decoration:none">${esc(a.title)}</a>` : esc(a.title);
  return `<tr><td style="padding:10px 0;border-bottom:1px solid ${C.line};vertical-align:top">
    <div style="margin-bottom:3px">${chip(a.level)} <span style="font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:.03em">${esc(a.kind_label)}${a.reminder ? ' · rappel' : ''}${a.drone_port_name ? ` · ${esc(a.drone_port_name)}` : ''}</span></div>
    <div style="font-size:15px;font-weight:700;color:${C.ink}">${title}</div>
    ${a.detail ? `<div style="font-size:13px;color:${C.muted};margin-top:2px">${esc(a.detail)}</div>` : ''}
    ${href ? `<div style="margin-top:4px"><a href="${esc(href)}" style="font-size:12px;color:${C.navy};font-weight:700">Ouvrir dans l'application →</a></div>` : ''}
  </td></tr>`;
}

function alertSections(alerts: AlertItem[], appUrl: string | null | undefined) {
  return CAT_ORDER.map((cat) => {
    const items = alerts.filter((a) => a.category === cat);
    if (!items.length) return '';
    return `<h2 style="margin:22px 0 4px;font-size:14px;color:${C.navy};text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid ${C.navy};padding-bottom:4px">${CATEGORY[cat]} <span style="font-weight:400;color:${C.muted}">· ${items.length}</span></h2>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">${items.map((a) => alertRow(a, appUrl)).join('')}</table>`;
  }).join('');
}

function summaryBlock(ports: PortSummary[], appUrl: string | null | undefined, warn: number) {
  return ports.map((p) => {
    const kpi = (label: string, value: string) => `<td width="25%" style="padding:4px;vertical-align:top"><div style="border:1px solid ${C.line};border-radius:6px;padding:8px 10px">
      <div style="font-size:10px;color:${C.muted};text-transform:uppercase;font-weight:700;letter-spacing:.04em">${label}</div>
      <div style="font-size:19px;font-weight:800;color:${C.ink}">${value}</div></div></td>`;
    const drones = p.drones.map((d) => {
      const left = Number(d.hours_to_next_visit);
      const color = left <= 0 ? C.danger : left <= warn ? C.warn : C.muted;
      return `<tr><td style="padding:6px 8px;border-bottom:1px solid ${C.line};font-size:13px"><strong>${esc(d.code)}</strong>${d.status !== 'operationnel' ? ` <span style="color:${C.warn}">(${esc(DRONE_STATUS[d.status] ?? d.status)})</span>` : ''}</td>
        <td style="padding:6px 8px;border-bottom:1px solid ${C.line};font-size:13px;text-align:right">${num(d.week_hours)} h</td>
        <td style="padding:6px 8px;border-bottom:1px solid ${C.line};font-size:13px;text-align:right">${num(d.total_hours)} h</td>
        <td style="padding:6px 8px;border-bottom:1px solid ${C.line};font-size:13px;text-align:right;color:${color}">${left <= 0 ? `dépassée de ${num(-left)} h` : `${num(left)} h`}</td></tr>`;
    }).join('');
    const th = (t: string, right = false) => `<th style="background:${C.navy};color:#fff;font-size:11px;text-transform:uppercase;padding:6px 8px;text-align:${right ? 'right' : 'left'}">${t}</th>`;
    const al = p.alerts;
    return `<h2 style="margin:22px 0 6px;font-size:15px;color:${C.navy}">${esc(p.port_name)} <span style="font-size:12px;font-weight:400;color:${C.muted}">· du ${date(p.from)} au ${date(p.to)}</span></h2>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>${kpi('Vols', num(p.flights, 0))}${kpi('Heures', `${num(p.hours)} h`)}${kpi('Livré', `${num(p.payload_kg)} kg`)}${kpi('QRF / incidents', `${num(p.qrf, 0)} / ${num(p.incidents, 0)}`)}</tr></table>
      ${p.drones.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:8px"><tr>${th('Drone')}${th('Semaine', true)}${th('Compteur', true)}${th('Avant visite 250 h', true)}</tr>${drones}</table>` : ''}
      <p style="margin:8px 0 0;font-size:13px;color:${C.muted}">Alertes en cours : <strong style="color:${C.danger}">${al.danger} urgente(s)</strong>, <strong style="color:${C.warn}">${al.warn} à prévoir</strong>, ${al.info} info.
      ${appUrl ? ` <a href="${esc(appLink(appUrl, '/alertes'))}" style="color:${C.navy};font-weight:700">Voir toutes les alertes</a>` : ''}</p>`;
  }).join('');
}

function layout(o: { title: string; subtitle: string; intro: string; body: string; appUrl?: string | null; test?: boolean }) {
  const prefs = appLink(o.appUrl, '/alertes');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.title)}</title></head>
<body style="margin:0;padding:0;background:#eef2f7;font-family:Arial,Helvetica,sans-serif;color:${C.ink}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef2f7"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fff;border-radius:8px;overflow:hidden">
${o.test ? `<tr><td style="background:#fef3c7;color:${C.warn};font-weight:700;font-size:13px;padding:8px 20px">Aperçu de test : toutes les alertes en cours vous concernant, rien n'est marqué comme envoyé.</td></tr>` : ''}
<tr><td style="padding:20px 20px 12px;border-bottom:3px solid ${C.navy}">
  <div style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${C.muted}">UAV Maintenance · UNFPA Madagascar</div>
  <div style="font-size:21px;font-weight:800;color:${C.navy};margin:6px 0 2px">${esc(o.title)}</div>
  <div style="font-size:14px;color:${C.muted}">${esc(o.subtitle)}</div>
</td></tr>
<tr><td style="padding:12px 20px 20px"><p style="margin:6px 0 0;font-size:14px">${o.intro}</p>${o.body}</td></tr>
<tr><td style="padding:12px 20px;background:${C.soft};font-size:11px;color:${C.muted}">E-mail envoyé automatiquement par l'application UAV Maintenance.
${prefs ? ` Pour choisir les alertes que vous recevez : <a href="${esc(prefs)}" style="color:${C.navy}">page Alertes</a>.` : ' Les alertes reçues se règlent dans la page Alertes de l\'application.'}</td></tr>
</table></td></tr></table></body></html>`;
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
  const urgent = i.alerts.filter((a) => a.level === 'danger').length;
  const first = i.alerts[0];
  let subject: string, title: string, subtitle: string, intro: string;
  switch (i.mode) {
    case 'immediat':
      subject = n === 1 ? `⚠ ${first.title}` : `⚠ ${n} alertes : ${first.title}…`;
      title = n === 1 ? first.kind_label : `${n} alertes à traiter`;
      subtitle = 'Alerte immédiate';
      intro = `Bonjour ${esc(i.name)}, ${n === 1 ? 'cette situation demande' : 'ces situations demandent'} votre attention dès maintenant.`;
      break;
    case 'meteo':
      subject = `Météo défavorable demain : ${i.alerts.map((a) => a.drone_port_name).filter(Boolean).join(', ') || first.title}`;
      title = 'Météo défavorable demain';
      subtitle = 'Prévision Open-Meteo, créneau de vol 06 h – 18 h';
      intro = `Bonjour ${esc(i.name)}, la prévision dépasse les limites de vol : adaptez le planning (créneaux plus calmes, report).`;
      break;
    case 'hebdomadaire':
      subject = `Bilan de la semaine${n ? ` · ${n} point(s) à suivre` : ''}`;
      title = 'Bilan de la semaine';
      subtitle = 'Les 7 derniers jours et les échéances de la flotte';
      intro = `Bonjour ${esc(i.name)}, voici le bilan des 7 derniers jours.`;
      break;
    case 'test':
      subject = `[TEST] Alertes en cours · ${n} point(s)`;
      title = 'Aperçu des alertes';
      subtitle = 'Toutes les alertes en cours qui vous seraient envoyées';
      intro = `Bonjour ${esc(i.name)}, voici ce que les e-mails d'alerte contiendraient aujourd'hui.`;
      break;
    default:
      subject = `Alertes du jour · ${n} point(s)${urgent ? ` dont ${urgent} urgent(s)` : ''}`;
      title = 'Alertes du jour';
      subtitle = `Récapitulatif du ${date(todayMg())}`;
      intro = `Bonjour ${esc(i.name)}, voici les points à suivre aujourd'hui.`;
  }
  const body = [
    i.summary?.length ? summaryBlock(i.summary, i.appUrl, i.visitWarnHours ?? 25) : '',
    n ? alertSections(i.alerts, i.appUrl) : (i.mode === 'hebdomadaire' || i.mode === 'test' ? `<p style="margin:18px 0 0;padding:10px;background:${C.soft};border-radius:6px;color:${C.muted};font-size:13px">Aucune alerte en cours.</p>` : ''),
  ].join('');
  return { subject, html: layout({ title, subtitle, intro, body, appUrl: i.appUrl, test: i.mode === 'test' }), text: textVersion(title, i.alerts, i.summary, i.appUrl) };
}
