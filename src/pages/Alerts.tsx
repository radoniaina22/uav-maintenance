// Alertes : situations en cours (tous), choix des e-mails reçus (tous),
// activation, envois manuels, types d'alertes, seuils et journal (administrateur)
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { useData } from '../lib/useData';
import { useApp } from '../lib/app';
import { Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { Icon } from '../components/icons';
import {
  alertFunctionUrl, AlertDispatch, AlertEvent, AlertKind, AlertMode, AlertSettings, AUDIENCE_LABEL, CATEGORY_LABEL, CATEGORY_ORDER,
  describeAlertRun, invokeAlerts, LEVEL_LABEL, MODE_LABEL, publicAppUrl, THRESHOLD_FIELDS, THRESHOLD_GROUPS,
} from '../lib/alerts';

const dt = (v: string) => new Date(v).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const LEVEL_BADGE = { danger: 'danger', warn: 'warn', info: 'info' } as const;

export default function Alerts() {
  const { isAdmin, pilot, session, ports } = useApp();
  const userId = session.user.id;
  const { data, error, loading, reload } = useData(async () => {
    // mise à jour des situations avant affichage (sans envoi)
    await supabase.rpc('alerts_refresh');
    const [kinds, events, optouts] = await Promise.all([
      supabase.from('alert_kinds').select('*').order('sort').then((r) => unwrap(r) as AlertKind[]),
      supabase.from('alert_events').select('*').is('resolved_at', null).order('first_seen_at', { ascending: false }).then((r) => unwrap(r) as AlertEvent[]),
      supabase.from('alert_optouts').select('kind').eq('user_id', userId).then((r) => (unwrap(r) as { kind: string }[]).map((o) => o.kind)),
    ]);
    return { kinds, events, optouts: new Set(optouts) };
  }, [userId]);

  if (loading && !data) return <Loading />;
  const kinds = data?.kinds ?? [];
  const byCode = new Map(kinds.map((k) => [k.code, k]));

  return (
    <div className="alerts-page">
      <PageHeader title="Alertes"
        subtitle="Situations à traiter (visites, potentiels, sécurité, suivi) et e-mails automatiques envoyés aux équipes" />
      <ErrorBox error={error} />
      {data && <ActiveAlerts events={data.events} kinds={byCode} portName={(id) => ports.find((p) => p.id === id)?.name ?? null} />}
      {data && <MyEmails kinds={kinds} optouts={data.optouts} isAdmin={isAdmin} lead={!!pilot?.maintenance_lead} onChanged={reload} />}
      {isAdmin && data && <AdminSending onChanged={reload} />}
      {isAdmin && data && <KindsCard kinds={kinds} onChanged={reload} />}
      {isAdmin && <ThresholdsCard />}
    </div>
  );
}

// ---------------------------------------------------------------------
function ActiveAlerts({ events, kinds, portName }: { events: AlertEvent[]; kinds: Map<string, AlertKind>; portName: (id: string) => string | null }) {
  const [cat, setCat] = useState<string>('');
  const sorted = useMemo(() => [...events].sort((a, b) => {
    const rank = { danger: 0, warn: 1, info: 2 };
    return rank[a.level] - rank[b.level] || (kinds.get(a.kind)?.sort ?? 0) - (kinds.get(b.kind)?.sort ?? 0) || a.title.localeCompare(b.title);
  }), [events, kinds]);
  const count = (c: string) => sorted.filter((e) => kinds.get(e.kind)?.category === c).length;
  const shown = cat ? sorted.filter((e) => kinds.get(e.kind)?.category === cat) : sorted;
  const urgent = events.filter((e) => e.level === 'danger').length;

  return (
    <section className="card">
      <div className="row-between">
        <h2 className="card-title">En cours <span className="muted">· {events.length} alerte(s){urgent ? `, dont ${urgent} urgente(s)` : ''}</span></h2>
        <div className="al-filters">
          <button className={`btn btn-sm${cat === '' ? ' btn-primary' : ''}`} onClick={() => setCat('')}>Toutes</button>
          {CATEGORY_ORDER.map((c) => (
            <button key={c} className={`btn btn-sm${cat === c ? ' btn-primary' : ''}`} onClick={() => setCat(c)} disabled={!count(c)}>
              {CATEGORY_LABEL[c]} ({count(c)})
            </button>
          ))}
        </div>
      </div>
      {!shown.length ? <Empty>Aucune alerte en cours.</Empty> : (
        <ul className="al-list">
          {shown.map((e) => {
            const k = kinds.get(e.kind);
            const body = (
              <>
                <div className="al-head">
                  <span className={`badge badge-${LEVEL_BADGE[e.level]}`}>{LEVEL_LABEL[e.level]}</span>
                  <span className="al-kind">{k?.label ?? e.kind}{e.drone_port_id ? ` · ${portName(e.drone_port_id) ?? ''}` : ''}</span>
                </div>
                <strong className="al-title">{e.title}</strong>
                {e.detail && <div className="al-detail">{e.detail}</div>}
                <div className="al-meta">
                  Depuis le {dt(e.first_seen_at)}
                  {e.notified_at ? ` · e-mail envoyé le ${dt(e.notified_at)}${e.notify_count > 1 ? ` (${e.notify_count} envois)` : ''}` : ' · pas encore envoyé par e-mail'}
                </div>
              </>
            );
            return <li key={e.id} className={`al-item lv-${e.level}`}>{e.link ? <Link to={e.link}>{body}</Link> : body}</li>;
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------
function MyEmails({ kinds, optouts, isAdmin, lead, onChanged }: { kinds: AlertKind[]; optouts: Set<string>; isAdmin: boolean; lead: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // alertes qui peuvent concerner cet utilisateur
  const mine = kinds.filter((k) => isAdmin || k.audience === 'port' || k.audience === 'personnel' || (k.audience === 'responsables' && lead));

  async function toggle(k: AlertKind) {
    setBusy(k.code); setErr(null);
    try {
      if (optouts.has(k.code)) unwrap(await supabase.from('alert_optouts').delete().eq('kind', k.code).select('kind'));
      else unwrap(await supabase.from('alert_optouts').insert({ kind: k.code }).select('kind'));
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  return (
    <section className="card">
      <h2 className="card-title">Mes e-mails d'alerte</h2>
      <p className="muted small">Cochez les alertes que vous voulez recevoir à l'adresse de votre compte. Les alertes restent visibles ci-dessus même si vous ne les recevez pas.</p>
      <ErrorBox error={err} />
      <div className="al-prefs">
        {CATEGORY_ORDER.map((c) => {
          const list = mine.filter((k) => k.category === c);
          if (!list.length) return null;
          return (
            <div key={c} className="al-pref-group">
              <h3>{CATEGORY_LABEL[c]}</h3>
              {list.map((k) => (
                <label key={k.code} className={`al-pref${k.enabled ? '' : ' is-off'}`}>
                  <input type="checkbox" checked={k.enabled && !optouts.has(k.code)} disabled={!k.enabled || busy === k.code} onChange={() => toggle(k)} />
                  <span>
                    <strong>{k.label}</strong> <span className="muted small">· {MODE_LABEL[k.mode]}</span>
                    <span className="small muted block">{k.enabled ? k.description : 'Désactivée par l\'administrateur'}</span>
                  </span>
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------
function AdminSending({ onChanged }: { onChanged: () => void }) {
  const { data, error, reload } = useData(async () => {
    const [settings, log] = await Promise.all([
      supabase.from('alert_settings').select('*').single().then((r) => unwrap(r) as AlertSettings),
      supabase.from('alert_dispatches').select('*').order('created_at', { ascending: false }).limit(40).then((r) => unwrap(r) as AlertDispatch[]),
    ]);
    return { settings, log };
  }, []);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ level: 'ok' | 'danger'; lines: string[] } | null>(null);
  const s = data?.settings;

  async function run(key: string, fn: () => Promise<string[]>) {
    setBusy(key); setMsg(null);
    try { setMsg({ level: 'ok', lines: await fn() }); } catch (e) { setMsg({ level: 'danger', lines: [e instanceof Error ? e.message : String(e)] }); }
    finally { setBusy(null); reload(); onChanged(); }
  }
  const toggle = () => run('enable', async () => {
    const on = !s?.enabled;
    if (on && !window.confirm('Activer les alertes par e-mail ?\n\n• alertes immédiates (vérifiées toutes les 5 minutes)\n• récapitulatif chaque jour à 07h00\n• bilan le lundi à 07h15\n• météo du lendemain à 18h00\n\nConseil : envoyez-vous d\'abord un aperçu de test.')) return [];
    unwrap(await supabase.rpc('set_alert_settings', { p_enabled: on, p_functions_url: alertFunctionUrl(), p_app_url: publicAppUrl() }));
    return [on ? 'Alertes par e-mail activées.' : 'Alertes par e-mail désactivées.'];
  });
  const send = (mode: AlertMode | 'test', confirmText?: string) => run(mode, async () => {
    if (confirmText && !window.confirm(confirmText)) return [];
    return describeAlertRun(await invokeAlerts(mode));
  });

  return (
    <section className={`card rr-sending${s?.enabled ? ' is-on' : ''}`}>
      <ErrorBox error={error} />
      <div className="row-between">
        <div>
          <h2 className="card-title">Envoi automatique</h2>
          <p className="muted small">
            {s?.enabled
              ? <>Alertes par e-mail <strong>activées</strong> : immédiates toutes les 5 minutes, récapitulatif à 07h00, bilan le lundi, météo à 18h00 (heure de Madagascar).</>
              : <>Alertes par e-mail <strong>désactivées</strong> : les alertes sont calculées et visibles ici, mais aucun e-mail ne part.</>}
            {s?.enabled && !s.app_url && <> Activez-les depuis le site en ligne pour que les e-mails contiennent les liens vers l'application.</>}
          </p>
        </div>
        <button className={`btn ${s?.enabled ? '' : 'btn-primary'}`} onClick={toggle} disabled={!!busy || !s}>
          {s?.enabled ? 'Désactiver les alertes' : 'Activer les alertes'}
        </button>
      </div>
      <div className="rr-actions">
        <button className="btn btn-sm" onClick={() => send('test')} disabled={!!busy}>{busy === 'test' ? 'Envoi…' : 'M\'envoyer un aperçu (test)'}</button>
        <span className="rr-sep" />
        <span className="small muted">Envoyer maintenant :</span>
        <button className="btn btn-sm" onClick={() => send('immediat', 'Envoyer maintenant les alertes immédiates en attente ?')} disabled={!!busy}>{busy === 'immediat' ? 'Envoi…' : 'Alertes immédiates'}</button>
        <button className="btn btn-sm" onClick={() => send('quotidien', 'Envoyer maintenant le récapitulatif du jour (nouvelles alertes et rappels) à tous les destinataires ?')} disabled={!!busy}>{busy === 'quotidien' ? 'Envoi…' : 'Récapitulatif du jour'}</button>
        <button className="btn btn-sm" onClick={() => send('hebdomadaire', 'Envoyer maintenant le bilan de la semaine à tous les destinataires ?')} disabled={!!busy}>{busy === 'hebdomadaire' ? 'Envoi…' : 'Bilan de la semaine'}</button>
        <button className="btn btn-sm" onClick={() => send('meteo', 'Vérifier la météo de demain et prévenir les drone ports concernés ?')} disabled={!!busy}>{busy === 'meteo' ? 'Vérification…' : 'Météo de demain'}</button>
      </div>
      {msg && msg.lines.length > 0 && <div className={`alert alert-${msg.level}`}>{msg.lines.length === 1 ? msg.lines[0] : <ul>{msg.lines.map((l) => <li key={l}>{l}</li>)}</ul>}</div>}

      <details className="rr-log">
        <summary>Journal des e-mails ({data?.log.length ?? 0} derniers)</summary>
        {!data?.log.length ? <p className="muted small">Aucun e-mail d'alerte envoyé pour l'instant.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Envoi</th><th>Destinataire</th><th>Alertes</th><th>Objet</th><th>Statut</th></tr></thead>
              <tbody>
                {data.log.map((l) => (
                  <tr key={l.id}>
                    <td className="nowrap">{dt(l.created_at)}</td>
                    <td>{MODE_LABEL[l.mode]}{l.trigger === 'manuel' ? ' · manuel' : ''}</td>
                    <td>{l.recipient}</td>
                    <td className="num">{l.alert_count}</td>
                    <td className="small">{l.subject}</td>
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

// ---------------------------------------------------------------------
function KindsCard({ kinds, onChanged }: { kinds: AlertKind[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function toggle(k: AlertKind) {
    setBusy(k.code); setErr(null);
    try { unwrap(await supabase.from('alert_kinds').update({ enabled: !k.enabled }).eq('code', k.code).select('code')); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }
  return (
    <section className="card">
      <h2 className="card-title">Types d'alertes</h2>
      <p className="muted small">Une alerte désactivée n'est plus envoyée à personne (elle reste visible dans la liste ci-dessus).</p>
      <ErrorBox error={err} />
      <div className="table-wrap">
        <table className="al-kinds">
          <thead><tr><th>Active</th><th>Alerte</th><th>Envoi</th><th>Destinataires</th><th>Rappel</th></tr></thead>
          <tbody>
            {kinds.map((k) => (
              <tr key={k.code} className={k.enabled ? '' : 'muted'}>
                <td><input type="checkbox" checked={k.enabled} disabled={busy === k.code} onChange={() => toggle(k)} aria-label={`Activer ${k.label}`} /></td>
                <td><strong>{k.label}</strong><div className="small muted">{CATEGORY_LABEL[k.category]} · {k.description}</div></td>
                <td className="small">{MODE_LABEL[k.mode]}</td>
                <td className="small">{AUDIENCE_LABEL[k.audience]}</td>
                <td className="small">{k.remind_days ? (k.remind_days === 1 ? 'chaque jour' : `tous les ${k.remind_days} jours`) : 'une fois'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------
function ThresholdsCard() {
  const { data, error, reload } = useData(async () => unwrap(await supabase.from('alert_settings').select('*').single()) as AlertSettings, []);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ level: 'ok' | 'danger'; text: string } | null>(null);
  if (!data) return <ErrorBox error={error} />;
  const fmt = (n: number) => String(n).replace('.', ',');
  const parse = (v: string) => Number(v.trim().replace(',', '.'));
  const saved = (k: keyof AlertSettings) => Number(data[k]);
  const value = (k: keyof AlertSettings) => draft[k] ?? fmt(saved(k));
  const dirty = (k: keyof AlertSettings) => draft[k] !== undefined && parse(draft[k]) !== saved(k);
  const changes = THRESHOLD_FIELDS.filter((f) => dirty(f.key));

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const patch: Record<string, number> = {};
      for (const f of changes) {
        const n = parse(draft[f.key]);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`Valeur invalide : ${f.label}`);
        patch[f.key] = n;
      }
      unwrap(await supabase.from('alert_settings').update(patch).eq('id', true).select('id'));
      setDraft({});
      setMsg({ level: 'ok', text: `${changes.length} seuil(s) enregistré(s) : pris en compte au prochain calcul des alertes (5 minutes au plus).` });
      reload();
    } catch (e) { setMsg({ level: 'danger', text: e instanceof Error ? e.message : String(e) }); } finally { setBusy(false); }
  }

  return (
    <section className="card">
      <div className="row-between al-th-top">
        <div>
          <h2 className="card-title">Seuils de déclenchement</h2>
          <p className="muted small">Le potentiel des pièces se règle par type de pièce (page Pièces), les cycles maximum sur chaque batterie.</p>
        </div>
        <div className="rr-actions">
          {changes.length > 0 && <span className="small al-dirty-count">{changes.length} modification(s) non enregistrée(s)</span>}
          {changes.length > 0 && <button className="btn btn-sm" onClick={() => setDraft({})} disabled={busy}>Annuler</button>}
          <button className="btn btn-sm btn-primary" onClick={save} disabled={!changes.length || busy}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button>
        </div>
      </div>
      <div className="al-th-groups">
        {THRESHOLD_GROUPS.map((g) => (
          <div key={g.title} className="al-th-group">
            <h3><Icon name={g.icon} size={15} /> {g.title}</h3>
            {g.fields.map((f) => {
              const isDirty = dirty(f.key);
              const atDefault = parse(value(f.key)) === f.def;
              return (
                <div key={f.key} className={`al-th${isDirty ? ' is-dirty' : ''}`}>
                  <label className="al-th-text" htmlFor={`th-${f.key}`}>
                    <strong>{f.label}</strong>
                    <span>{f.hint}</span>
                  </label>
                  <div className="al-th-control">
                    <div className="al-th-input">
                      <input id={`th-${f.key}`} type="text" inputMode="decimal" value={value(f.key)}
                        onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
                      <span>{f.unit}</span>
                    </div>
                    {!atDefault && <button type="button" className="al-th-def al-th-reset" onClick={() => setDraft({ ...draft, [f.key]: fmt(f.def) })}
                      title="Revenir à la valeur par défaut">↺ défaut {fmt(f.def)}</button>}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {msg && <div className={`alert alert-${msg.level}`}>{msg.text}</div>}
    </section>
  );
}
