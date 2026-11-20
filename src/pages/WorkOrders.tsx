import { FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { byPort, useApp } from '../lib/app';
import { useData } from '../lib/useData';
import type { Drone, WorkOrderKind, WorkOrderPriority, WorkOrderRow, WorkOrderStatus } from '../lib/types';
import { date, today, toStr } from '../lib/format';
import { daysBetween, iso } from '../lib/stats';
import { WO_KIND, WO_PRIORITY, WO_STATUS } from '../lib/workOrders';
import { Empty, ErrorBox, Field, Loading, Modal, PageHeader } from '../components/ui';
import { Icon } from '../components/icons';
import { ChoiceCards, FormSection } from '../components/FormKit';

/** Création d'un ordre de travail */
export function NewWorkOrderModal({ drones, defaultDrone, onClose, onCreated }: {
  drones: Pick<Drone, 'id' | 'code'>[]; defaultDrone?: string; onClose: () => void; onCreated: (id: string) => void;
}) {
  const [f, setF] = useState({ drone_id: defaultDrone ?? drones[0]?.id ?? '', title: '', kind: 'corrective' as WorkOrderKind, priority: 'normale' as WorkOrderPriority, due_date: '', description: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((c) => ({ ...c, [k]: v }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const row = unwrap(await supabase.from('work_orders').insert({
        drone_id: f.drone_id, title: f.title.trim(), kind: f.kind, priority: f.priority, due_date: toStr(f.due_date), description: toStr(f.description),
      }).select('id').single()) as { id: string };
      onCreated(row.id);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); setBusy(false); }
  }
  return (
    <Modal title="Nouvel ordre de travail" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Annuler</button><button className="btn btn-primary" form="wo-form" disabled={busy || !f.drone_id}>{busy ? 'Création…' : 'Ouvrir l\'OT'}</button></>}>
      <form id="wo-form" className="bm-form fk-form" onSubmit={submit}>
        <FormSection n={1} icon="drone" title="Drone">
          <div className="bm-packs">
            {drones.map((d) => <button key={d.id} type="button" className={`bm-pack${f.drone_id === d.id ? ' active' : ''}`} onClick={() => set('drone_id', d.id)}><strong>{d.code}</strong></button>)}
          </div>
        </FormSection>
        <FormSection n={2} icon="wrench" title="Intervention">
          <Field label="Titre" required><input required value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="ex. Remplacement hélice VTOL avant gauche" /></Field>
          <ChoiceCards label="Nature" value={f.kind} onChange={(v) => set('kind', v)} cols={5} options={[
            { value: 'visite', label: 'Visite', icon: 'shield', tone: 'ok' },
            { value: 'corrective', label: 'Corrective', icon: 'wrench', tone: 'warn' },
            { value: 'remplacement', label: 'Remplacement', icon: 'chip', tone: 'info' },
            { value: 'inspection', label: 'Inspection', icon: 'search', tone: 'info' },
            { value: 'autre', label: 'Autre', icon: 'box', tone: 'neutral' },
          ]} />
          <div className="form-grid">
            <div className="field"><span className="field-label">Priorité</span>
              <div className="segmented segmented-sm">
                {(Object.keys(WO_PRIORITY) as WorkOrderPriority[]).map((p) => <button key={p} type="button" className={`${f.priority === p ? 'active' : ''}${p === 'urgente' ? ' is-danger' : ''}`} onClick={() => set('priority', p)}>{WO_PRIORITY[p]}</button>)}
              </div></div>
            <Field label="Échéance"><input type="date" min={today()} value={f.due_date} onChange={(e) => set('due_date', e.target.value)} /></Field>
          </div>
          <Field label="Description / constat" wide><textarea rows={3} value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="Ce qui motive l'intervention…" /></Field>
        </FormSection>
        <ErrorBox error={error} />
      </form>
    </Modal>
  );
}

const COLUMNS: WorkOrderStatus[] = ['ouvert', 'en_cours', 'termine', 'cloture'];

export default function WorkOrders() {
  const { portFilter } = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [drone, setDrone] = useState(params.get('drone') ?? '');
  const [creating, setCreating] = useState(params.get('nouveau') === '1');
  const todayIso = iso(new Date());

  const { data, error, loading } = useData(async () => {
    const [wo, dr] = await Promise.all([
      byPort(supabase.from('v_work_orders').select('*'), portFilter).order('opened_at', { ascending: false }).limit(500),
      byPort(supabase.from('drones').select('id, code'), portFilter).neq('status', 'retire').order('code'),
    ]);
    return { orders: unwrap(wo) as WorkOrderRow[], drones: unwrap(dr) as { id: string; code: string }[] };
  }, [portFilter]);

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const rows = data.orders.filter((o) => !drone || o.drone_id === drone);
  const late = rows.filter((o) => o.status !== 'cloture' && o.due_date && o.due_date < todayIso);
  const closed30 = rows.filter((o) => o.status === 'cloture' && o.signed_at && daysBetween(o.signed_at.slice(0, 10), todayIso) <= 30);

  return (
    <div className="wo-page">
      <PageHeader title="Ordres de travail" subtitle="Chaque intervention regroupe visites, comptes rendus et pièces, puis est signée par le responsable maintenance"
        actions={<button className="btn btn-primary" onClick={() => setCreating(true)} disabled={!data.drones.length}>+ Nouvel OT</button>} />

      <div className="flight-kpis pl-kpis">
        <div className="fk"><span className="fk-icon"><Icon name="wrench" size={18} /></span><div><strong>{rows.filter((o) => o.status === 'ouvert' || o.status === 'en_cours').length}</strong><span>en cours ou ouvert(s)</span></div></div>
        <div className={`fk${rows.some((o) => o.status === 'termine') ? ' fk-warn' : ''}`}><span className="fk-icon"><Icon name="pen" size={18} /></span><div><strong>{rows.filter((o) => o.status === 'termine').length}</strong><span>terminé(s) · signature attendue</span></div></div>
        <div className={`fk${late.length ? ' fk-danger' : ' fk-ok'}`}><span className="fk-icon"><Icon name="clock" size={18} /></span><div><strong>{late.length}</strong><span>en retard sur l'échéance</span></div></div>
        <div className="fk fk-ok"><span className="fk-icon"><Icon name="shield" size={18} /></span><div><strong>{closed30.length}</strong><span>clôturé(s) sur 30 jours</span></div></div>
      </div>

      <div className="card filters pl-filters">
        <div className="field pl-sort"><span className="field-label">Drone</span>
          <div className="segmented segmented-sm">
            <button type="button" className={!drone ? 'active' : ''} onClick={() => setDrone('')}>Tous</button>
            {data.drones.map((d) => <button key={d.id} type="button" className={drone === d.id ? 'active' : ''} onClick={() => setDrone(d.id)}>{d.code}</button>)}
          </div></div>
      </div>

      {rows.length === 0 ? <Empty>Aucun ordre de travail. Ouvrez-en un pour tracer une intervention de maintenance.</Empty> : (
        <div className="board wo-board">
          {COLUMNS.map((st) => {
            const items = rows.filter((o) => o.status === st).slice(0, st === 'cloture' ? 12 : 100);
            return (
              <section key={st} className={`board-col wo-col st-${st}`}>
                <header><span className={`wo-dot st-${st}`} /> {WO_STATUS[st].label} <b>{rows.filter((o) => o.status === st).length}</b></header>
                <div className="board-items">
                  {items.length === 0 && <span className="small muted board-empty">—</span>}
                  {items.map((o) => {
                    const isLate = o.status !== 'cloture' && o.due_date && o.due_date < todayIso;
                    return (
                      <Link key={o.id} to={`/ordres-travail/${o.id}`} className={`wo-card pr-${o.priority}${isLate ? ' is-late' : ''}`}>
                        <div className="wo-card-top"><span className="mono wo-num">{o.number}</span><span className="wo-drone">{o.drone_code}</span></div>
                        <strong>{o.title}</strong>
                        <div className="wo-card-meta">
                          <span className="wo-kind">{WO_KIND[o.kind]}</span>
                          {o.priority !== 'normale' && <span className={`wo-prio pr-${o.priority}`}>{WO_PRIORITY[o.priority]}</span>}
                          {o.link_count > 0 && <span>🔗 {o.link_count}</span>}
                        </div>
                        <div className="wo-card-foot small muted">
                          <span>{o.status === 'cloture' ? `signé par ${o.signed_by_name ?? '—'}` : `ouvert le ${date(o.opened_at.slice(0, 10))}`}</span>
                          {o.due_date && o.status !== 'cloture' && <span className={isLate ? 'text-danger' : ''}>échéance {date(o.due_date)}</span>}
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {creating && (
        <NewWorkOrderModal drones={data.drones} defaultDrone={drone || params.get('drone') || undefined}
          onClose={() => { setCreating(false); if (params.get('nouveau')) { params.delete('nouveau'); setParams(params, { replace: true }); } }}
          onCreated={(id) => navigate(`/ordres-travail/${id}`)} />
      )}
    </div>
  );
}
