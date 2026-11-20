// Vues « feuille A4 » des trois rapports mensuels (impression, export PDF).
// Couleurs fixes (papier blanc) : rendu identique à l'écran, à l'impression et dans le PDF.
import { ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { date, LABELS, minutes, num, time } from '../lib/format';
import {
  AdminReport, AttentionItem, Batteries, Crm, DeliveryKpis, DeliveryReport, FleetRow, FlightRow, FlightSummary, monthLabel,
  OpenFlight, Parts, pctChange, PART_EVENT, PilotRow, Qrf, Reports, TechReport, WO_KIND, WO_PRIORITY, WO_STATUS, WorkOrders, CRM_VISA,
} from '../lib/monthlyReports';

// ---------------------------------------------------------------------
// Briques communes
// ---------------------------------------------------------------------
const h = (min: number | null | undefined) => (min == null ? '—' : `${num(Number(min) / 60)} h`);
const kg = (v: number | null | undefined) => (v == null ? '—' : `${num(v)} kg`);
const pct = (v: number | null | undefined) => (v == null ? '—' : `${num(v)} %`);
const sevOrder = ['critique', 'majeur', 'mineur'] as const;

/**
 * Logo converti en PNG (le capteur de l'export PDF, html2canvas, déforme les SVG sans dimensions).
 * Le fichier source peut être remplacé (même nom) sans toucher au code.
 */
function SheetLogo({ src, alt }: { src: string; alt: string }) {
  const [png, setPng] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      // proportions : viewBox du SVG (un SVG sans width / height n'a pas de taille fiable), sinon taille de l'image
      let ratio: number | null = null;
      if (/\.svg($|\?)/i.test(src)) {
        const vb = (await fetch(src).then((r) => r.text())).match(/viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/);
        if (vb) ratio = Number(vb[1]) / Number(vb[2]);
      }
      const img = new Image();
      img.src = src;
      await img.decode();
      ratio ??= img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
      const h = 480, w = Math.round(h * ratio);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d')!.drawImage(img, 0, 0, w, h);
      if (alive) setPng(c.toDataURL('image/png'));
    })().catch(() => { /* logo affiché tel quel */ });
    return () => { alive = false; };
  }, [src]);
  return <img className="mr-logo" src={png ?? src} alt={alt} />;
}

function Sheet({ title, subtitle, period, logo, stamp, children }: {
  title: string; subtitle?: string | null; period: TechReport['period']; logo?: { src: string; alt: string }; stamp?: ReactNode; children: ReactNode;
}) {
  return (
    <article className={`mr-sheet${period.provisional ? ' is-draft' : ''}`}>
      <header className="mr-head mr-block">
        <div className="mr-head-left">
          {logo && <SheetLogo src={logo.src} alt={logo.alt} />}
          <div>
            <div className="mr-org">UNFPA Madagascar · Livraisons médicales par drone</div>
            <h1>{title}</h1>
            <div className="mr-sub">{subtitle}</div>
          </div>
        </div>
        <div className="mr-head-right">
          <div className="mr-month">{monthLabel(period.month)}</div>
          <div className="mr-sub">du {date(period.from)} au {date(period.to)}</div>
          <div className="mr-sub">Généré le {new Date(period.generated_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</div>
          {period.provisional && <div className="mr-tag mr-tag-warn">Mois en cours : chiffres provisoires</div>}
          {stamp}
        </div>
      </header>
      {children}
      <footer className="mr-foot mr-block">Chiffres calculés automatiquement à partir des données de l'application UAV Maintenance.</footer>
    </article>
  );
}

function Section({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="mr-section">
      <h2 className="mr-block">{title}{note && <span className="mr-note"> · {note}</span>}</h2>
      {children}
    </section>
  );
}

function Delta({ cur, prev, label, goodWhenUp = true }: { cur: number | null | undefined; prev: number | null | undefined; label: string; goodWhenUp?: boolean }) {
  const d = pctChange(cur, prev);
  if (d == null) return <span className="mr-delta">{prev == null ? '' : `${label} : nouveau`}</span>;
  if (Math.abs(d) < 0.5) return <span className="mr-delta">= {label}</span>;
  const good = d > 0 === goodWhenUp;
  return <span className={`mr-delta ${good ? 'up' : 'down'}`}>{d > 0 ? '▲' : '▼'} {num(Math.abs(d), 0)} % {label}</span>;
}

function Kpi({ label, value, sub, level }: { label: string; value: ReactNode; sub?: ReactNode; level?: 'warn' | 'danger' | 'ok' }) {
  return (
    <div className={`mr-kpi${level ? ` mr-kpi-${level}` : ''}`}>
      <div className="mr-kpi-label">{label}</div>
      <div className="mr-kpi-value">{value}</div>
      {sub && <div className="mr-kpi-sub">{sub}</div>}
    </div>
  );
}

type Col<T> = { head: string; cell: (r: T) => ReactNode; num?: boolean };
function Table<T>({ rows, cols, empty = 'Aucun élément.', rowClass }: { rows: T[]; cols: Col<T>[]; empty?: string; rowClass?: (r: T) => string }) {
  if (!rows.length) return <p className="mr-empty mr-block">{empty}</p>;
  return (
    <table className="mr-table">
      <thead><tr>{cols.map((c) => <th key={c.head} className={c.num ? 'num' : ''}>{c.head}</th>)}</tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={rowClass?.(r)}>{cols.map((c) => <td key={c.head} className={c.num ? 'num' : ''}>{c.cell(r)}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

function Bars({ rows, format = (v) => num(v) }: { rows: { label: string; value: number; sub?: string }[]; format?: (v: number) => string }) {
  if (!rows.length) return <p className="mr-empty mr-block">Aucune donnée.</p>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="mr-bars mr-block">
      {rows.map((r) => (
        <div key={r.label} className="mr-bar-row">
          <span className="mr-bar-label">{r.label}{r.sub && <small> {r.sub}</small>}</span>
          <span className="mr-bar-track"><span className="mr-bar" style={{ width: `${(100 * r.value) / max}%` }} /></span>
          <span className="mr-bar-value">{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

const Tag = ({ level, children }: { level: 'ok' | 'warn' | 'danger' | 'info' | 'neutral'; children: ReactNode }) => <span className={`mr-tag mr-tag-${level}`}>{children}</span>;
const sevLevel = (s: string) => (s === 'critique' ? 'danger' : s === 'majeur' ? 'warn' : 'neutral');
const visitLevel = (hLeft: number | null) => (hLeft == null ? 'neutral' : hLeft <= 0 ? 'danger' : hLeft <= 25 ? 'warn' : 'ok');

// ---------------------------------------------------------------------
// Sections partagées (rapport pilotes et rapport administrateur)
// ---------------------------------------------------------------------
function FlightKpis({ s, p }: { s: FlightSummary; p: FlightSummary }) {
  return (
    <div className="mr-kpis mr-block">
      <Kpi label="Vols" value={num(s.flights, 0)} sub={<Delta cur={s.flights} prev={p.flights} label="vs mois préc." />} />
      <Kpi label="Livraisons" value={num(s.deliveries, 0)} sub={<Delta cur={s.deliveries} prev={p.deliveries} label="vs mois préc." />} />
      <Kpi label="Heures de vol" value={h(s.minutes)} sub={<Delta cur={s.minutes} prev={p.minutes} label="vs mois préc." />} />
      <Kpi label="Poids livré" value={kg(s.kg)} sub={<Delta cur={s.kg} prev={p.kg} label="vs mois préc." />} />
      <Kpi label="QRF (vols interrompus)" value={num(s.qrf, 0)} level={s.qrf ? 'warn' : undefined} sub={`${num(s.controls, 0)} vol(s) de contrôle`} />
      <Kpi label="Vols encore ouverts" value={num(s.open_flights, 0)} level={s.open_flights ? 'warn' : 'ok'} sub={`${num(s.km)} km parcourus`} />
    </div>
  );
}

function OpenFlightsSection({ rows }: { rows: OpenFlight[] }) {
  if (!rows.length) return null;
  return (
    <Section title="Vols du mois à clôturer" note={`${rows.length} vol(s)`}>
      <Table rows={rows} cols={[
        { head: 'Date', cell: (r) => <Link to={`/vols/${r.flight_id}`}>{date(r.flight_date)} {time(r.takeoff_time)}</Link> },
        { head: 'Drone', cell: (r) => r.drone_code },
        { head: 'Destination', cell: (r) => r.destination_name ?? 'Vol de contrôle' },
        { head: 'Drone port', cell: (r) => r.drone_port_name ?? '—' },
      ]} />
    </Section>
  );
}

function FleetSection({ rows, showPort }: { rows: FleetRow[]; showPort?: boolean }) {
  return (
    <Section title="Flotte" note="heures et visites 250 h">
      <Table rows={rows} empty="Aucun drone." cols={[
        { head: 'Drone', cell: (r) => <Link to={`/drones/${r.id}`}><strong>{r.code}</strong></Link> },
        ...(showPort ? [{ head: 'Drone port', cell: (r: FleetRow) => r.drone_port_name ?? '—' }] : []),
        { head: 'Statut', cell: (r) => <Tag level={r.status === 'operationnel' ? 'ok' : r.status === 'retire' ? 'neutral' : 'warn'}>{LABELS.droneStatus[r.status as keyof typeof LABELS.droneStatus] ?? r.status}</Tag> },
        { head: 'Vols', cell: (r) => num(r.flights, 0), num: true },
        { head: 'Heures du mois', cell: (r) => h(r.minutes), num: true },
        { head: 'Heures totales', cell: (r) => (r.total_hours == null ? '—' : `${num(r.total_hours)} h`), num: true },
        { head: 'Prochaine visite', cell: (r) => (r.next_visit_hours == null ? '—' : <Tag level={visitLevel(r.hours_to_next_visit)}>{num(r.next_visit_hours, 0)} h · reste {num(r.hours_to_next_visit)} h</Tag>) },
        { head: 'Visites', cell: (r) => num(r.visits_in_month, 0), num: true },
        { head: 'Rapports ouverts', cell: (r) => num(r.open_reports ?? 0, 0), num: true },
        { head: 'OT ouverts', cell: (r) => num(r.open_work_orders, 0), num: true },
      ]} />
    </Section>
  );
}

function BatteriesSection({ b, showPort }: { b: Batteries; showPort?: boolean }) {
  return (
    <Section title="Batteries" note={`${b.packs.length} pack(s) en service ou en stock`}>
      {b.alerts.length > 0 && (
        <Table rows={b.alerts} cols={[
          { head: 'Batterie à surveiller', cell: (r) => <Link to={`/batteries/${r.id}`}>{r.code}</Link> },
          ...(showPort ? [{ head: 'Drone port', cell: (r: Batteries['alerts'][number]) => r.drone_port_name ?? '—' }] : []),
          { head: 'Cycles', cell: (r) => `${num(r.total_cycles, 0)} / ${num(r.max_cycles, 0)}`, num: true },
          { head: '% des cycles', cell: (r) => <Tag level={r.cycle_pct >= 100 ? 'danger' : r.cycle_pct >= 90 ? 'warn' : 'ok'}>{pct(r.cycle_pct)}</Tag>, num: true },
          { head: 'Capacité réelle', cell: (r) => (r.health_pct == null ? '—' : <Tag level={r.health_pct < 75 ? 'danger' : r.health_pct < 85 ? 'warn' : 'ok'}>{pct(r.health_pct)}</Tag>), num: true },
        ]} />
      )}
      <Table rows={b.packs} empty="Aucun pack." cols={[
        { head: 'Pack', cell: (r) => <strong>{r.pack_number}</strong> },
        ...(showPort ? [{ head: 'Drone port', cell: (r: Batteries['packs'][number]) => r.drone_port_name ?? '—' }] : []),
        { head: 'Statut', cell: (r) => LABELS.batteryStatus[r.status as keyof typeof LABELS.batteryStatus] ?? r.status },
        { head: 'Vols du mois', cell: (r) => num(r.flights_in_month, 0), num: true },
        { head: 'Cycles max', cell: (r) => num(r.max_total_cycles ?? 0, 0), num: true },
        { head: '% cycles', cell: (r) => pct(r.max_cycle_pct), num: true },
        { head: 'Capacité min.', cell: (r) => pct(r.min_health_pct), num: true },
      ]} />
      {b.transfers.length > 0 && (
        <Table rows={b.transfers} cols={[
          { head: 'Transfert', cell: (r) => date(r.date) },
          { head: 'Batterie', cell: (r) => r.battery },
          { head: 'De', cell: (r) => r.from_port ?? '—' },
          { head: 'Vers', cell: (r) => r.to_port ?? '—' },
          { head: 'Note', cell: (r) => r.notes ?? '' },
        ]} />
      )}
    </Section>
  );
}

function PartsSection({ p }: { p: Parts }) {
  const c = (k: string) => num(p.counts[k] ?? 0, 0);
  return (
    <Section title="Pièces" note={`${c('montage')} montage(s), ${c('demontage')} démontage(s), ${c('quarantaine')} quarantaine(s), ${c('rebut')} rebut(s)`}>
      {p.mounted_by_type.length > 0 && <Bars rows={p.mounted_by_type.map((r) => ({ label: r.type_name, value: r.n }))} format={(v) => `${num(v, 0)} montée(s)`} />}
      <Table rows={p.events} empty="Aucun mouvement de pièce ce mois." cols={[
        { head: 'Date', cell: (r) => date(r.at) },
        { head: 'Mouvement', cell: (r) => PART_EVENT[r.event_type] ?? r.event_type },
        { head: 'Pièce', cell: (r) => `${r.part_code} · ${r.type_name}` },
        { head: 'Drone', cell: (r) => r.drone_code ?? '—' },
        { head: 'Motif', cell: (r) => r.reason ?? '' },
      ]} />
      {p.stock_low.length > 0 && (
        <Table rows={p.stock_low} cols={[
          { head: 'Stock sous le minimum', cell: (r) => r.type_name },
          { head: 'Drone port', cell: (r) => r.drone_port_name },
          { head: 'En stock', cell: (r) => <Tag level="warn">{num(r.in_stock, 0)} / {num(r.min_qty, 0)}</Tag>, num: true },
        ]} />
      )}
      {p.near_limit.length > 0 && (
        <Table rows={p.near_limit} cols={[
          { head: 'Pièce proche du potentiel', cell: (r) => <Link to={`/pieces/${r.id}`}>{r.code} · {r.type_name}</Link> },
          { head: 'Drone', cell: (r) => `${r.drone_code ?? '—'}${r.slot_label ? ` · ${r.slot_label}` : ''}` },
          { head: 'Heures', cell: (r) => `${num(r.total_hours)} / ${num(r.max_hours, 0)} h`, num: true },
          { head: 'Potentiel', cell: (r) => <Tag level={r.potential_pct >= 100 ? 'danger' : 'warn'}>{pct(r.potential_pct)}</Tag>, num: true },
        ]} />
      )}
    </Section>
  );
}

function ReportsSection({ r, showPort }: { r: Reports; showPort?: boolean }) {
  return (
    <Section title="Rapports techniques et incidents">
      <div className="mr-kpis mr-block">
        <Kpi label="Rapports du mois" value={num(r.month_total, 0)} sub={`dont ${num(r.month_incidents, 0)} incident(s)`} />
        <Kpi label="Par gravité" value={<span className="mr-sev">{sevOrder.map((s) => <Tag key={s} level={sevLevel(s)}>{LABELS.severity[s]} {r.month_by_severity[s]}</Tag>)}</span>} />
        <Kpi label="Clos ce mois" value={num(r.closed_in_month, 0)} sub={r.avg_resolution_days == null ? 'délai moyen : —' : `délai moyen : ${num(r.avg_resolution_days)} j`} />
        <Kpi label="Encore ouverts" value={num(r.open_total, 0)} level={r.open.some((o) => o.severity !== 'mineur') ? 'danger' : r.open_total ? 'warn' : 'ok'} sub="tous mois confondus" />
      </div>
      {r.components.length > 0 && <Bars rows={r.components.map((c) => ({ label: c.component, value: c.n }))} format={(v) => `${num(v, 0)} rapport(s)`} />}
      <Table rows={r.open} empty="Aucun rapport ouvert." cols={[
        { head: 'Gravité', cell: (o) => <Tag level={sevLevel(o.severity)}>{LABELS.severity[o.severity]}</Tag> },
        { head: 'Vol', cell: (o) => <Link to={`/vols/${o.flight_id}`}>{date(o.flight_date)} · {o.drone_code}</Link> },
        ...(showPort ? [{ head: 'Drone port', cell: (o: Reports['open'][number]) => o.drone_port_name ?? '—' }] : []),
        { head: 'Type', cell: (o) => LABELS.reportType[o.report_type] },
        { head: 'Composant', cell: (o) => o.component ?? '—' },
        { head: 'Description', cell: (o) => <span className="mr-clip">{o.description}</span> },
        { head: 'Ouvert depuis', cell: (o) => `${num(o.age_days, 0)} j`, num: true },
      ]} />
    </Section>
  );
}

function WorkOrdersSection({ w, showPort }: { w: WorkOrders; showPort?: boolean }) {
  return (
    <Section title="Ordres de travail" note={`${w.opened_in_month} ouvert(s) et ${w.closed_in_month} clôturé(s) ce mois`}>
      <Table rows={w.open} empty="Aucun OT en cours." rowClass={(o) => (o.overdue ? 'is-late' : '')} cols={[
        { head: 'OT', cell: (o) => <Link to={`/ordres-travail/${o.id}`}>{o.number}</Link> },
        { head: 'Drone', cell: (o) => o.drone_code },
        ...(showPort ? [{ head: 'Drone port', cell: (o: WorkOrders['open'][number]) => o.drone_port_name ?? '—' }] : []),
        { head: 'Intitulé', cell: (o) => <span className="mr-clip">{o.title}</span> },
        { head: 'Type', cell: (o) => WO_KIND[o.kind] ?? o.kind },
        { head: 'Priorité', cell: (o) => <Tag level={o.priority === 'urgente' ? 'danger' : o.priority === 'haute' ? 'warn' : 'neutral'}>{WO_PRIORITY[o.priority] ?? o.priority}</Tag> },
        { head: 'Statut', cell: (o) => WO_STATUS[o.status] ?? o.status },
        { head: 'Échéance', cell: (o) => (o.due_date ? <>{date(o.due_date)}{o.overdue && <> <Tag level="danger">en retard</Tag></>}</> : '—') },
      ]} />
    </Section>
  );
}

function CrmSection({ c, showPort }: { c: Crm; showPort?: boolean }) {
  const rate = c.closed_flights ? (100 * c.complete) / c.closed_flights : null;
  return (
    <Section title="Comptes rendus matériel (CRM)" note={`${c.complete} complet(s) sur ${c.closed_flights} vol(s) clôturé(s)${rate == null ? '' : ` · ${num(rate, 0)} %`}`}>
      <Table rows={c.incomplete} empty="Tous les CRM des vols clôturés sont signés." cols={[
        { head: 'Vol', cell: (r) => <Link to={`/vols/${r.flight_id}/crm`}>{date(r.flight_date)} {time(r.takeoff_time)}</Link> },
        { head: 'Drone', cell: (r) => r.drone_code },
        ...(showPort ? [{ head: 'Drone port', cell: (r: Crm['incomplete'][number]) => r.drone_port_name ?? '—' }] : []),
        { head: 'Visa(s) manquant(s)', cell: (r) => r.missing.map((m) => CRM_VISA[m] ?? m).join(', ') },
      ]} />
    </Section>
  );
}

function QrfSection({ q }: { q: Qrf }) {
  const conds = Object.entries(q.by_condition).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ label: LABELS.qrfConditions[k as keyof typeof LABELS.qrfConditions] ?? k, value: v }));
  return (
    <Section title="QRF : vols interrompus avant largage" note={`${q.total} QRF · météo ${q.by_cause.meteo} · technique ${q.by_cause.technique} · autre ${q.by_cause.autre} · ${q.retried} relancé(s)`}>
      {conds.length > 0 && <Bars rows={conds} format={(v) => `${num(v, 0)} fois`} />}
      <Table rows={q.list} empty="Aucun QRF ce mois." cols={[
        { head: 'Vol', cell: (r) => <Link to={`/vols/${r.flight_id}`}>{date(r.flight_date)} · {r.drone_code}</Link> },
        { head: 'Destination', cell: (r) => r.destination_name ?? '—' },
        { head: 'Cause', cell: (r) => LABELS.qrfCause[r.cause as keyof typeof LABELS.qrfCause] ?? r.cause },
        { head: 'Conditions', cell: (r) => r.conditions.map((k) => LABELS.qrfConditions[k as keyof typeof LABELS.qrfConditions] ?? k).join(', ') || '—' },
      ]} />
    </Section>
  );
}

function PilotsSection({ rows, showPort }: { rows: PilotRow[]; showPort?: boolean }) {
  return (
    <Section title="Équipe" note="heures de vol du mois (vols ouverts et clôturés)">
      <Table rows={rows} empty="Aucun pilote." cols={[
        { head: 'Pilote', cell: (p) => <>{p.full_name}{!p.has_account && <span className="mr-note"> · sans compte</span>}</> },
        ...(showPort ? [{ head: 'Drone port', cell: (p: PilotRow) => p.drone_port_name ?? '—' }] : []),
        { head: 'Vols', cell: (p) => num(p.flights, 0), num: true },
        { head: 'Heures', cell: (p) => minutes(p.minutes), num: true },
        { head: 'dont commandant de bord', cell: (p) => minutes(p.pic_minutes), num: true },
      ]} />
    </Section>
  );
}

function FlightsSection({ rows, showPort }: { rows: FlightRow[]; showPort?: boolean }) {
  const total = rows.reduce((s, f) => s + Number(f.minutes), 0);
  return (
    <Section title="Vols effectués du mois" note={`${rows.length} vol(s) · ${minutes(total)}`}>
      <Table rows={rows} empty="Aucun vol ce mois." rowClass={(f) => (f.qrf ? 'is-watch' : '')} cols={[
        { head: 'Date', cell: (f) => <Link to={`/vols/${f.flight_id}`}>{date(f.flight_date)}</Link> },
        { head: 'Heures', cell: (f) => `${time(f.takeoff_time)} → ${time(f.landing_time)}` },
        { head: 'Durée', cell: (f) => minutes(f.minutes), num: true },
        { head: 'Drone', cell: (f) => f.drone_code },
        ...(showPort ? [{ head: 'Drone port', cell: (f: FlightRow) => f.drone_port_name ?? '—' }] : []),
        { head: 'Destination', cell: (f) => f.destination_name ?? '—' },
        { head: 'Type', cell: (f) => (f.qrf
          ? <Tag level="warn">QRF{f.qrf_cause ? ` ${LABELS.qrfCause[f.qrf_cause as keyof typeof LABELS.qrfCause]?.toLowerCase() ?? ''}` : ''}</Tag>
          : f.flight_type === 'controle' ? 'Contrôle' : 'Livraison') },
        { head: 'Équipage', cell: (f) => f.pilot_names ?? '—' },
        { head: 'Pack', cell: (f) => f.pack_number ?? '—', num: true },
        { head: 'Charge', cell: (f) => kg(f.payload_kg), num: true },
        { head: 'Conso.', cell: (f) => (f.consumption_mah == null ? '—' : `${num(f.consumption_mah, 0)} mAh`), num: true },
        { head: 'Rapp.', cell: (f) => (f.reports ? <Tag level="warn">{f.reports}</Tag> : '0'), num: true },
        { head: 'Statut', cell: (f) => (f.status === 'cloture' ? 'Clôturé' : <Tag level="warn">Ouvert</Tag>) },
      ]} />
    </Section>
  );
}

// ---------------------------------------------------------------------
// 1. Rapport technique pilotes
// ---------------------------------------------------------------------
export function TechReportView({ r }: { r: TechReport }) {
  const all = !r.drone_port;
  return (
    <Sheet title="Rapport technique mensuel" subtitle={r.drone_port ? `Drone port de ${r.drone_port.name}` : 'Tous les drone ports'} period={r.period}>
      <Section title="Activité du mois"><FlightKpis s={r.summary} p={r.previous} /></Section>
      <OpenFlightsSection rows={r.open_flights} />
      <FleetSection rows={r.fleet} showPort={all} />
      <ReportsSection r={r.reports} showPort={all} />
      <QrfSection q={r.qrf} />
      <BatteriesSection b={r.batteries} showPort={all} />
      <PartsSection p={r.parts} />
      <WorkOrdersSection w={r.work_orders} showPort={all} />
      <CrmSection c={r.crm} showPort={all} />
      <PilotsSection rows={r.pilots} showPort={all} />
      <FlightsSection rows={r.flights ?? []} showPort={all} />
    </Sheet>
  );
}

// ---------------------------------------------------------------------
// 2. Rapport technique administrateur
// ---------------------------------------------------------------------
function AttentionList({ items }: { items: AttentionItem[] }) {
  if (!items.length) return <p className="mr-ok mr-block">Aucun point d'attention : rien à signaler ce mois.</p>;
  return (
    <ul className="mr-attention">
      {items.map((a, i) => (
        <li key={i} className={`mr-block mr-att-${a.level}`}>
          <Tag level={a.level}>{a.level === 'danger' ? 'Critique' : a.level === 'warn' ? 'À traiter' : 'Info'}</Tag>
          <span className="mr-att-cat">{a.category}</span>
          {a.link ? <Link to={a.link}>{a.label}</Link> : <span>{a.label}</span>}
        </li>
      ))}
    </ul>
  );
}

export function AdminReportView({ r }: { r: AdminReport }) {
  const net = r.csb.network;
  return (
    <Sheet title="Rapport technique administrateur" subtitle="Réseau complet : tous les drone ports" period={r.period}>
      <Section title="Points d'attention" note="du plus grave au moins grave"><AttentionList items={r.attention} /></Section>
      <Section title="Activité du réseau"><FlightKpis s={r.summary} p={r.previous} /></Section>
      <Section title="Comparaison des drone ports">
        <Table rows={r.by_port} empty="Aucun drone port." cols={[
          { head: 'Drone port', cell: (p) => <strong>{p.name}</strong> },
          { head: 'Vols', cell: (p) => num(p.flights, 0), num: true },
          { head: 'Heures', cell: (p) => h(p.minutes), num: true },
          { head: 'Livr.', cell: (p) => num(p.deliveries, 0), num: true },
          { head: 'kg', cell: (p) => num(p.kg), num: true },
          { head: 'QRF (tech.)', cell: (p) => `${num(p.qrf, 0)} (${num(p.qrf_technique, 0)})`, num: true },
          { head: 'Rapports (inc.)', cell: (p) => `${num(p.reports_in_month, 0)} (${num(p.incidents_in_month, 0)})`, num: true },
          { head: 'Rapports ouverts', cell: (p) => num(p.open_reports, 0), num: true },
          { head: 'OT ouverts / retard', cell: (p) => `${num(p.open_work_orders, 0)} / ${num(p.overdue_work_orders, 0)}`, num: true },
          { head: 'CRM incomplets', cell: (p) => num(p.crm_incomplete, 0), num: true },
          { head: 'Drones indispo.', cell: (p) => `${num(p.drones_unavailable, 0)} / ${num(p.drones, 0)}`, num: true },
        ]} />
      </Section>
      <OpenFlightsSection rows={r.open_flights} />
      <FleetSection rows={r.fleet} showPort />
      <Section title="Volet technique par CSB"
        note={`moyennes du réseau : ${net.avg_consumption == null ? '—' : `${num(net.avg_consumption, 0)} mAh`}, vent ${net.avg_wind == null ? '—' : `${num(net.avg_wind)} m/s`}`}>
        <p className="mr-hint mr-block">« À surveiller » : incident majeur ou critique, au moins 2 QRF, ou consommation / vent moyens supérieurs de plus de 20 % à la moyenne du réseau.</p>
        <Table rows={r.csb.csb} empty="Aucun vol vers un CSB ce mois." rowClass={(c) => (c.watch ? 'is-watch' : '')} cols={[
          { head: 'CSB', cell: (c) => <><strong>{c.name}</strong><div className="mr-note">{[c.district, c.drone_ports].filter(Boolean).join(' · ')}</div></> },
          { head: 'Vols', cell: (c) => num(c.flights, 0), num: true },
          { head: 'QRF (mét./tech.)', cell: (c) => (c.qrf ? `${c.qrf} (${c.qrf_meteo}/${c.qrf_technique})` : '0'), num: true },
          { head: 'Durée moy.', cell: (c) => (c.avg_minutes == null ? '—' : `${num(c.avg_minutes, 0)} min`), num: true },
          { head: 'Vent moy.', cell: (c) => (c.avg_wind == null ? '—' : `${num(c.avg_wind)} m/s`), num: true },
          { head: 'Conso. moy.', cell: (c) => (c.avg_consumption == null ? '—' : `${num(c.avg_consumption, 0)} mAh`), num: true },
          { head: 'Charge moy.', cell: (c) => kg(c.avg_payload), num: true },
          { head: 'Rapports (maj./crit.)', cell: (c) => `${c.reports} (${c.major_reports})`, num: true },
          { head: 'À surveiller', cell: (c) => (c.watch ? <Tag level="warn">{c.reasons.join(', ')}</Tag> : '') },
        ]} />
      </Section>
      <ReportsSection r={r.reports} showPort />
      <QrfSection q={r.qrf} />
      <BatteriesSection b={r.batteries} showPort />
      <PartsSection p={r.parts} />
      <WorkOrdersSection w={r.work_orders} showPort />
      <CrmSection c={r.crm} showPort />
      <Section title="Traçabilité" note="journal d'audit du mois">
        <div className="mr-kpis mr-block">
          <Kpi label="Opérations enregistrées" value={num(r.audit.entries, 0)} />
          <Kpi label="Suppressions" value={num(r.audit.deletions, 0)} />
          <Kpi label="Vols rouverts" value={num(r.audit.flights_reopened, 0)} level={r.audit.flights_reopened ? 'warn' : undefined} />
          <Kpi label="OT rouverts" value={num(r.audit.work_orders_reopened, 0)} level={r.audit.work_orders_reopened ? 'warn' : undefined} />
        </div>
      </Section>
      <PilotsSection rows={r.pilots} showPort />
    </Sheet>
  );
}

// ---------------------------------------------------------------------
// 3. Rapport livraisons UNFPA
// ---------------------------------------------------------------------
function DeliveryKpiRow({ k, prev, ly }: { k: DeliveryKpis; prev: DeliveryKpis; ly: DeliveryKpis }) {
  const both = (cur: number | null, a: number | null, b: number | null, up = true) => (
    <><Delta cur={cur} prev={a} label="vs M-1" goodWhenUp={up} /><br /><Delta cur={cur} prev={b} label="vs N-1" goodWhenUp={up} /></>
  );
  return (
    <div className="mr-kpis mr-block">
      <Kpi label="Poids livré" value={kg(k.kg)} sub={both(k.kg, prev.kg, ly.kg)} />
      <Kpi label="Livraisons réussies" value={num(k.deliveries, 0)} sub={both(k.deliveries, prev.deliveries, ly.deliveries)} />
      <Kpi label="Taux de réussite" value={pct(k.success_rate)} level={k.success_rate == null ? undefined : k.success_rate >= 90 ? 'ok' : 'warn'}
        sub={`${num(k.qrf_deliveries, 0)} QRF sur ${num(k.attempts, 0)} tentative(s)`} />
      <Kpi label="CSB desservis" value={num(k.csb_served, 0)} sub={both(k.csb_served, prev.csb_served, ly.csb_served)} />
      <Kpi label="Districts desservis" value={num(k.districts_served, 0)} />
      <Kpi label="Poids moyen par livraison" value={kg(k.kg_per_delivery)} />
      <Kpi label="Poids livré par heure de vol" value={k.kg_per_hour == null ? '—' : `${num(k.kg_per_hour)} kg/h`} sub="QRF compris dans les heures" />
      <Kpi label="Délai moyen jusqu'au largage" value={k.avg_time_to_drop == null ? '—' : `${num(k.avg_time_to_drop, 0)} min`} sub={`vol complet : ${k.avg_minutes == null ? '—' : `${num(k.avg_minutes, 0)} min`}`} />
    </div>
  );
}

function DailyChart({ days }: { days: DeliveryReport['daily'] }) {
  const max = Math.max(1, ...days.map((d) => Number(d.kg)));
  return (
    <div className="mr-cols mr-block" role="img" aria-label="Poids livré par jour">
      {days.map((d) => (
        <div key={d.date} className="mr-col" title={`${date(d.date)} : ${num(d.kg)} kg, ${d.deliveries} livraison(s)`}>
          <span className="mr-col-bar" style={{ height: `${(100 * Number(d.kg)) / max}%` }} />
          <span className="mr-col-label">{Number(d.date.slice(8))}</span>
        </div>
      ))}
    </div>
  );
}

export function DeliveryReportView({ r, validation }: {
  r: DeliveryReport;
  /** état de validation : commentaire « faits marquants », validé le / par */
  validation?: { status: 'brouillon' | 'valide'; comment: string | null; validated_by_name: string | null; validated_at: string | null } | null;
}) {
  const served = r.by_csb.filter((c) => c.deliveries > 0);
  const notServed = r.by_csb.length - served.length;
  const coverage = r.csb_active ? (100 * r.kpis.csb_served) / r.csb_active : null;
  const stamp = validation?.status === 'valide' && validation.validated_at
    ? <div className="mr-tag mr-tag-ok">Validé le {date(validation.validated_at)}{validation.validated_by_name ? ` par ${validation.validated_by_name}` : ''}</div>
    : r.period.provisional ? null : <div className="mr-tag mr-tag-neutral">Brouillon : non validé</div>;
  return (
    <Sheet title="Rapport mensuel des livraisons" subtitle="Équipe UNFPA · bilan basé sur le poids livré" period={r.period}
      logo={{ src: './logo-unfpa.png', alt: 'UNFPA' }} stamp={stamp}>
      {validation?.comment && (
        <Section title="Faits marquants">
          <p className="mr-comment mr-block">{validation.comment}</p>
        </Section>
      )}
      <Section title="Chiffres clés" note="comparaison avec le mois précédent (M-1) et le même mois l'an passé (N-1)">
        <DeliveryKpiRow k={r.kpis} prev={r.previous} ly={r.last_year} />
      </Section>
      <Section title="Couverture des CSB">
        <div className="mr-kpis mr-block">
          <Kpi label="CSB desservis / CSB actifs" value={`${num(r.kpis.csb_served, 0)} / ${num(r.csb_active, 0)}`} sub={coverage == null ? '' : `${num(coverage, 0)} % de couverture`} />
          <Kpi label="Nouveaux CSB desservis" value={num(r.new_csb, 0)} sub="première livraison ce mois" level={r.new_csb ? 'ok' : undefined} />
          <Kpi label="Cumul depuis janvier" value={kg(r.ytd.kg)} sub={`${num(r.ytd.deliveries, 0)} livraison(s), ${num(r.ytd.csb_served, 0)} CSB`} />
          <Kpi label="Distance parcourue (livraisons)" value={`${num(r.kpis.km, 0)} km`} />
        </div>
      </Section>
      <Section title="Poids livré par jour"><DailyChart days={r.daily} /></Section>
      <Section title="Livraisons par district" note={`${r.by_district.length} district(s) desservi(s)`}>
        <Table rows={r.by_district} empty="Aucune livraison ce mois." cols={[
          { head: 'District', cell: (d) => <strong>{d.district}</strong> },
          { head: 'Région', cell: (d) => d.region },
          { head: 'Poids livré', cell: (d) => kg(d.kg), num: true },
          { head: 'Livraisons', cell: (d) => num(d.deliveries, 0), num: true },
          { head: 'CSB desservis / actifs', cell: (d) => `${num(d.csb_served, 0)} / ${num(d.csb_active, 0)}`, num: true },
        ]} />
      </Section>
      <Section title="Livraisons par CSB" note={`${served.length} CSB desservi(s)${notServed ? `, ${notServed} CSB actif(s) sans livraison ce mois` : ''}`}>
        <Table rows={served} empty="Aucune livraison ce mois." cols={[
          { head: 'CSB', cell: (c) => <><strong>{c.name}</strong>{c.first_time && <> <Tag level="ok">nouveau</Tag></>}</> },
          { head: 'Cat.', cell: (c) => c.category },
          { head: 'District', cell: (c) => c.district ?? '—' },
          { head: 'Drone port', cell: (c) => c.drone_ports ?? '—' },
          { head: 'Poids livré', cell: (c) => kg(c.kg), num: true },
          { head: 'Livraisons', cell: (c) => num(c.deliveries, 0), num: true },
          { head: 'Dernière livraison', cell: (c) => date(c.last_delivery) },
        ]} />
      </Section>
      <div className="mr-grid">
        <Section title="Par drone port">
          <Table rows={r.by_port} cols={[
            { head: 'Drone port', cell: (p) => p.name },
            { head: 'Poids', cell: (p) => kg(p.kg), num: true },
            { head: 'Livr.', cell: (p) => num(p.deliveries, 0), num: true },
            { head: 'CSB', cell: (p) => num(p.csb_served, 0), num: true },
            { head: 'QRF', cell: (p) => num(p.qrf, 0), num: true },
          ]} />
        </Section>
        <Section title="Par organisation">
          <Table rows={r.by_org} empty="Aucune livraison." cols={[
            { head: 'Organisation', cell: (o) => o.organization },
            { head: 'Poids', cell: (o) => kg(o.kg), num: true },
            { head: 'Livraisons', cell: (o) => num(o.deliveries, 0), num: true },
          ]} />
        </Section>
      </div>
      <Section title="Vols interrompus (QRF)" note={`${r.qrf.total} QRF : météo ${r.qrf.by_cause.meteo}, technique ${r.qrf.by_cause.technique}, autre ${r.qrf.by_cause.autre} · ${r.qrf.retried} relancé(s)`}>
        <Bars rows={Object.entries(r.qrf.by_condition).sort((a, b) => b[1] - a[1])
          .map(([k2, v]) => ({ label: LABELS.qrfConditions[k2 as keyof typeof LABELS.qrfConditions] ?? k2, value: v }))} format={(v) => `${num(v, 0)} fois`} />
      </Section>
    </Sheet>
  );
}
