import { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { useApp } from '../lib/app';
import { useData } from '../lib/useData';
import type { AdminUserRow, Pilot, Role } from '../lib/types';
import { ErrorBox, Loading, PageHeader } from '../components/ui';
import { Icon } from '../components/icons';

const hue = (s: string) => Math.round(([...s].reduce((h, c) => h + c.charCodeAt(0) * 7, 0) * 137.508) % 360);
const initials = (s: string) => {
  const base = s.includes('@') ? s.split('@')[0].replace(/[._-]+/g, ' ') : s;
  return base.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join('') || '?';
};
/** « il y a 3 h », « il y a 2 j »… */
function ago(iso: string | null) {
  if (!iso) return null;
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 2) return 'à l\'instant';
  if (min < 60) return `il y a ${min} min`;
  if (min < 1440) return `il y a ${Math.round(min / 60)} h`;
  const d = Math.round(min / 1440);
  return d < 60 ? `il y a ${d} j` : `il y a ${Math.round(d / 30)} mois`;
}

type Access = { level: 'ok' | 'all' | 'blocked' | 'warn'; label: string; hint: string };

/** Demande d'inscription : validation (fiche pilote créée ou reprise) ou refus */
function SignupRequest({ u, pilots, freePilots, ports, onDone }: {
  u: AdminUserRow; pilots: Pilot[]; freePilots: Pilot[]; ports: { id: string; name: string; active?: boolean }[]; onDone: () => void;
}) {
  const s = u.signup;
  const match = s?.full_name ? freePilots.find((p) => p.full_name.trim().toLowerCase() === s.full_name.trim().toLowerCase()) : undefined;
  const [mode, setMode] = useState<'new' | 'existing'>(match ? 'existing' : 'new');
  const [existing, setExisting] = useState(match?.id ?? '');
  const [name, setName] = useState(s?.full_name ?? '');
  const [port, setPort] = useState(s?.requested_port_id ?? match?.drone_port_id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setBusy(true); setError(null);
    try {
      unwrap(await supabase.rpc('admin_approve_signup', {
        p_user: u.user_id, p_port: port || null, p_full_name: name, p_license: s?.license_number ?? null, p_phone: s?.phone ?? null,
        p_existing_pilot: mode === 'existing' ? existing || null : null,
      }));
      onDone();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }
  async function reject() {
    if (!window.confirm(`Refuser l'inscription de ${s?.full_name ?? u.email} ?\nLe compte ${u.email} sera supprimé.`)) return;
    setBusy(true); setError(null);
    try { unwrap(await supabase.rpc('admin_reject_signup', { p_user: u.user_id })); onDone(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }

  const display = s?.full_name ?? u.email.split('@')[0];
  const portOk = mode === 'existing' ? !!existing : !!port && !!name.trim();
  return (
    <article className={`signup-req${busy ? ' is-saving' : ''}`}>
      <header className="acc-head">
        <span className="acc-avatar" style={{ ['--h' as string]: hue(display) }}>{initials(display)}</span>
        <div className="acc-id"><strong>{display}</strong><span className="mono">{u.email}</span></div>
        <span className="sr-when">{ago(u.created_at) ?? ''}</span>
      </header>
      {s ? (
        <dl className="sr-facts">
          <div><dt>Drone port demandé</dt><dd>{s.requested_port_name ?? '—'}</dd></div>
          <div><dt>Téléphone</dt><dd>{s.phone ?? '—'}</dd></div>
          <div><dt>Licence</dt><dd className="mono">{s.license_number ?? '—'}</dd></div>
        </dl>
      ) : <p className="small muted">Compte créé directement dans Supabase (pas de formulaire d'inscription).</p>}
      {s?.message && <blockquote className="sr-msg">{s.message}</blockquote>}
      <div className="sr-decide">
        <div className="segmented segmented-sm">
          <button type="button" className={mode === 'new' ? 'active' : ''} onClick={() => setMode('new')}>Nouvelle fiche pilote</button>
          <button type="button" className={mode === 'existing' ? 'active' : ''} onClick={() => setMode('existing')} disabled={!freePilots.length}>Fiche existante ({freePilots.length})</button>
        </div>
        <div className="sr-fields">
          {mode === 'new' ? (
            <label className="field"><span className="field-label">Nom sur la fiche</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
          ) : (
            <label className="field"><span className="field-label">Fiche pilote</span>
              <select value={existing} onChange={(e) => { setExisting(e.target.value); const p = pilots.find((x) => x.id === e.target.value); if (p?.drone_port_id && !port) setPort(p.drone_port_id); }}>
                <option value="">— Choisir —</option>
                {freePilots.map((p) => <option key={p.id} value={p.id}>{p.full_name}{match?.id === p.id ? ' (même nom)' : ''}</option>)}
              </select></label>
          )}
          <label className="field"><span className="field-label">Drone port</span>
            <select value={port} onChange={(e) => setPort(e.target.value)}>
              <option value="">{mode === 'existing' ? '— Celui de la fiche —' : '— Choisir —'}</option>
              {ports.filter((p) => p.active !== false).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
        </div>
      </div>
      <ErrorBox error={error} />
      <footer className="sr-actions">
        <button className="btn btn-danger btn-sm" onClick={reject} disabled={busy}>✕ Refuser</button>
        <button className="btn btn-primary btn-sm" onClick={approve} disabled={busy || !portOk}>✓ Valider · compte Pilote</button>
      </footer>
    </article>
  );
}

export default function Users() {
  const { session, ports, reloadContext } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState<'' | Role | 'bloque'>('');
  const [showHelp, setShowHelp] = useState(false);

  const { data, error: loadError, loading, reload } = useData(async () => {
    const [users, pilots] = await Promise.all([
      supabase.rpc('admin_list_users'),
      supabase.from('pilots').select('*').order('full_name'),
    ]);
    return { users: unwrap(users) as AdminUserRow[], pilots: unwrap(pilots) as Pilot[] };
  });

  async function update(u: AdminUserRow, patch: { role?: Role; pilot_id?: string | null }) {
    const me = u.user_id === session.user.id;
    if (me && patch.role === 'pilote' && !window.confirm('Vous allez retirer votre propre rôle Administrateur : vous perdrez l\'accès à cette page et aux autres drone ports. Continuer ?')) return;
    if (patch.pilot_id && (u.role ?? 'pilote') === 'admin') {
      const p = data?.pilots.find((x) => x.id === patch.pilot_id);
      if (!window.confirm(`Relier ce compte administrateur à la fiche pilote « ${p?.full_name ?? ''} » ?\nIl pourra alors signer les CRM au nom de ce pilote.`)) return;
    }
    setSaving(u.user_id);
    setError(null);
    try {
      unwrap(await supabase.from('profiles').update(patch).eq('user_id', u.user_id).select());
      await reload();
      if (me) await reloadContext();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.includes('duplicate') ? 'Cette fiche pilote est déjà reliée à un autre compte.' : msg);
    } finally {
      setSaving(null);
    }
  }

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={loadError} />;

  const portName = (id: string | null) => ports.find((p) => p.id === id)?.name ?? null;
  const linked = new Set(data.users.map((u) => u.pilot_id).filter(Boolean));
  const access = (u: AdminUserRow): Access => {
    const pilot = data.pilots.find((p) => p.id === u.pilot_id);
    if ((u.role ?? 'pilote') === 'admin') {
      return pilot
        ? { level: 'all', label: 'Tous les drone ports', hint: `relié à la fiche ${pilot.full_name} : peut signer ses CRM` }
        : { level: 'all', label: 'Tous les drone ports', hint: 'accès complet' };
    }
    if (!pilot) return { level: 'blocked', label: 'Accès bloqué', hint: 'aucune fiche pilote reliée' };
    if (!pilot.drone_port_id) return { level: 'blocked', label: 'Accès bloqué', hint: `la fiche ${pilot.full_name} n'a pas de drone port` };
    if (!pilot.active) return { level: 'warn', label: portName(pilot.drone_port_id) ?? '—', hint: `fiche ${pilot.full_name} inactive` };
    return { level: 'ok', label: portName(pilot.drone_port_id) ?? '—', hint: `fiche ${pilot.full_name}` };
  };

  const pending = data.users.filter((u) => (u.role ?? 'pilote') === 'pilote' && !u.pilot_id && u.user_id !== session.user.id);
  const freePilots = data.pilots.filter((p) => !linked.has(p.id));
  const users = data.users;
  const admins = users.filter((u) => u.role === 'admin');
  const blocked = users.filter((u) => access(u).level === 'blocked');
  const recent = users.filter((u) => u.last_sign_in_at && Date.now() - new Date(u.last_sign_in_at).getTime() < 7 * 86400000);
  const noAccount = data.pilots.filter((p) => p.active && !linked.has(p.id));
  const rows = users.filter((u) => !pending.includes(u) && (!q || `${u.email} ${u.pilot_name ?? ''}`.toLowerCase().includes(q.toLowerCase()))
    && (!roleFilter || (roleFilter === 'bloque' ? access(u).level === 'blocked' : (u.role ?? 'pilote') === roleFilter)))
    .sort((a, b) => (a.user_id === session.user.id ? -1 : b.user_id === session.user.id ? 1 : 0) || (a.role === b.role ? a.email.localeCompare(b.email) : a.role === 'admin' ? -1 : 1));

  return (
    <div className="users-page">
      <PageHeader title="Utilisateurs" subtitle="Comptes de connexion, rôles et rattachement aux fiches pilotes"
        actions={<button className="btn" onClick={() => setShowHelp(!showHelp)}><Icon name="book" size={15} /> {showHelp ? 'Masquer l\'aide' : 'Créer un compte · rôles'}</button>} />

      {showHelp && (
        <div className="users-help">
          <div className="uh-card">
            <span className="uh-icon"><Icon name="plus" size={18} /></span>
            <div><strong>Créer un compte</strong>
              <ol>
                <li>Supabase → <b>Authentication</b> → <b>Users</b> → <em>Add user</em>, cocher « Auto confirm ».</li>
                <li>Le compte apparaît ici avec le rôle <b>Pilote</b>.</li>
                <li>Reliez-le à sa <b>fiche pilote</b> : il accède alors aux données de son drone port.</li>
              </ol></div>
          </div>
          <div className="uh-card">
            <span className="uh-icon role-pilote"><Icon name="flight" size={18} /></span>
            <div><strong>Pilote</strong><p>Voit et saisit les données du drone port de sa fiche. Signe les visas CRM de ses vols (commandant de bord, copilote) et peut traiter, clôturer et viser les comptes rendus techniques de son drone port.</p></div>
          </div>
          <div className="uh-card">
            <span className="uh-icon role-admin"><Icon name="shield" size={18} /></span>
            <div><strong>Administrateur</strong><p>Voit tous les drone ports, gère les référentiels et les comptes, et peut rouvrir un vol clôturé (les visas du CRM sont alors annulés).</p></div>
          </div>
        </div>
      )}

      <div className="flight-kpis pl-kpis">
        <div className="fk"><span className="fk-icon"><Icon name="users" size={18} /></span><div><strong>{users.length}</strong><span>compte(s)</span></div></div>
        <div className="fk"><span className="fk-icon"><Icon name="shield" size={18} /></span><div><strong>{admins.length}</strong><span>administrateur(s)</span></div></div>
        <div className="fk fk-ok"><span className="fk-icon"><Icon name="clock" size={18} /></span><div><strong>{recent.length}</strong><span>connecté(s) cette semaine</span></div></div>
        <button type="button" className={`fk fk-action${blocked.length ? ' fk-danger' : ' fk-ok'}`} onClick={() => setRoleFilter(roleFilter === 'bloque' ? '' : 'bloque')}>
          <span className="fk-icon"><Icon name="alert" size={18} /></span><div><strong>{blocked.length}</strong><span>{blocked.length ? 'accès bloqué(s) à régulariser' : 'aucun accès bloqué'}</span></div></button>
        <div className={`fk${noAccount.length ? ' fk-warn' : ''}`}><span className="fk-icon"><Icon name="pen" size={18} /></span><div><strong>{noAccount.length}</strong><span>pilote(s) actif(s) sans compte</span></div></div>
      </div>

      {noAccount.length > 0 && (
        <div className="fk-note warn users-noacc">
          <Icon name="users" size={14} />
          <span>Pilotes sans compte de connexion : {noAccount.map((p) => <Link key={p.id} to={`/carnet/${p.id}`} className="users-chip">{p.full_name}</Link>)} — créez leur compte dans Supabase puis reliez-le ci-dessous.</span>
        </div>
      )}

      <ErrorBox error={error ?? loadError} />

      {pending.length > 0 && (
        <section className="signup-section">
          <div className="signup-section-head">
            <h2><Icon name="bell" size={16} /> Demandes d'inscription <span className="tabbed-count lv-warn">{pending.length}</span></h2>
            <span className="small muted">Ces comptes n'ont accès à aucune donnée tant qu'ils ne sont pas validés.</span>
          </div>
          <div className="signup-reqs">
            {pending.map((u) => <SignupRequest key={u.user_id} u={u} pilots={data.pilots} freePilots={freePilots} ports={ports} onDone={() => reload()} />)}
          </div>
        </section>
      )}

      <div className="card filters pl-filters">
        <label className="field field-grow"><span className="field-label">Recherche</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Email ou nom du pilote…" /></label>
        <div className="field pl-sort"><span className="field-label">Afficher</span>
          <div className="segmented segmented-sm">
            {([['', 'Tous'], ['admin', 'Administrateurs'], ['pilote', 'Pilotes'], ['bloque', 'Bloqués']] as const).map(([k, l]) => (
              <button key={k} type="button" className={roleFilter === k ? 'active' : ''} onClick={() => setRoleFilter(k)}>{l}</button>
            ))}
          </div></div>
      </div>

      <div className="accounts">
        {rows.map((u) => {
          const me = u.user_id === session.user.id;
          const a = access(u);
          const role = (u.role ?? 'pilote') as Role;
          const name = u.pilot_name ?? u.email;
          const last = ago(u.last_sign_in_at);
          const online = u.last_sign_in_at && Date.now() - new Date(u.last_sign_in_at).getTime() < 86400000;
          return (
            <article key={u.user_id} className={`account acc-${a.level}${me ? ' is-me' : ''}${saving === u.user_id ? ' is-saving' : ''}`}>
              <header className="acc-head">
                <span className="acc-avatar" style={{ ['--h' as string]: hue(name) }}>{initials(name)}{online && <i title="Connecté dans les dernières 24 h" />}</span>
                <div className="acc-id">
                  <strong>{u.pilot_name ?? u.email.split('@')[0]}{me && <span className="acc-me">vous</span>}</strong>
                  <span className="mono">{u.email}</span>
                </div>
                <span className={`acc-role role-${role}`}><Icon name={role === 'admin' ? 'shield' : 'flight'} size={12} /> {role === 'admin' ? 'Administrateur' : 'Pilote'}</span>
              </header>

              <div className={`acc-access lv-${a.level}`}>
                <Icon name={a.level === 'blocked' ? 'alert' : a.level === 'all' ? 'shield' : 'pin'} size={15} />
                <div><strong>{a.label}</strong><span>{a.hint}</span></div>
              </div>

              <div className="acc-controls">
                <div className="field"><span className="field-label">Rôle</span>
                  <div className="segmented segmented-sm" role="radiogroup" aria-label={`Rôle de ${u.email}`}>
                    {(['pilote', 'admin'] as const).map((r) => (
                      <button key={r} type="button" role="radio" aria-checked={role === r} className={role === r ? 'active' : ''} disabled={saving === u.user_id || role === r}
                        onClick={() => update(u, { role: r })}>{r === 'admin' ? 'Admin' : 'Pilote'}</button>
                    ))}
                  </div></div>
                <label className="field"><span className="field-label">Fiche pilote</span>
                  <select value={u.pilot_id ?? ''} disabled={saving === u.user_id} onChange={(e) => update(u, { pilot_id: e.target.value || null })}>
                    <option value="">— Aucune —</option>
                    {data.pilots.filter((p) => p.id === u.pilot_id || !linked.has(p.id)).map((p) => (
                      <option key={p.id} value={p.id}>{p.full_name}{p.drone_port_id ? '' : ' (sans drone port)'}{p.active ? '' : ' (inactif)'}</option>
                    ))}
                  </select></label>
              </div>

              <footer className="acc-foot small muted">
                <span>{last ? <>Dernière connexion {last}</> : 'Jamais connecté'}</span>
                <span>créé le {new Date(u.created_at).toLocaleDateString('fr-FR')}</span>
                {u.pilot_id && <Link to={`/carnet/${u.pilot_id}`}>Carnet →</Link>}
              </footer>
            </article>
          );
        })}
      </div>
    </div>
  );
}
