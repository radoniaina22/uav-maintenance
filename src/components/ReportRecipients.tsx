// Destinataires des rapports mensuels par e-mail (administrateur)
//  * rapport UNFPA : liste modifiable (table unfpa_recipients), ajout un par un ou collage d'une liste
//  * rapports pilotes / admin : déduits des comptes de l'application (lecture seule)
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { useData } from '../lib/useData';
import { download, toCsv } from '../lib/stats';
import { monthLabel, previousMonth, REPORT_SENDER, ReportKind } from '../lib/monthlyReports';
import { describeResults, invokeSend, publicAppUrl, sendFunctionUrl } from '../lib/reportMail';
import { useApp } from '../lib/app';
import { Empty, ErrorBox, Field, Loading, Modal } from './ui';

interface Recipient { id: string; email: string; full_name: string; job_title: string | null; active: boolean; notes: string | null }
interface AutoRecipient { report: 'pilotes' | 'admin'; drone_port_id: string | null; drone_port_name: string | null; full_name: string; email: string }
type Draft = { id?: string; email: string; full_name: string; job_title: string; notes: string; active: boolean };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EMPTY: Draft = { email: '', full_name: '', job_title: '', notes: '', active: true };

/**
 * Lecture d'une liste collée (Excel, Outlook, texte) : une personne par ligne,
 * colonnes séparées par « ; », tabulation ou « , » : Nom ; Fonction ; e-mail (dans n'importe quel ordre),
 * ou format Outlook « Nom <adresse> ». L'adresse est repérée automatiquement.
 */
export function parseRecipientList(text: string) {
  const ok: { email: string; full_name: string; job_title: string | null }[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const outlook = line.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
    if (outlook) {
      const email = outlook[2].trim().toLowerCase();
      if (EMAIL_RE.test(email)) ok.push({ email, full_name: outlook[1].trim() || email, job_title: null }); else bad.push(line);
      continue;
    }
    const cells = line.split(/[;\t,]/).map((c) => c.trim()).filter(Boolean);
    const email = cells.find((c) => EMAIL_RE.test(c))?.toLowerCase();
    if (!email) { bad.push(line); continue; }
    const rest = cells.filter((c) => c.toLowerCase() !== email);
    ok.push({ email, full_name: rest[0] || email, job_title: rest[1] || null });
  }
  // une adresse n'apparaît qu'une fois
  const seen = new Set<string>();
  return { ok: ok.filter((r) => !seen.has(r.email) && seen.add(r.email)), bad };
}

export default function ReportRecipients() {
  const { data, error, loading, reload } = useData(async () => {
    const [list, auto] = await Promise.all([
      supabase.from('unfpa_recipients').select('*').order('active', { ascending: false }).order('full_name').then((r) => unwrap(r) as Recipient[]),
      supabase.rpc('report_auto_recipients').then((r) => unwrap(r) as AutoRecipient[]),
    ]);
    return { list, auto };
  }, []);
  const [edit, setEdit] = useState<Draft | null>(null);
  const [importing, setImporting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const list = data?.list ?? [];
  const activeCount = list.filter((r) => r.active).length;
  const byPort = useMemo(() => {
    const m = new Map<string, AutoRecipient[]>();
    for (const r of data?.auto ?? []) if (r.report === 'pilotes') m.set(r.drone_port_name ?? '?', [...(m.get(r.drone_port_name ?? '?') ?? []), r]);
    return [...m.entries()];
  }, [data]);
  const admins = (data?.auto ?? []).filter((r) => r.report === 'admin');

  async function act(fn: () => Promise<unknown>) {
    setActionError(null);
    try { await fn(); reload(); } catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
  }
  const toggle = (r: Recipient) => act(async () => unwrap(await supabase.from('unfpa_recipients').update({ active: !r.active }).eq('id', r.id).select('id')));
  const remove = (r: Recipient) => {
    if (!window.confirm(`Supprimer ${r.full_name} (${r.email}) de la liste ?\n\nPour l'exclure temporairement, désactivez-le plutôt.`)) return;
    act(async () => unwrap(await supabase.from('unfpa_recipients').delete().eq('id', r.id).select('id')));
  };
  const exportCsv = () => download('destinataires-rapport-UNFPA.csv', toCsv(list.map((r) => ({
    Nom: r.full_name, Fonction: r.job_title, 'E-mail': r.email, Actif: r.active ? 'oui' : 'non', Notes: r.notes,
  }))));

  if (loading && !data) return <Loading />;

  return (
    <div className="rr-page">
      <ErrorBox error={error ?? actionError} />

      <SendingCard unfpaRecipients={activeCount} />

      <section className="card">
        <div className="row-between">
          <div>
            <h2 className="card-title">Rapport livraisons UNFPA</h2>
            <p className="muted small">
              {activeCount} destinataire(s) actif(s). Le rapport leur est envoyé quand l'administrateur le valide.
              Expéditeur : <strong>{REPORT_SENDER}</strong>.
            </p>
          </div>
          <div className="rr-actions">
            <button className="btn" onClick={exportCsv} disabled={!list.length}>Exporter la liste (CSV)</button>
            <button className="btn" onClick={() => setImporting(true)}>Coller une liste</button>
            <button className="btn btn-primary" onClick={() => setEdit({ ...EMPTY })}>+ Ajouter un destinataire</button>
          </div>
        </div>
        {!list.length ? <Empty>Aucun destinataire : ajoutez-en un, ou collez une liste copiée depuis Excel ou Outlook.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Nom</th><th>Fonction</th><th>E-mail</th><th>Statut</th><th className="num">Actions</th></tr></thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id} className={r.active ? '' : 'row-muted'}>
                    <td><strong>{r.full_name}</strong>{r.notes && <div className="small muted">{r.notes}</div>}</td>
                    <td>{r.job_title ?? '—'}</td>
                    <td><a href={`mailto:${r.email}`}>{r.email}</a></td>
                    <td><span className={`badge badge-${r.active ? 'ok' : 'neutral'}`}>{r.active ? 'Actif' : 'Désactivé'}</span></td>
                    <td className="num rr-row-actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => setEdit({ id: r.id, email: r.email, full_name: r.full_name, job_title: r.job_title ?? '', notes: r.notes ?? '', active: r.active })}>Modifier</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => toggle(r)}>{r.active ? 'Désactiver' : 'Réactiver'}</button>
                      <button className="btn btn-ghost btn-sm rr-danger" onClick={() => remove(r)}>Supprimer</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">Rapports pilotes et administrateur (automatique)</h2>
        <p className="muted small">
          Envoyés le 1er du mois à 07h00 aux comptes de l'application : chaque pilote actif reçoit le rapport de son drone port,
          les administrateurs reçoivent le rapport administrateur. Pour modifier ces listes, gérez les comptes dans{' '}
          <Link to="/utilisateurs">Utilisateurs</Link> et les fiches dans <Link to="/pilotes">Pilotes</Link>.
        </p>
        <div className="rr-auto">
          {byPort.map(([port, rows]) => (
            <div key={port} className="rr-group">
              <h3>Rapport pilotes · {port} <span className="muted">({rows.length})</span></h3>
              <ul>{rows.map((r) => <li key={r.email}>{r.full_name} <span className="muted small">{r.email}</span></li>)}</ul>
            </div>
          ))}
          {!byPort.length && <p className="muted small">Aucun pilote actif avec un compte.</p>}
          <div className="rr-group">
            <h3>Rapport administrateur <span className="muted">({admins.length})</span></h3>
            <ul>{admins.map((r) => <li key={r.email}>{r.full_name} <span className="muted small">{r.email}</span></li>)}</ul>
          </div>
        </div>
      </section>

      {edit && <RecipientModal draft={edit} existing={list} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      {importing && <ImportModal existing={list} onClose={() => setImporting(false)} onSaved={() => { setImporting(false); reload(); }} />}
    </div>
  );
}

interface Settings { auto_send: boolean; functions_url: string | null; app_url: string | null; updated_at: string }
interface Dispatch {
  id: string; kind: ReportKind; month: string; trigger: string; recipients: string[]; status: string; error: string | null;
  subject: string | null; created_at: string; drone_ports: { name: string } | null;
}
const TRIGGER: Record<string, string> = { cron: 'automatique', manuel: 'manuel', validation: 'validation', test: 'test' };
const KIND: Record<ReportKind, string> = { pilotes: 'Pilotes', admin: 'Administrateur', unfpa: 'UNFPA' };

/** Envoi automatique (activation), e-mails de test, envoi manuel et journal des envois */
function SendingCard({ unfpaRecipients }: { unfpaRecipients: number }) {
  const { portFilter, ports } = useApp();
  const { data, error, reload } = useData(async () => {
    const [settings, log] = await Promise.all([
      supabase.from('report_settings').select('*').single().then((r) => unwrap(r) as Settings),
      supabase.from('report_dispatches').select('*, drone_ports(name)').order('created_at', { ascending: false }).limit(30).then((r) => unwrap(r) as Dispatch[]),
    ]);
    return { settings, log };
  }, []);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ level: 'ok' | 'danger'; lines: string[] } | null>(null);
  const month = previousMonth();
  const s = data?.settings;
  const next = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + 1, 1); })();

  async function run(key: string, fn: () => Promise<string[]>) {
    setBusy(key); setMsg(null);
    try { setMsg({ level: 'ok', lines: await fn() }); } catch (e) { setMsg({ level: 'danger', lines: [e instanceof Error ? e.message : String(e)] }); }
    finally { setBusy(null); reload(); }
  }
  const toggle = () => run('auto', async () => {
    const on = !s?.auto_send;
    if (on && !window.confirm('Activer l\'envoi automatique ?\n\nLe 1er de chaque mois à 07h00, les rapports pilotes et administrateur seront envoyés par e-mail à tous les comptes concernés.\n\nConseil : envoyez-vous d\'abord un e-mail de test.')) return [];
    unwrap(await supabase.rpc('set_report_settings', { p_auto_send: on, p_functions_url: sendFunctionUrl(), p_app_url: publicAppUrl() }));
    return [on ? 'Envoi automatique activé.' : 'Envoi automatique désactivé.'];
  });
  const test = (kind: ReportKind) => run(`test-${kind}`, async () => {
    // rapport pilotes : drone port choisi en haut de page, sinon le premier
    const port = kind === 'pilotes' ? (portFilter || ports[0]?.id || null) : null;
    return describeResults(await invokeSend({ mode: 'send', kind, month: `${month}-01`, port, test: true }));
  });
  const sendNow = () => run('now', async () => {
    if (!window.confirm(`Envoyer maintenant les rapports pilotes et administrateur de ${monthLabel(month)} à tous les destinataires ?\n\nLes rapports déjà envoyés pour ce mois ne seront pas renvoyés.`)) return [];
    return describeResults(await invokeSend({ mode: 'monthly', month: `${month}-01` }));
  });

  return (
    <section className={`card rr-sending${s?.auto_send ? ' is-on' : ''}`}>
      <ErrorBox error={error} />
      <div className="row-between">
        <div>
          <h2 className="card-title">Envoi des e-mails</h2>
          <p className="muted small">
            {s?.auto_send
              ? <>Envoi automatique <strong>activé</strong> : prochain envoi le {next.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })} à 07h00 (rapports pilotes et administrateur du mois écoulé).</>
              : <>Envoi automatique <strong>désactivé</strong> : aucun e-mail ne part le 1er du mois.</>}
            {' '}Le rapport UNFPA part à sa validation ({unfpaRecipients} destinataire(s) actif(s)). Expéditeur : {REPORT_SENDER}.
          </p>
        </div>
        <button className={`btn ${s?.auto_send ? '' : 'btn-primary'}`} onClick={toggle} disabled={!!busy || !s}>
          {s?.auto_send ? 'Désactiver l\'envoi automatique' : 'Activer l\'envoi automatique'}
        </button>
      </div>

      <div className="rr-actions">
        <span className="small muted">M'envoyer un test ({monthLabel(month)}) :</span>
        <button className="btn btn-sm" onClick={() => test('pilotes')} disabled={!!busy}>{busy === 'test-pilotes' ? 'Envoi…' : 'Rapport pilotes'}</button>
        <button className="btn btn-sm" onClick={() => test('admin')} disabled={!!busy}>{busy === 'test-admin' ? 'Envoi…' : 'Rapport administrateur'}</button>
        <button className="btn btn-sm" onClick={() => test('unfpa')} disabled={!!busy}>{busy === 'test-unfpa' ? 'Envoi…' : 'Rapport UNFPA'}</button>
        <span className="rr-sep" />
        <button className="btn btn-sm" onClick={sendNow} disabled={!!busy}>{busy === 'now' ? 'Envoi…' : `Envoyer maintenant (${monthLabel(month)})`}</button>
      </div>
      {msg && msg.lines.length > 0 && <div className={`alert alert-${msg.level}`}>{msg.lines.length === 1 ? msg.lines[0] : <ul>{msg.lines.map((l) => <li key={l}>{l}</li>)}</ul>}</div>}

      <details className="rr-log" open={!!data?.log.length}>
        <summary>Journal des envois ({data?.log.length ?? 0} derniers)</summary>
        {!data?.log.length ? <p className="muted small">Aucun envoi pour l'instant.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Rapport</th><th>Mois</th><th>Déclenchement</th><th>Destinataires</th><th>Statut</th></tr></thead>
              <tbody>
                {data.log.map((l) => (
                  <tr key={l.id}>
                    <td className="nowrap">{new Date(l.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</td>
                    <td>{KIND[l.kind]}{l.drone_ports ? ` · ${l.drone_ports.name}` : ''}</td>
                    <td>{monthLabel(l.month.slice(0, 7))}</td>
                    <td>{TRIGGER[l.trigger] ?? l.trigger}</td>
                    <td title={l.recipients.join(', ')}>{l.recipients.length === 1 ? l.recipients[0] : `${l.recipients.length} personnes`}</td>
                    <td>
                      <span className={`badge badge-${l.status === 'envoye' ? 'ok' : l.status === 'erreur' ? 'danger' : 'neutral'}`}>{l.status === 'envoye' ? 'Envoyé' : l.status === 'erreur' ? 'Erreur' : 'Simulé'}</span>
                      {l.error && <div className="small rr-bad">{l.error}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </section>
  );
}

function RecipientModal({ draft, existing, onClose, onSaved }: { draft: Draft; existing: Recipient[]; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState(draft);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const email = d.email.trim().toLowerCase();
  const dup = existing.some((r) => r.email === email && r.id !== d.id);

  async function save() {
    if (!d.full_name.trim()) { setErr('Indiquez le nom.'); return; }
    if (!EMAIL_RE.test(email)) { setErr('Adresse e-mail invalide.'); return; }
    if (dup) { setErr('Cette adresse est déjà dans la liste.'); return; }
    setBusy(true); setErr(null);
    try {
      const row = { email, full_name: d.full_name, job_title: d.job_title || null, notes: d.notes || null, active: d.active };
      if (d.id) unwrap(await supabase.from('unfpa_recipients').update(row).eq('id', d.id).select('id'));
      else unwrap(await supabase.from('unfpa_recipients').insert(row).select('id'));
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title={d.id ? 'Modifier le destinataire' : 'Ajouter un destinataire'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Annuler</button><button className="btn btn-primary" onClick={save} disabled={busy}>Enregistrer</button></>}>
      <div className="form-grid">
        <Field label="Nom" required><input value={d.full_name} onChange={(e) => setD({ ...d, full_name: e.target.value })} autoFocus /></Field>
        <Field label="Fonction"><input value={d.job_title} onChange={(e) => setD({ ...d, job_title: e.target.value })} placeholder="ex. Chargée de programme SR" /></Field>
        <Field label="E-mail" required hint={dup ? 'Adresse déjà dans la liste' : undefined}>
          <input type="email" value={d.email} onChange={(e) => setD({ ...d, email: e.target.value })} placeholder="prenom.nom@unfpa.org" />
        </Field>
        <Field label="Statut">
          <label className="rr-check"><input type="checkbox" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} /> Reçoit le rapport</label>
        </Field>
        <Field label="Notes" wide><input value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} placeholder="facultatif" /></Field>
      </div>
      <ErrorBox error={err} />
    </Modal>
  );
}

function ImportModal({ existing, onClose, onSaved }: { existing: Recipient[]; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseRecipientList(text), [text]);
  const known = new Set(existing.map((r) => r.email));
  const fresh = parsed.ok.filter((r) => !known.has(r.email));
  const already = parsed.ok.length - fresh.length;

  async function save() {
    setBusy(true); setErr(null);
    try {
      if (fresh.length) unwrap(await supabase.from('unfpa_recipients').insert(fresh.map((r) => ({ ...r, active: true }))).select('id'));
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="Coller une liste de destinataires" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Annuler</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !fresh.length}>Ajouter {fresh.length} destinataire(s)</button></>}>
      <p className="muted small">
        Une personne par ligne. Collez directement des colonnes Excel (Nom, Fonction, E-mail), des lignes « Nom ; Fonction ; e-mail »,
        ou des adresses Outlook « Prénom Nom &lt;adresse&gt; ». L'adresse est repérée automatiquement.
      </p>
      <textarea className="rr-paste" rows={8} value={text} onChange={(e) => setText(e.target.value)} autoFocus
        placeholder={'Hery Rakoto ; Chargé de programme ; hery.rakoto@exemple.org\nMialy Andria <mialy.andria@exemple.org>'} />
      {text.trim() && (
        <div className="small rr-preview">
          <div><strong>{fresh.length}</strong> nouveau(x) destinataire(s){already ? `, ${already} déjà dans la liste (ignoré(s))` : ''}.</div>
          {fresh.length > 0 && <ul>{fresh.slice(0, 8).map((r) => <li key={r.email}>{r.full_name}{r.job_title ? ` · ${r.job_title}` : ''} <span className="muted">{r.email}</span></li>)}
            {fresh.length > 8 && <li className="muted">… et {fresh.length - 8} autre(s)</li>}</ul>}
          {parsed.bad.length > 0 && <div className="rr-bad">Lignes sans adresse valide (ignorées) : {parsed.bad.slice(0, 5).join(' · ')}{parsed.bad.length > 5 ? ' …' : ''}</div>}
        </div>
      )}
      <ErrorBox error={err} />
    </Modal>
  );
}
