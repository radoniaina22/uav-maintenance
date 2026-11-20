import { FormEvent, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

const ROUTE = 'M120 640 C 380 430, 520 660, 760 440 S 1160 170, 1380 270';

/** Décor animé : un drone suit une route de livraison entre des formations sanitaires */
function Scene() {
  return (
    <svg className="login-scene" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <defs>
        <linearGradient id="routeGrad" x1="0" x2="1">
          <stop offset="0" stopColor="#22d3ee" stopOpacity="0.1" />
          <stop offset="0.5" stopColor="#4f9cf9" stopOpacity="0.8" />
          <stop offset="1" stopColor="#6366f1" stopOpacity="0.2" />
        </linearGradient>
        <radialGradient id="droneGlow"><stop offset="0" stopColor="#22d3ee" stopOpacity="0.55" /><stop offset="1" stopColor="#22d3ee" stopOpacity="0" /></radialGradient>
      </defs>
      {Array.from({ length: 19 }, (_, i) => <line key={`v${i}`} className="login-grid" x1={i * 80} y1="0" x2={i * 80} y2="900" />)}
      {Array.from({ length: 12 }, (_, i) => <line key={`h${i}`} className="login-grid" x1="0" y1={i * 80} x2="1440" y2={i * 80} />)}
      <path className="login-route" d={ROUTE} />
      {[[120, 640], [760, 440], [1380, 270]].map(([x, y], i) => (
        <g key={i}>
          <circle className="login-csb" cx={x} cy={y} r="5" style={{ animationDelay: `${i * 0.6}s` }} />
          <circle cx={x} cy={y} r="16" fill="none" stroke="#22d3ee" strokeOpacity="0.25" />
        </g>
      ))}
      <g>
        <animateMotion dur="16s" repeatCount="indefinite" rotate="auto" path={ROUTE} keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.45 0 0.55 1" />
        <circle r="46" fill="url(#droneGlow)" />
        <g stroke="#e8eef9" strokeWidth="2" strokeLinecap="round" fill="none">
          <path d="M-18 0 H18" />
          <path d="M-4 -26 V26" strokeWidth="2.5" />
          <path d="M-10 -9 H6 M-10 9 H6" />
          <circle cx="-10" cy="-9" r="5" strokeOpacity="0.6" />
          <circle cx="-10" cy="9" r="5" strokeOpacity="0.6" />
          <circle cx="6" cy="-9" r="5" strokeOpacity="0.6" />
          <circle cx="6" cy="9" r="5" strokeOpacity="0.6" />
        </g>
      </g>
    </svg>
  );
}

/** Force du mot de passe (0 à 4) */
function strength(p: string) {
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
  if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) s++;
  return Math.min(4, s);
}
const STRENGTH = ['Trop faible', 'Faible', 'Moyen', 'Bon', 'Excellent'];

/** Formulaire d'inscription : le compte créé est toujours un compte Pilote, en attente de validation */
function SignupForm({ onDone, onCancel }: { onDone: (email: string, needsConfirm: boolean) => void; onCancel: () => void }) {
  const [f, setF] = useState({ full_name: '', email: '', phone: '', license: '', port: '', password: '', confirm: '', message: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ports, setPorts] = useState<{ id: string; name: string }[]>([]);
  const set = (k: keyof typeof f, v: string) => setF((cur) => ({ ...cur, [k]: v }));
  useEffect(() => {
    supabase.rpc('signup_ports').then(({ data }) => setPorts((data ?? []) as { id: string; name: string }[]));
  }, []);
  const st = strength(f.password);
  const mismatch = f.confirm !== '' && f.confirm !== f.password;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (f.password.length < 8) return setError('Le mot de passe doit contenir au moins 8 caractères.');
    if (mismatch) return setError('Les deux mots de passe ne correspondent pas.');
    setBusy(true);
    setError(null);
    const port = ports.find((p) => p.id === f.port);
    const { data, error } = await supabase.auth.signUp({
      email: f.email.trim(), password: f.password,
      options: {
        emailRedirectTo: `${window.location.origin}${window.location.pathname}`,
        data: {
          full_name: f.full_name.trim(), phone: f.phone.trim() || null, license_number: f.license.trim() || null,
          requested_port_id: port?.id ?? null, requested_port_name: port?.name ?? null, message: f.message.trim() || null,
        },
      },
    });
    setBusy(false);
    if (error) {
      const m = error.message;
      return setError(/already registered|already exists/i.test(m) ? 'Un compte existe déjà avec cet email : connectez-vous.'
        : /signups not allowed|disabled/i.test(m) ? 'Les inscriptions sont désactivées : demandez un compte à l\'administrateur.'
        : /password/i.test(m) ? `Mot de passe refusé : ${m}` : m);
    }
    onDone(f.email.trim(), !data.session);
  }

  return (
    <form className="login-card card signup-card" onSubmit={submit}>
      <div className="brand">
        <div className="brand-logo"><img src="./favicon.svg" alt="" width={34} height={34} /></div>
        <div>
          <div className="brand-title" style={{ background: 'var(--grad)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>UAV Maintenance</div>
          <div className="brand-sub">Tango 4 · UNFPA Madagascar</div>
        </div>
      </div>
      <div>
        <div className="login-title">Rejoindre <span>l'équipage.</span></div>
        <p className="muted">{ports.length ? 'Votre demande sera validée par un administrateur, qui vous rattachera à votre drone port.' : "Créez le compte administrateur de l'application."}</p>
        {ports.length > 0 && <span className="signup-role"><span>✈</span> Rôle du compte : <strong>Pilote</strong> <em>(par défaut)</em></span>}
      </div>
      <div className="signup-grid">
        <label className="field signup-wide"><span className="field-label">Nom complet <span className="req">*</span></span>
          <input required autoComplete="name" value={f.full_name} onChange={(e) => set('full_name', e.target.value)} placeholder="Prénom Nom" /></label>
        <label className="field signup-wide"><span className="field-label">Email <span className="req">*</span></span>
          <input type="email" required autoComplete="email" value={f.email} onChange={(e) => set('email', e.target.value)} placeholder="prenom.nom@exemple.org" /></label>
        <label className="field"><span className="field-label">Téléphone</span>
          <input type="tel" autoComplete="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+261 …" /></label>
        <label className="field"><span className="field-label">N° de licence / brevet</span>
          <input value={f.license} onChange={(e) => set('license', e.target.value)} placeholder="facultatif" /></label>
        {ports.length === 0 ? (
          <div className="signup-first signup-wide">🚀 <span><strong>Premier compte de l'application</strong> : aucun drone port n'existe encore. Ce compte sera automatiquement <strong>administrateur</strong> ; vous créerez ensuite les drone ports, les drones et les pilotes.</span></div>
        ) : (
        <label className="field signup-wide"><span className="field-label">Drone port d'affectation souhaité <span className="req">*</span></span>
          <select required value={f.port} onChange={(e) => set('port', e.target.value)}>
            <option value="">— Choisir —</option>
            {ports.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>
        )}
        <label className="field"><span className="field-label">Mot de passe <span className="req">*</span></span>
          <input type="password" required minLength={8} autoComplete="new-password" value={f.password} onChange={(e) => set('password', e.target.value)} /></label>
        <label className="field"><span className="field-label">Confirmation <span className="req">*</span></span>
          <input type="password" required autoComplete="new-password" value={f.confirm} onChange={(e) => set('confirm', e.target.value)} className={mismatch ? 'is-invalid' : ''} /></label>
        {f.password && (
          <div className={`signup-strength s-${st} signup-wide`}>
            <span className="ss-bar">{[0, 1, 2, 3].map((i) => <i key={i} className={i < st ? 'on' : ''} />)}</span>
            <span>{STRENGTH[st]}{f.password.length < 8 ? ' · 8 caractères minimum' : ''}</span>
          </div>
        )}
        {ports.length > 0 && <label className="field signup-wide"><span className="field-label">Message pour l'administrateur</span>
          <textarea rows={2} value={f.message} onChange={(e) => set('message', e.target.value)} placeholder="ex. formé sur Tango 4 en octobre, copilote à Port Nord…" /></label>}
      </div>
      {error && <div className="alert alert-danger">{error}</div>}
      <button className="btn btn-primary btn-block" disabled={busy || mismatch} style={{ height: 44 }}>{busy ? 'Envoi…' : ports.length ? 'Créer mon compte pilote' : 'Créer le compte administrateur'}</button>
      <p className="muted small login-switch">Déjà un compte ? <button type="button" className="link-btn" onClick={onCancel}>Se connecter</button></p>
    </form>
  );
}

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message === 'Invalid login credentials' ? 'Email ou mot de passe incorrect.'
      : /not confirmed/i.test(error.message) ? 'Email non confirmé : cliquez sur le lien reçu par email.' : error.message);
    setBusy(false);
  }

  return (
    <div className="center-screen login-bg">
      <Scene />
      <div className="login-orb" style={{ width: 380, height: 380, left: '8%', top: '12%', background: '#6366f1' }} />
      <div className="login-orb" style={{ width: 320, height: 320, right: '10%', bottom: '8%', background: '#0891b2', animationDelay: '-4s' }} />
      {mode === 'signup' ? (
        <SignupForm onCancel={() => setMode('login')}
          onDone={(mail, needsConfirm) => {
            setEmail(mail);
            setMode('login');
            setNotice(needsConfirm
              ? `Compte créé. Confirmez votre adresse en cliquant sur le lien envoyé à ${mail}, puis connectez-vous.`
              : 'Compte créé : votre demande est en attente de validation par un administrateur.');
          }} />
      ) : (
      <form className="login-card card" onSubmit={submit}>
        <div className="brand">
          <div className="brand-logo"><img src="./favicon.svg" alt="" width={34} height={34} /></div>
          <div>
            <div className="brand-title" style={{ background: 'var(--grad)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>UAV Maintenance</div>
            <div className="brand-sub">Tango 4 · UNFPA Madagascar</div>
          </div>
        </div>
        <div>
          <div className="login-title">Bon retour <span>à bord.</span></div>
          <p className="muted">Suivi technique de la flotte de livraison par drone.</p>
          <div className="login-features"><span>Vols & carnets</span><span>Visites 250 h</span><span>Pièces & stock</span><span>Vent en altitude</span></div>
        </div>
        <label className="field">
          <span className="field-label">Email</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="prenom.nom@exemple.org" />
        </label>
        <label className="field">
          <span className="field-label">Mot de passe</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {notice && <div className="alert alert-ok">{notice}</div>}
        {error && <div className="alert alert-danger">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={busy} style={{ height: 44 }}>{busy ? 'Connexion…' : 'Se connecter'}</button>
        <p className="muted small login-switch">Pas encore de compte ? <button type="button" className="link-btn" onClick={() => { setNotice(null); setError(null); setMode('signup'); }}>Créer un compte pilote</button></p>
      </form>
      )}
    </div>
  );
}
