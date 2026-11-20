import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { useApp } from '../lib/app';
import { useData } from '../lib/useData';
import type { MaintenanceVisit, PartEventRow, ReportRow, WorkOrderKind, WorkOrderLink, WorkOrderPriority, WorkOrderRow, WorkOrderStatus } from '../lib/types';
import { date, hours, LABELS, toStr } from '../lib/format';
import { dateTime, PART_EVENT } from '../lib/parts';
import { WO_KIND, WO_PRIORITY, WO_STATUS, WO_STEPS } from '../lib/workOrders';
import { Badge, ErrorBox, Loading, Modal, PageHeader } from '../components/ui';
import { Icon } from '../components/icons';
import UavLogo from '../components/UavLogo';

type Item = { kind: WorkOrderLink['kind']; id: string; at: string; title: string; sub: string; level?: 'ok' | 'warn' | 'danger' | 'neutral' };

export default function WorkOrderDetail() {
  const { id } = useParams() as { id: string };
  const navigate = useNavigate();
  const { isAdmin, myPort, pilot } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [signing, setSigning] = useState(false);
  const [form, setForm] = useState<{ title: string; kind: WorkOrderKind; priority: WorkOrderPriority; due_date: string; description: string; work_done: string } | null>(null);

  const { data, error: loadError, loading, reload } = useData(async () => {
    const wo = unwrap(await supabase.from('v_work_orders').select('*').eq('id', id).single()) as WorkOrderRow;
    const [links, allLinks, visits, reports, events] = await Promise.all([
      supabase.from('work_order_links').select('*').eq('work_order_id', id).order('created_at'),
      supabase.from('work_order_links').select('kind, ref_id').limit(10000),
      supabase.from('maintenance_visits').select('*').eq('drone_id', wo.drone_id).order('visit_date', { ascending: false }).limit(200),
      supabase.from('v_reports').select('*').eq('drone_id', wo.drone_id).order('created_at', { ascending: false }).limit(200),
      supabase.from('v_part_events').select('*').eq('drone_id', wo.drone_id).in('event_type', ['montage', 'demontage', 'quarantaine']).order('at', { ascending: false }).limit(300),
    ]);
    return {
      wo, links: unwrap(links) as WorkOrderLink[], taken: new Set((unwrap(allLinks) as { kind: string; ref_id: string }[]).map((l) => `${l.kind}|${l.ref_id}`)),
      visits: unwrap(visits) as MaintenanceVisit[], reports: unwrap(reports) as ReportRow[], events: unwrap(events) as PartEventRow[],
    };
  }, [id]);

  useEffect(() => {
    if (data) setForm({ title: data.wo.title, kind: data.wo.kind, priority: data.wo.priority, due_date: data.wo.due_date ?? '', description: data.wo.description ?? '', work_done: data.wo.work_done ?? '' });
  }, [data]);

  if (loading && !data) return <Loading />;
  if (!data || !form) return <ErrorBox error={loadError} />;
  const { wo } = data;
  const closed = wo.status === 'cloture';
  const canEdit = (isAdmin || myPort?.id === wo.drone_port_id) && (!closed || isAdmin);
  // signature : administrateur, ou responsable maintenance (qualification de la fiche pilote) du drone port
  const canSign = wo.status === 'termine' && (isAdmin || (myPort?.id === wo.drone_port_id && !!pilot?.maintenance_lead && pilot.active));
  const dirty = form.title !== wo.title || form.kind !== wo.kind || form.priority !== wo.priority || form.due_date !== (wo.due_date ?? '')
    || form.description !== (wo.description ?? '') || form.work_done !== (wo.work_done ?? '');

  // ---- éléments (rattachés ou candidats)
  const toItem = {
    visite: (v: MaintenanceVisit): Item => ({ kind: 'visite', id: v.id, at: v.visit_date, title: `${LABELS.visitType[v.visit_type]} · ${hours(v.hours_at_visit)}`, sub: [v.technician, v.work_done].filter(Boolean).join(' · ') || '—' }),
    rapport: (r: ReportRow): Item => ({ kind: 'rapport', id: r.id, at: r.created_at, title: `${LABELS.reportType[r.report_type]}${r.component ? ` · ${r.component}` : ''}`,
      sub: `${r.description}${r.corrective_action ? ` → ${r.corrective_action}` : ''}`, level: r.status === 'clos' ? 'ok' : r.severity === 'critique' ? 'danger' : 'warn' }),
    piece: (e: PartEventRow): Item => ({ kind: 'piece', id: e.id, at: e.at, title: `${PART_EVENT[e.event_type].label} · ${e.part_code}`, sub: [e.type_name, e.slot, e.reason].filter(Boolean).join(' · '),
      level: e.event_type === 'quarantaine' ? 'danger' : 'neutral' }),
  };
  const linkedIds = new Set(data.links.map((l) => `${l.kind}|${l.ref_id}`));
  const all: Item[] = [...data.visits.map(toItem.visite), ...data.reports.map(toItem.rapport), ...data.events.map(toItem.piece)];
  const linked = all.filter((i) => linkedIds.has(`${i.kind}|${i.id}`)).sort((a, b) => a.at.localeCompare(b.at));
  const candidates = all.filter((i) => !data.taken.has(`${i.kind}|${i.id}`)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60);
  const GROUPS: { kind: Item['kind']; label: string; icon: 'wrench' | 'alert' | 'chip' }[] = [
    { kind: 'visite', label: 'Visites', icon: 'wrench' }, { kind: 'rapport', label: 'Comptes rendus', icon: 'alert' }, { kind: 'piece', label: 'Pièces', icon: 'chip' },
  ];
  const fmtAt = (i: Item) => (i.kind === 'visite' ? date(i.at) : i.kind === 'piece' ? dateTime(i.at) : new Date(i.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }));

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); await reload(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const save = () => run(async () => unwrap(await supabase.from('work_orders').update({
    title: form.title.trim(), kind: form.kind, priority: form.priority, due_date: toStr(form.due_date), description: toStr(form.description), work_done: toStr(form.work_done),
  }).eq('id', id).select()));
  const setStatus = (s: WorkOrderStatus) => run(async () => {
    if (dirty) unwrap(await supabase.from('work_orders').update({ title: form.title.trim(), kind: form.kind, priority: form.priority, due_date: toStr(form.due_date), description: toStr(form.description), work_done: toStr(form.work_done) }).eq('id', id).select());
    unwrap(await supabase.from('work_orders').update({ status: s }).eq('id', id).select());
  });
  const attach = () => run(async () => {
    unwrap(await supabase.from('work_order_links').insert([...sel].map((k) => { const [kind, ref_id] = k.split('|'); return { work_order_id: id, kind, ref_id }; })));
    setSel(new Set()); setPicking(false);
  });
  const detach = (i: Item) => run(async () => {
    const l = data.links.find((x) => x.kind === i.kind && x.ref_id === i.id);
    if (l) unwrap(await supabase.from('work_order_links').delete().eq('id', l.id));
  });
  const remove = () => {
    if (!window.confirm(`Supprimer l'ordre de travail ${wo.number} ? Les éléments rattachés ne sont pas supprimés.`)) return;
    run(async () => { unwrap(await supabase.from('work_orders').delete().eq('id', id)); navigate('/ordres-travail'); });
  };
  const step = WO_STEPS.indexOf(wo.status);

  return (
    <div className="history-page hp-doc wo-detail">
      {/* ===== document imprimé ===== */}
      <header className="doc-head print-only">
        <UavLogo className="doc-logo doc-logo-uav" width="56mm" />
        <div className="doc-title">
          <div className="doc-org">UNFPA Madagascar · Livraison par drones</div>
          <h1>Ordre de travail</h1>
          <div className="doc-sub">Drone <strong>{wo.drone_code}</strong> · {wo.drone_port_name ?? '—'} · {WO_KIND[wo.kind]}</div>
        </div>
        <dl className="doc-ref">
          <div><dt>N° OT</dt><dd>{wo.number}</dd></div>
          <div><dt>Statut</dt><dd>{WO_STATUS[wo.status].label}</dd></div>
          <div><dt>Ouvert le</dt><dd>{date(wo.opened_at.slice(0, 10))}</dd></div>
          <div><dt>Édité le</dt><dd>{new Date().toLocaleDateString('fr-FR')}</dd></div>
        </dl>
      </header>
      <div className="hp print-only">
        <section className="hp-block">
          <h2 className="hp-h"><span>1</span> Intervention</h2>
          <table className="hp-id"><tbody>
            <tr><th>Titre</th><td colSpan={5} className="hp-strong">{wo.title}</td></tr>
            <tr><th>Drone</th><td className="hp-big">{wo.drone_code}</td><th>Nature</th><td>{WO_KIND[wo.kind]}</td><th>Priorité</th><td>{WO_PRIORITY[wo.priority]}</td></tr>
            <tr><th>Compteur à l'ouverture</th><td>{wo.hours_at_opening != null ? hours(wo.hours_at_opening) : '—'}</td><th>Ouvert par</th><td>{wo.opened_by_name ?? '—'}</td><th>Échéance</th><td>{wo.due_date ? date(wo.due_date) : '—'}</td></tr>
          </tbody></table>
          {wo.description && <p className="wo-print-text"><b>Description / constat :</b> {wo.description}</p>}
        </section>
        <section className="hp-block">
          <h2 className="hp-h"><span>2</span> Éléments rattachés ({linked.length})</h2>
          {linked.length === 0 ? <p className="hp-ok">Aucun élément rattaché.</p> : (
            <table className="hp-table"><thead><tr><th>Date</th><th>Type</th><th>Élément</th><th>Détail</th></tr></thead>
              <tbody>{linked.map((i) => <tr key={`${i.kind}${i.id}`}><td className="nowrap">{fmtAt(i)}</td><td>{GROUPS.find((g) => g.kind === i.kind)!.label}</td><td><strong>{i.title}</strong></td><td>{i.sub}</td></tr>)}</tbody>
            </table>
          )}
        </section>
        <section className="hp-block">
          <h2 className="hp-h"><span>3</span> Travaux réalisés</h2>
          <p className="wo-print-text wo-print-box">{wo.work_done || '—'}</p>
        </section>
        <section className="hp-block hp-visas">
          <h2 className="hp-h"><span>4</span> Visa du responsable maintenance</h2>
          <div className="hp-signs">
            <div className="hp-sign">
              <span>Responsable maintenance</span>
              <div>Nom : <b>{wo.signed_by_name ?? ''}</b></div>
              <div>Date : <b>{wo.signed_at ? new Date(wo.signed_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : ''}</b></div>
              <div className="hp-sign-area">{wo.signed_by_name ? <span className="crm-signature">{wo.signed_by_name}</span> : 'Signature'}</div>
            </div>
            <div className="hp-sign">
              <span>Établi par</span>
              <div>Nom : <b>{wo.opened_by_name ?? ''}</b></div>
              <div>Date : <b>{date(wo.opened_at.slice(0, 10))}</b></div>
              <div className="hp-sign-area">Signature</div>
            </div>
          </div>
        </section>
      </div>

      {/* ===== écran ===== */}
      <PageHeader
        title={<span className="wo-title"><span className="mono">{wo.number}</span> {wo.title}</span>}
        subtitle={<><Link to={`/drones/${wo.drone_id}`}>{wo.drone_code}</Link> · {wo.drone_port_name ?? '—'} · ouvert le {date(wo.opened_at.slice(0, 10))} par {wo.opened_by_name ?? '—'}{wo.hours_at_opening != null ? ` · compteur ${hours(wo.hours_at_opening)}` : ''}</>}
        actions={<>
          <Link className="btn" to="/ordres-travail">← Ordres de travail</Link>
          <button className="btn" onClick={() => window.print()}>⎙ Imprimer</button>
          {canEdit && <button className="btn btn-ghost" onClick={remove} disabled={busy}>Supprimer</button>}
        </>} />
      <ErrorBox error={error} />

      <section className="card wo-steps no-print">
        <ol className="wo-stepper">
          {WO_STEPS.map((s, i) => (
            <li key={s} className={`${i < step ? 'done' : ''}${i === step ? ' current' : ''}`}><span>{i < step || (s === 'cloture' && closed) ? '✓' : i + 1}</span>{WO_STATUS[s].label}</li>
          ))}
        </ol>
        <div className="wo-step-actions">
          {canEdit && wo.status === 'ouvert' && <button className="btn btn-primary" onClick={() => setStatus('en_cours')} disabled={busy}>▶ Démarrer l'intervention</button>}
          {canEdit && wo.status === 'en_cours' && <>
            <button className="btn" onClick={() => setStatus('ouvert')} disabled={busy}>← Ouvert</button>
            <button className="btn btn-primary" onClick={() => setStatus('termine')} disabled={busy || !form.work_done.trim()} title={form.work_done.trim() ? '' : 'Décrivez les travaux réalisés'}>✓ Travaux terminés</button>
          </>}
          {canEdit && wo.status === 'termine' && <button className="btn" onClick={() => setStatus('en_cours')} disabled={busy}>← Reprendre</button>}
          {canSign && <button className="btn btn-primary" onClick={() => setSigning(true)} disabled={busy}><Icon name="pen" size={15} /> Signer et clôturer</button>}
          {closed && isAdmin && <button className="btn" onClick={() => window.confirm('Rouvrir cet OT ? La signature sera annulée.') && run(async () => unwrap(await supabase.rpc('reopen_work_order', { p_id: id })))} disabled={busy}>Rouvrir (admin)</button>}
        </div>
      </section>

      <div className="wo-grid no-print">
        <section className="card wo-info">
          <h2 className="card-title">Intervention</h2>
          <label className="field"><span className="field-label">Titre</span><input value={form.title} disabled={!canEdit || closed} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
          <div className="form-grid">
            <label className="field"><span className="field-label">Nature</span>
              <select value={form.kind} disabled={!canEdit || closed} onChange={(e) => setForm({ ...form, kind: e.target.value as WorkOrderKind })}>
                {Object.entries(WO_KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select></label>
            <label className="field"><span className="field-label">Priorité</span>
              <select value={form.priority} disabled={!canEdit || closed} onChange={(e) => setForm({ ...form, priority: e.target.value as WorkOrderPriority })}>
                {Object.entries(WO_PRIORITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select></label>
            <label className="field"><span className="field-label">Échéance</span><input type="date" value={form.due_date} disabled={!canEdit || closed} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></label>
          </div>
          <label className="field"><span className="field-label">Description / constat</span>
            <textarea rows={3} value={form.description} disabled={!canEdit || closed} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <label className="field"><span className="field-label">Travaux réalisés {wo.status !== 'ouvert' && !closed && <span className="req">*</span>}</span>
            <textarea rows={5} value={form.work_done} disabled={!canEdit || closed} onChange={(e) => setForm({ ...form, work_done: e.target.value })}
              placeholder="Opérations effectuées, pièces remplacées, essais, résultat…" /></label>
          {canEdit && !closed && <div className="wo-save"><button className="btn btn-primary btn-sm" onClick={save} disabled={busy || !dirty || !form.title.trim()}>Enregistrer</button>{dirty && <span className="small text-warn">modifications non enregistrées</span>}</div>}
        </section>

        <section className="card wo-sign">
          <h2 className="card-title">Visa du responsable maintenance</h2>
          {closed ? (
            <div className="crm-sign-area is-signed">
              <span className="crm-signature">{wo.signed_by_name}</span>
              <span className="crm-sign-meta">Signé électroniquement le {new Date(wo.signed_at!).toLocaleDateString('fr-FR')} à {new Date(wo.signed_at!).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          ) : (
            <div className="wo-sign-wait">
              <Icon name="pen" size={20} />
              <span>{wo.status === 'termine' ? `En attente de la signature d'un responsable maintenance de ${wo.drone_port_name ?? 'ce drone port'} (ou d'un administrateur).` : 'La signature sera possible quand les travaux seront marqués « terminés ».'}</span>
            </div>
          )}
          <p className="small muted">Une fois signé, l'OT est clôturé : seul un administrateur peut le rouvrir.</p>
        </section>
      </div>

      <section className="card wo-items no-print">
        <div className="row-between">
          <h2 className="card-title">Éléments rattachés <span className="muted">· {linked.length}</span></h2>
          {canEdit && !closed && <button className="btn btn-sm" onClick={() => setPicking(!picking)}>{picking ? 'Fermer' : '🔗 Rattacher des éléments'}</button>}
        </div>
        {picking && (
          <div className="wo-picker">
            <p className="small muted">Éléments de {wo.drone_code} non encore rattachés à un OT (60 plus récents).</p>
            {candidates.length === 0 ? <p className="small muted">Aucun élément disponible.</p> : (
              <ul className="wo-cand">
                {candidates.map((i) => {
                  const k = `${i.kind}|${i.id}`;
                  const g = GROUPS.find((x) => x.kind === i.kind)!;
                  return (
                    <li key={k}><label>
                      <input type="checkbox" checked={sel.has(k)} onChange={() => { const s = new Set(sel); if (s.has(k)) s.delete(k); else s.add(k); setSel(s); }} />
                      <span className={`wo-ik k-${i.kind}`}><Icon name={g.icon} size={12} /> {g.label}</span>
                      <span className="nowrap small muted">{fmtAt(i)}</span>
                      <span className="wo-cand-main"><strong>{i.title}</strong><span className="small muted">{i.sub}</span></span>
                    </label></li>
                  );
                })}
              </ul>
            )}
            <div className="wo-save"><button className="btn btn-primary btn-sm" onClick={attach} disabled={busy || !sel.size}>Rattacher {sel.size || ''}</button></div>
          </div>
        )}
        {linked.length === 0 && !picking ? <p className="small muted">Aucun élément. Rattachez les visites, comptes rendus et mouvements de pièces de cette intervention.</p> : (
          <div className="wo-groups">
            {GROUPS.map((g) => {
              const items = linked.filter((i) => i.kind === g.kind);
              if (!items.length) return null;
              return (
                <div key={g.kind} className="wo-group">
                  <h3><Icon name={g.icon} size={14} /> {g.label} <span>{items.length}</span></h3>
                  <ul>
                    {items.map((i) => (
                      <li key={i.id} className={`wo-item lv-${i.level ?? 'neutral'}`}>
                        <span className="nowrap small muted">{fmtAt(i)}</span>
                        <div><strong>{i.title}</strong><span className="small muted">{i.sub}</span></div>
                        {i.kind === 'rapport' && <Badge level={i.level === 'ok' ? 'ok' : 'warn'}>{i.level === 'ok' ? 'Clos' : 'Ouvert'}</Badge>}
                        {canEdit && !closed && <button className="btn btn-ghost btn-sm" onClick={() => detach(i)} disabled={busy} title="Retirer de l'OT">✕</button>}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {signing && (
        <Modal title={`Signer l'OT ${wo.number}`} onClose={() => setSigning(false)}
          footer={<><button className="btn" onClick={() => setSigning(false)}>Annuler</button>
            <button className="btn btn-primary" disabled={busy} onClick={() => run(async () => { unwrap(await supabase.rpc('sign_work_order', { p_id: id })); setSigning(false); })}><Icon name="pen" size={15} /> Signer</button></>}>
          <p>Visa <strong>responsable maintenance</strong></p>
          <p className="muted">J'atteste que les travaux décrits dans cet ordre de travail ont été réalisés et contrôlés, et que l'aéronef {wo.drone_code} peut être remis en service pour ce qui concerne cette intervention.</p>
          <div className="crm-sign-preview">
            <span className="crm-label">Votre signature</span>
            <span className="crm-signature">{pilot?.full_name ?? 'Administrateur'}</span>
            <span className="small muted">L'OT sera clôturé. Seul un administrateur pourra le rouvrir.</span>
          </div>
        </Modal>
      )}
    </div>
  );
}
