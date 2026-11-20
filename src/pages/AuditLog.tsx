import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { useApp } from '../lib/app';
import { useData } from '../lib/useData';
import { addDays, download, iso, toCsv } from '../lib/stats';
import { Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { Icon } from '../components/icons';
import { LABELS } from '../lib/format';
import { PART_STATUS } from '../lib/parts';
import { WO_KIND, WO_PRIORITY, WO_STATUS } from '../lib/workOrders';

interface AuditRow {
  id: number; at: string; user_id: string | null; actor: string | null; table_name: string; record_id: string | null;
  label: string | null; action: 'INSERT' | 'UPDATE' | 'DELETE'; changes: Record<string, { old?: unknown; new?: unknown }> | null; drone_port_id: string | null;
}

export const AUDIT_TABLES: Record<string, string> = {
  flights: 'Vol', flight_pilots: 'Équipage de vol', technical_reports: 'Compte rendu', crm_signatures: 'Visa CRM', maintenance_visits: 'Visite',
  drones: 'Drone', pilots: 'Pilote', profiles: 'Compte', drone_ports: 'Drone port', health_facilities: 'CSB',
  batteries: 'Batterie', battery_packs: 'Pack', battery_capacity_tests: 'Relevé de capacité',
  parts: 'Pièce', part_types: 'Type de pièce', part_stock_thresholds: 'Seuil de stock',
  work_orders: 'Ordre de travail', work_order_links: 'Élément d\'OT',
};
const FIELDS: Record<string, string> = {
  status: 'Statut', phone: 'Téléphone', full_name: 'Nom', name: 'Nom', code: 'Code', drone_port_id: 'Drone port', active: 'Actif', notes: 'Notes',
  description: 'Description / constat', corrective_action: 'Mesure corrective', severity: 'Gravité', report_type: 'Type', component: 'Composant',
  role: 'Rôle', pilot_id: 'Fiche pilote', flight_date: 'Date', takeoff_time: 'Décollage', landing_time: 'Atterrissage', drop_time: 'Largage',
  consumption_mah: 'Consommation (mAh)', payload_kg: 'Charge (kg)', destination_id: 'Destination', distance_km: 'Distance (km)', qrf: 'QRF',
  observation: 'Observation', work_done: 'Travaux réalisés', title: 'Titre', kind: 'Nature', priority: 'Priorité', due_date: 'Échéance',
  visit_type: 'Type de visite', visit_date: 'Date de visite', hours_at_visit: 'Compteur (h)', technician: 'Technicien',
  serial_number: 'N° de série', license_number: 'Licence', initial_flight_minutes: 'Minutes antérieures', initial_hours: 'Heures antérieures',
  max_hours: 'Potentiel (h)', default_max_hours: 'Potentiel du type (h)', min_qty: 'Minimum', max_cycles: 'Cycles max', initial_cycles: 'Cycles initiaux',
  capacity_mah: 'Capacité (mAh)', measured_mah: 'Capacité mesurée', pack_id: 'Pack', position: 'Position', latitude: 'Latitude', longitude: 'Longitude',
  category: 'Catégorie', signer_name: 'Signataire', resolved_on: 'Résolu le', resolved_by_name: 'Clôturé par', visit_interval_hours: 'Intervalle visite (h)',
  model: 'Modèle', manufacturer: 'Fabricant', voltage_start_v: 'Tension départ', voltage_end_v: 'Tension arrivée', closed_at: 'Clôturé le',
  signed_by_name: 'Signé par', signed_at: 'Signé le', battery_pack_id: 'Pack', drone_id: 'Drone', flight_type: 'Type de vol', organization: 'Organisation',
};
/** Libellés des valeurs codées, par champ (et par table pour « status » et « kind ») */
const VALUES: Record<string, Record<string, string>> = {
  severity: LABELS.severity, report_type: LABELS.reportType, visit_type: LABELS.visitType, priority: WO_PRIORITY, role: LABELS.role,
  flight_type: LABELS.flightType as Record<string, string>,
  'work_orders.status': Object.fromEntries(Object.entries(WO_STATUS).map(([k, v]) => [k, v.label])), 'work_orders.kind': WO_KIND,
  'work_order_links.kind': { visite: 'Visite', rapport: 'Compte rendu', piece: 'Pièce' },
  'technical_reports.status': LABELS.reportStatus, 'drones.status': LABELS.droneStatus, 'batteries.status': LABELS.batteryStatus, 'battery_packs.status': LABELS.batteryStatus,
  'parts.status': Object.fromEntries(Object.entries(PART_STATUS).map(([k, v]) => [k, v.label])), 'flights.status': { ouvert: 'Ouvert', cloture: 'Clôturé' },
  'crm_signatures.kind': { pilote: 'Commandant de bord', copilote: 'Copilote', rapports: 'Mesures correctives' },
};
const HIDDEN = new Set(['id', 'user_id', 'created_by', 'closed_by', 'opened_by', 'signed_by', 'resolved_by', 'work_order_id']);
const ACTION: Record<AuditRow['action'], { label: string; cls: string; icon: string }> = {
  INSERT: { label: 'Création', cls: 'ins', icon: '＋' }, UPDATE: { label: 'Modification', cls: 'upd', icon: '✎' }, DELETE: { label: 'Suppression', cls: 'del', icon: '✕' },
};
const LINKS: Record<string, string> = { flights: '/vols/', drones: '/drones/', parts: '/pieces/', batteries: '/batteries/', work_orders: '/ordres-travail/', pilots: '/carnet/' };
const isUuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v);

export default function AuditLog() {
  const { ports } = useApp();
  const todayIso = iso(new Date());
  const [from, setFrom] = useState(addDays(todayIso, -6));
  const [to, setTo] = useState(todayIso);
  const [table, setTable] = useState('');
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [q, setQ] = useState('');

  const { data, error, loading } = useData(async () => {
    let query = supabase.from('audit_log').select('*').gte('at', `${from}T00:00:00`).lt('at', `${addDays(to, 1)}T00:00:00`).order('id', { ascending: false }).limit(1000);
    if (table) query = query.eq('table_name', table);
    if (action) query = query.eq('action', action);
    return unwrap(await query) as AuditRow[];
  }, [from, to, table, action]);

  const portName = (id: unknown) => ports.find((p) => p.id === id)?.name;
  const fmt = (k: string, v: unknown, t = ''): string => {
    if (v === null || v === undefined || v === '') return '—';
    const dict = VALUES[`${t}.${k}`] ?? VALUES[k];
    if (dict && typeof v === 'string' && dict[v]) return dict[v];
    if (typeof v === 'boolean') return v ? 'Oui' : 'Non';
    if (k === 'drone_port_id' && portName(v)) return portName(v)!;
    if (isUuid(v)) return `#${String(v).slice(0, 8)}`;
    if (Array.isArray(v)) return v.join(', ') || '—';
    if (typeof v === 'object') return JSON.stringify(v);
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.split('-').reverse().join('/');
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return new Date(s).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  };

  const rows = useMemo(() => (data ?? []).filter((r) => (!actor || (r.actor ?? 'Système') === actor)
    && (!q || `${r.label ?? ''} ${r.actor ?? ''} ${JSON.stringify(r.changes ?? {})}`.toLowerCase().includes(q.toLowerCase()))), [data, actor, q]);
  const actors = Array.from(new Set((data ?? []).map((r) => r.actor ?? 'Système'))).sort();
  const days: { day: string; items: AuditRow[] }[] = [];
  for (const r of rows) {
    const day = iso(new Date(r.at));
    const last = days[days.length - 1];
    if (last?.day === day) last.items.push(r); else days.push({ day, items: [r] });
  }

  function exportCsv() {
    download(`journal_audit_${from}_${to}.csv`, toCsv(rows.map((r) => ({
      date: new Date(r.at).toLocaleString('fr-FR'), auteur: r.actor ?? 'Système', action: ACTION[r.action].label,
      element: AUDIT_TABLES[r.table_name] ?? r.table_name, libelle: r.label ?? '',
      details: Object.entries(r.changes ?? {}).filter(([k]) => !HIDDEN.has(k)).map(([k, c]) => `${FIELDS[k] ?? k}: ${fmt(k, c.old)} → ${fmt(k, c.new)}`).join(' | '),
    }))));
  }

  const all = data ?? [];
  return (
    <div className="audit-page">
      <PageHeader title="Journal d'audit" subtitle="Toutes les créations, modifications et suppressions, avec leur auteur et le détail des champs"
        actions={<button className="btn" onClick={exportCsv} disabled={!rows.length}>⇩ CSV</button>} />

      <div className="flight-kpis pl-kpis">
        <div className="fk"><span className="fk-icon"><Icon name="book" size={18} /></span><div><strong>{all.length}{all.length >= 1000 ? '+' : ''}</strong><span>opération(s) sur la période</span></div></div>
        <div className="fk"><span className="fk-icon"><Icon name="plus" size={18} /></span><div><strong>{all.filter((r) => r.action === 'INSERT').length}</strong><span>créations</span></div></div>
        <div className="fk"><span className="fk-icon"><Icon name="pen" size={18} /></span><div><strong>{all.filter((r) => r.action === 'UPDATE').length}</strong><span>modifications</span></div></div>
        <div className={`fk${all.some((r) => r.action === 'DELETE') ? ' fk-warn' : ''}`}><span className="fk-icon"><Icon name="alert" size={18} /></span><div><strong>{all.filter((r) => r.action === 'DELETE').length}</strong><span>suppressions</span></div></div>
        <div className="fk"><span className="fk-icon"><Icon name="users" size={18} /></span><div><strong>{actors.length}</strong><span>auteur(s)</span></div></div>
      </div>

      <div className="card filters">
        <label className="field"><span className="field-label">Du</span><input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label className="field"><span className="field-label">Au</span><input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
        <label className="field"><span className="field-label">Élément</span>
          <select value={table} onChange={(e) => setTable(e.target.value)}>
            <option value="">Tous</option>
            {Object.entries(AUDIT_TABLES).sort((a, b) => a[1].localeCompare(b[1])).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select></label>
        <label className="field"><span className="field-label">Action</span>
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">Toutes</option>
            {Object.entries(ACTION).map(([k, a]) => <option key={k} value={k}>{a.label}</option>)}
          </select></label>
        <label className="field"><span className="field-label">Auteur</span>
          <select value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">Tous</option>
            {actors.map((a) => <option key={a} value={a}>{a}</option>)}
          </select></label>
        <label className="field field-grow"><span className="field-label">Recherche</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Libellé, valeur, auteur…" /></label>
      </div>

      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : rows.length === 0 ? <Empty>Aucune opération pour ces critères.</Empty> : (
        <div className="audit-days">
          {days.map((g) => (
            <section key={g.day} className="audit-day">
              <h2>{new Date(`${g.day}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}<span> · {g.items.length} opération(s)</span></h2>
              <ol className="audit-list">
                {g.items.map((r) => {
                  const a = ACTION[r.action];
                  const changes = Object.entries(r.changes ?? {}).filter(([k]) => !HIDDEN.has(k));
                  const link = LINKS[r.table_name] && r.record_id && r.action !== 'DELETE' ? `${LINKS[r.table_name]}${r.record_id}` : null;
                  const shown = r.action === 'UPDATE' ? changes : changes.slice(0, 0);
                  return (
                    <li key={r.id} className={`audit-item act-${a.cls}`}>
                      <time>{new Date(r.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                      <span className="audit-dot" aria-hidden>{a.icon}</span>
                      <div className="audit-body">
                        <div className="audit-head">
                          <span className={`audit-act act-${a.cls}`}>{a.label}</span>
                          <span className="audit-table">{AUDIT_TABLES[r.table_name] ?? r.table_name}</span>
                          {link ? <Link to={link}><strong>{fmt('kind', r.label, r.table_name)}</strong></Link> : <strong>{r.label ? fmt('kind', r.label, r.table_name) : '—'}</strong>}
                          <span className="audit-actor"><Icon name="users" size={12} /> {r.actor ?? 'Système'}</span>
                        </div>
                        {shown.length > 0 && (
                          <ul className="audit-changes">
                            {shown.map(([k, c]) => (
                              <li key={k}><b>{FIELDS[k] ?? k}</b><span className="audit-old">{fmt(k, c.old, r.table_name)}</span><span className="audit-arrow">→</span><span className="audit-new">{fmt(k, c.new, r.table_name)}</span></li>
                            ))}
                          </ul>
                        )}
                        {r.action !== 'UPDATE' && changes.length > 0 && (
                          <details className="audit-details">
                            <summary>{changes.length} champ(s) {r.action === 'INSERT' ? 'renseigné(s)' : 'supprimé(s)'}</summary>
                            <ul className="audit-changes">
                              {changes.map(([k, c]) => <li key={k}><b>{FIELDS[k] ?? k}</b><span className={r.action === 'INSERT' ? 'audit-new' : 'audit-old'}>{fmt(k, r.action === 'INSERT' ? c.new : c.old, r.table_name)}</span></li>)}
                            </ul>
                          </details>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
      {(data?.length ?? 0) >= 1000 && <p className="small muted">Seules les 1 000 dernières opérations sont affichées : réduisez la période ou filtrez.</p>}
    </div>
  );
}
