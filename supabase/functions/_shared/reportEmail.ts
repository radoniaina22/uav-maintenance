// Mise en forme des e-mails des rapports mensuels (HTML compatible messageries : tableaux + styles en ligne)
// Module sans dépendance : utilisé par la fonction send-monthly-reports (Deno) et prévisualisable sous Node.
// Les chiffres viennent tels quels des fonctions SQL monthly_*_report : aucun calcul ici.

// deno-lint-ignore-file no-explicit-any
type Json = any;

export type MailKind = 'pilotes' | 'admin' | 'unfpa';

export interface EmailInput {
  kind: MailKind;
  report: Json;
  /** commentaire « faits marquants » (rapport UNFPA validé) */
  comment?: string | null;
  validatedBy?: string | null;
  validatedAt?: string | null;
  /** adresse de l'application (lien « voir le rapport complet ») */
  appUrl?: string | null;
  /** e-mail de test : bandeau et objet préfixé */
  test?: boolean;
  /** rapport admin : le rapport UNFPA du mois attend encore la validation */
  unfpaPending?: boolean;
}

export interface EmailOutput { subject: string; html: string; text: string; csv: { name: string; content: string } }

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const monthLabel = (m: string) => { const [y, mo] = m.split('-').map(Number); return `${MONTHS[mo - 1]} ${y}`; };
const nf = (d: number) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d });
const num = (v: Json, d = 1) => (v == null ? '—' : nf(d).format(Number(v)));
const kg = (v: Json) => (v == null ? '—' : `${num(v)} kg`);
const hours = (min: Json) => (min == null ? '—' : `${num(Number(min) / 60)} h`);
const date = (v: string | null | undefined) => { if (!v) return '—'; const [y, m, d] = v.slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
const esc = (s: Json) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const C = { navy: '#1f3a5f', ink: '#111827', muted: '#5b6b80', line: '#d6dde8', soft: '#f3f6fa', orange: '#f7941d', ok: '#15803d', warn: '#b45309', danger: '#b91c1c' };
const SEV: Record<string, string> = { mineur: 'Mineur', majeur: 'Majeur', critique: 'Critique' };

function delta(cur: Json, prev: Json, label: string) {
  if (cur == null || prev == null) return '';
  const c = Number(cur), p = Number(prev);
  if (p === 0) return c === 0 ? `= ${label}` : `nouveau (${label})`;
  const d = (100 * (c - p)) / p;
  if (Math.abs(d) < 0.5) return `= ${label}`;
  return `<span style="color:${d > 0 ? C.ok : C.danger}">${d > 0 ? '▲' : '▼'} ${num(Math.abs(d), 0)} %</span> ${label}`;
}

/** Ligne de chiffres clés (2 par ligne : lisible sur téléphone) */
function kpis(items: { label: string; value: string; sub?: string; color?: string }[]) {
  const rows: string[] = [];
  for (let i = 0; i < items.length; i += 2) {
    const cell = (k?: { label: string; value: string; sub?: string; color?: string }) => (k
      ? `<td width="50%" style="padding:6px;vertical-align:top"><div style="border:1px solid ${C.line};border-top:3px solid ${k.color ?? C.navy};border-radius:6px;padding:10px 12px">
          <div style="font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:.04em;font-weight:700">${esc(k.label)}</div>
          <div style="font-size:22px;font-weight:800;color:${C.ink};margin:2px 0">${k.value}</div>
          ${k.sub ? `<div style="font-size:12px;color:${C.muted}">${k.sub}</div>` : ''}</div></td>`
      : '<td width="50%"></td>');
    rows.push(`<tr>${cell(items[i])}${cell(items[i + 1])}</tr>`);
  }
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">${rows.join('')}</table>`;
}

function h2(title: string, note?: string) {
  return `<h2 style="margin:22px 0 8px;font-size:15px;color:${C.navy};text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid ${C.line};padding-bottom:4px">${esc(title)}${note ? ` <span style="font-size:12px;font-weight:400;text-transform:none;letter-spacing:0;color:${C.muted}">· ${esc(note)}</span>` : ''}</h2>`;
}

function table(head: string[], rows: string[][], numCols: number[] = [], empty = 'Aucun élément.') {
  if (!rows.length) return `<p style="margin:0;padding:8px 10px;background:${C.soft};border-radius:6px;color:${C.muted};font-size:13px">${esc(empty)}</p>`;
  const th = head.map((h, i) => `<th style="background:${C.navy};color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.03em;padding:6px 8px;text-align:${numCols.includes(i) ? 'right' : 'left'}">${esc(h)}</th>`).join('');
  const tr = rows.map((r, j) => `<tr>${r.map((c, i) => `<td style="padding:6px 8px;border-bottom:1px solid ${C.line};font-size:13px;${j % 2 ? `background:#f8fafc;` : ''}text-align:${numCols.includes(i) ? 'right' : 'left'};vertical-align:top">${c}</td>`).join('')}</tr>`).join('');
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">${`<tr>${th}</tr>`}${tr}</table>`;
}

const more = (n: number, shown: number) => (n > shown ? `<p style="margin:6px 0 0;font-size:12px;color:${C.muted}">… et ${n - shown} autre(s) : voir le rapport complet dans l'application.</p>` : '');

function layout(o: { title: string; subtitle: string; month: string; badge?: string; logo: boolean; body: string; link?: string | null; test?: boolean; appUrl?: string | null }) {
  // logo officiel servi par l'application (une image intégrée en base64 est bloquée par Gmail) ; sinon badge texte
  const logoImg = o.logo && o.appUrl
    ? `<img src="${esc(o.appUrl.replace(/\/+$/, ''))}/logo-unfpa.png" alt="UNFPA" height="44" style="display:block;height:44px;width:auto;margin-bottom:8px;border:0">`
    : '';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.title)}</title></head>
<body style="margin:0;padding:0;background:#eef2f7;font-family:Arial,Helvetica,sans-serif;color:${C.ink}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef2f7"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fff;border-radius:8px;overflow:hidden">
${o.test ? `<tr><td style="background:#fef3c7;color:${C.warn};font-weight:700;font-size:13px;padding:8px 20px">E-mail de test : seul l'administrateur qui l'a demandé le reçoit.</td></tr>` : ''}
<tr><td style="padding:20px 20px 12px;border-bottom:3px solid ${C.navy}">
  ${logoImg}<div style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${C.muted}">${o.logo && !logoImg ? `<span style="display:inline-block;background:${C.orange};color:#fff;border-radius:3px;padding:1px 6px;letter-spacing:.06em;margin-right:6px">UNFPA</span>` : ''}UNFPA Madagascar · Livraisons médicales par drone</div>
  <div style="font-size:22px;font-weight:800;color:${C.navy};margin:6px 0 2px">${esc(o.title)}</div>
  <div style="font-size:14px;color:${C.muted}">${esc(o.subtitle)} · <strong style="color:${C.ink};text-transform:capitalize">${esc(monthLabel(o.month))}</strong></div>
  ${o.badge ?? ''}
</td></tr>
<tr><td style="padding:4px 20px 20px">${o.body}
${o.link ? `<p style="margin:24px 0 0;text-align:center"><a href="${esc(o.link)}" style="display:inline-block;background:${C.navy};color:#fff;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:6px">Voir le rapport complet (PDF) dans l'application</a></p>` : ''}
</td></tr>
<tr><td style="padding:12px 20px;background:${C.soft};font-size:11px;color:${C.muted}">Rapport généré automatiquement par l'application UAV Maintenance. Le détail est joint au format CSV (s'ouvre dans Excel).</td></tr>
</table></td></tr></table></body></html>`;
}

// ---------------------------------------------------------------------
// CSV joint (séparateur « ; », décimales à virgule : Excel FR)
// ---------------------------------------------------------------------
function csv(rows: Record<string, Json>[]) {
  if (!rows.length) return '﻿Aucune donnée';
  const cols = Object.keys(rows[0]);
  const cell = (v: Json) => {
    if (v == null) return '';
    const s = typeof v === 'number' ? String(v).replace('.', ',') : Array.isArray(v) ? v.join(' | ') : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => cell(r[c])).join(';'))].join('\r\n');
}

const link = (appUrl: string | null | undefined, type: MailKind, month: string) =>
  appUrl ? `${appUrl.replace(/\/+$/, '')}/#/rapports-mensuels?type=${type}&mois=${month}` : null;

// ---------------------------------------------------------------------
// Rapports
// ---------------------------------------------------------------------
function pilotsEmail(i: EmailInput): EmailOutput {
  const r = i.report, s = r.summary, p = r.previous, month = r.period.month;
  const port = r.drone_port?.name ?? 'Tous les drone ports';
  const body = [
    h2('Activité du mois'),
    kpis([
      { label: 'Vols', value: num(s.flights, 0), sub: delta(s.flights, p.flights, 'vs mois préc.') },
      { label: 'Heures de vol', value: hours(s.minutes), sub: delta(s.minutes, p.minutes, 'vs mois préc.') },
      { label: 'Livraisons', value: num(s.deliveries, 0), sub: `${kg(s.kg)} livrés` },
      { label: 'QRF (vols interrompus)', value: num(s.qrf, 0), color: s.qrf ? '#f59e0b' : undefined, sub: `${num(s.open_flights, 0)} vol(s) encore ouvert(s)` },
    ]),
    h2('Flotte', 'visites 250 h'),
    table(['Drone', 'Vols', 'Heures', 'Total', 'Prochaine visite'],
      r.fleet.map((d: Json) => [`<strong>${esc(d.code)}</strong>`, num(d.flights, 0), hours(d.minutes), d.total_hours == null ? '—' : `${num(d.total_hours)} h`,
        d.next_visit_hours == null ? '—' : `${num(d.next_visit_hours, 0)} h <span style="color:${Number(d.hours_to_next_visit) <= 25 ? C.danger : C.muted}">(reste ${num(d.hours_to_next_visit)} h)</span>`]),
      [1, 2, 3]),
    h2('Rapports techniques ouverts', `${r.reports.open_total} au total`),
    table(['Gravité', 'Vol', 'Composant', 'Ouvert depuis'],
      r.reports.open.slice(0, 10).map((o: Json) => [`<strong style="color:${o.severity === 'mineur' ? C.muted : C.danger}">${SEV[o.severity] ?? o.severity}</strong>`,
        `${date(o.flight_date)} · ${esc(o.drone_code)}`, esc(o.component ?? '—'), `${num(o.age_days, 0)} j`]), [3], 'Aucun rapport ouvert.'),
    more(r.reports.open.length, 10),
    h2('À faire', 'CRM, ordres de travail, batteries, pièces'),
    `<ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.6">
      <li>${r.crm.incomplete.length} CRM incomplet(s) sur ${r.crm.closed_flights} vol(s) clôturé(s)</li>
      <li>${r.work_orders.open_total} ordre(s) de travail en cours, dont ${r.work_orders.overdue} en retard</li>
      <li>${r.batteries.alerts.length} batterie(s) à surveiller (cycles ou capacité)</li>
      <li>${r.parts.near_limit.length} pièce(s) proche(s) du potentiel, ${r.parts.stock_low.length} type(s) sous le stock minimum</li>
    </ul>`,
  ].join('');
  const flights = (r.flights ?? []).map((f: Json) => ({
    Date: f.flight_date, Décollage: f.takeoff_time?.slice(0, 5), Atterrissage: f.landing_time?.slice(0, 5), 'Durée (min)': Number(f.minutes),
    Drone: f.drone_code, Destination: f.destination_name, Type: f.qrf ? `QRF ${f.qrf_cause ?? ''}` : f.flight_type, Équipage: f.pilot_names,
    'Pilote en formation': f.trainee_name ?? null,
    Pack: f.pack_number, 'Charge (kg)': f.payload_kg == null ? null : Number(f.payload_kg), 'Conso. (mAh)': f.consumption_mah, Rapports: f.reports, Statut: f.status,
  }));
  return {
    subject: `${i.test ? '[TEST] ' : ''}Rapport technique ${monthLabel(month)} · ${port}`,
    html: layout({ title: 'Rapport technique mensuel', subtitle: port, month, logo: true, body, link: link(i.appUrl, 'pilotes', month), test: i.test, appUrl: i.appUrl }),
    text: `Rapport technique ${monthLabel(month)} · ${port} : ${s.flights} vol(s), ${num(Number(s.minutes) / 60)} h, ${s.qrf} QRF, ${r.reports.open_total} rapport(s) ouvert(s).`,
    csv: { name: `vols-${month}-${port}.csv`.replace(/[\\/:*?"<>|\s]+/g, '-'), content: csv(flights) },
  };
}

function adminEmail(i: EmailInput): EmailOutput {
  const r = i.report, s = r.summary, p = r.previous, month = r.period.month;
  const lvl: Record<string, string> = { danger: C.danger, warn: C.warn, info: '#1d4ed8' };
  const body = [
    i.unfpaPending ? `<p style="margin:16px 0 0;padding:10px 12px;border-left:4px solid ${C.orange};background:#fffbeb;font-size:14px"><strong>Rapport UNFPA de ${esc(monthLabel(month))} à valider.</strong> Il sera envoyé à l'équipe UNFPA dès votre validation dans l'application.</p>` : '',
    h2('Points d\'attention'),
    r.attention.length
      ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${r.attention.map((a: Json) => `<tr><td style="padding:6px 8px;border-left:4px solid ${lvl[a.level] ?? C.line};background:${C.soft};font-size:14px"><strong style="color:${lvl[a.level] ?? C.ink}">${esc(a.category)}</strong> · ${esc(a.label)}</td></tr><tr><td style="height:4px"></td></tr>`).join('')}</table>`
      : `<p style="margin:0;color:${C.ok};font-weight:700">Aucun point d'attention ce mois.</p>`,
    h2('Activité du réseau'),
    kpis([
      { label: 'Vols', value: num(s.flights, 0), sub: delta(s.flights, p.flights, 'vs mois préc.') },
      { label: 'Heures de vol', value: hours(s.minutes), sub: delta(s.minutes, p.minutes, 'vs mois préc.') },
      { label: 'Poids livré', value: kg(s.kg), sub: `${num(s.deliveries, 0)} livraison(s)` },
      { label: 'QRF', value: num(s.qrf, 0), sub: `${num(s.open_flights, 0)} vol(s) encore ouvert(s)` },
    ]),
    h2('Drone ports'),
    table(['Drone port', 'Vols', 'Heures', 'Rapports', 'OT ouverts', 'CRM incompl.'],
      r.by_port.map((d: Json) => [`<strong>${esc(d.name)}</strong>`, num(d.flights, 0), hours(d.minutes), `${num(d.reports_in_month, 0)} (${num(d.open_reports, 0)} ouv.)`,
        num(d.open_work_orders, 0), num(d.crm_incomplete, 0)]), [1, 2, 3, 4, 5]),
    h2('CSB à surveiller'),
    table(['CSB', 'Vols', 'Motif'],
      r.csb.csb.filter((c: Json) => c.watch).slice(0, 10).map((c: Json) => [`<strong>${esc(c.name)}</strong><br><span style="color:${C.muted};font-size:12px">${esc(c.district ?? '')}</span>`, num(c.flights, 0), esc(c.reasons.join(', '))]),
      [1], 'Aucun CSB à surveiller.'),
  ].join('');
  const rows = r.csb.csb.map((c: Json) => ({
    CSB: c.name, District: c.district, Région: c.region, 'Drone port': c.drone_ports, Vols: c.flights, Livraisons: c.deliveries, QRF: c.qrf,
    'Durée moyenne (min)': c.avg_minutes == null ? null : Number(c.avg_minutes), 'Vent moyen (m/s)': c.avg_wind == null ? null : Number(c.avg_wind),
    'Consommation moyenne (mAh)': c.avg_consumption == null ? null : Number(c.avg_consumption), Rapports: c.reports, 'Majeurs / critiques': c.major_reports,
    'À surveiller': c.watch ? c.reasons.join(', ') : '',
  }));
  return {
    subject: `${i.test ? '[TEST] ' : ''}Rapport technique administrateur ${monthLabel(month)}`,
    html: layout({ title: 'Rapport technique administrateur', subtitle: 'Tous les drone ports', month, logo: false, body, link: link(i.appUrl, 'admin', month), test: i.test, appUrl: i.appUrl }),
    text: `Rapport technique administrateur ${monthLabel(month)} : ${r.attention.length} point(s) d'attention, ${s.flights} vol(s).`,
    csv: { name: `csb-technique-${month}.csv`, content: csv(rows) },
  };
}

function unfpaEmail(i: EmailInput): EmailOutput {
  const r = i.report, k = r.kpis, p = r.previous, ly = r.last_year, month = r.period.month;
  const both = (c: Json, a: Json, b: Json) => [delta(c, a, 'vs M-1'), delta(c, b, 'vs N-1')].filter(Boolean).join('<br>');
  const badge = i.validatedAt
    ? `<div style="margin-top:8px;display:inline-block;background:#dcfce7;color:${C.ok};font-size:12px;font-weight:700;padding:3px 8px;border-radius:4px">Validé le ${date(i.validatedAt)}${i.validatedBy ? ` par ${esc(i.validatedBy)}` : ''}</div>`
    : `<div style="margin-top:8px;display:inline-block;background:${C.soft};color:${C.muted};font-size:12px;font-weight:700;padding:3px 8px;border-radius:4px">Brouillon : chiffres non validés</div>`;
  const served = r.by_csb.filter((c: Json) => c.deliveries > 0);
  const body = [
    i.comment ? h2('Faits marquants') + `<p style="margin:0;padding:10px 12px;border-left:4px solid ${C.orange};background:#fffbeb;font-size:14px;white-space:pre-wrap">${esc(i.comment)}</p>` : '',
    h2('Chiffres clés'),
    kpis([
      { label: 'Poids livré', value: kg(k.kg), sub: both(k.kg, p.kg, ly.kg), color: C.orange },
      { label: 'Livraisons réussies', value: num(k.deliveries, 0), sub: both(k.deliveries, p.deliveries, ly.deliveries) },
      { label: 'Taux de réussite', value: k.success_rate == null ? '—' : `${num(k.success_rate)} %`, sub: `${num(k.qrf_deliveries, 0)} QRF sur ${num(k.attempts, 0)} tentative(s)` },
      { label: 'CSB desservis', value: `${num(k.csb_served, 0)} / ${num(r.csb_active, 0)}`, sub: `${num(r.new_csb, 0)} nouveau(x) · ${num(k.districts_served, 0)} district(s)` },
      { label: 'Poids moyen par livraison', value: kg(k.kg_per_delivery) },
      { label: 'Cumul depuis janvier', value: kg(r.ytd.kg), sub: `${num(r.ytd.deliveries, 0)} livraison(s)` },
    ]),
    h2('Livraisons par district'),
    table(['District', 'Région', 'Poids', 'Livr.', 'CSB'],
      r.by_district.map((d: Json) => [`<strong>${esc(d.district)}</strong>`, esc(d.region), kg(d.kg), num(d.deliveries, 0), `${num(d.csb_served, 0)} / ${num(d.csb_active, 0)}`]),
      [2, 3, 4], 'Aucune livraison ce mois.'),
    h2('CSB desservis', `${served.length} CSB`),
    table(['CSB', 'District', 'Poids', 'Livr.'],
      served.slice(0, 15).map((c: Json) => [`<strong>${esc(c.name)}</strong>${c.first_time ? ` <span style="background:#dcfce7;color:${C.ok};font-size:11px;font-weight:700;padding:1px 5px;border-radius:3px">nouveau</span>` : ''}`,
        esc(c.district ?? '—'), kg(c.kg), num(c.deliveries, 0)]), [2, 3], 'Aucune livraison ce mois.'),
    more(served.length, 15),
  ].join('');
  const rows = served.map((c: Json) => ({
    CSB: c.name, Code: c.code, Catégorie: c.category, District: c.district, Région: c.region, 'Drone port': c.drone_ports,
    Livraisons: c.deliveries, 'Poids livré (kg)': Number(c.kg), 'Dernière livraison': c.last_delivery, 'Première livraison ce mois': c.first_time ? 'oui' : 'non',
  }));
  return {
    subject: `${i.test ? '[TEST] ' : ''}Rapport mensuel des livraisons par drone · ${monthLabel(month)}`,
    html: layout({ title: 'Rapport mensuel des livraisons', subtitle: 'Bilan basé sur le poids livré', month, badge, logo: true, body, link: link(i.appUrl, 'unfpa', month), test: i.test, appUrl: i.appUrl }),
    text: `Rapport mensuel des livraisons ${monthLabel(month)} : ${num(k.kg)} kg livrés, ${k.deliveries} livraison(s), ${k.csb_served} CSB desservis.`,
    csv: { name: `livraisons-csb-${month}.csv`, content: csv(rows) },
  };
}

export function renderReportEmail(i: EmailInput): EmailOutput {
  if (i.kind === 'unfpa') return unfpaEmail(i);
  if (i.kind === 'admin') return adminEmail(i);
  return pilotsEmail(i);
}
