import { FormEvent, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const p2 = (n: number) => String(n).padStart(2, '0');
const hdgLabel = (d: number) => {
  const n = ((d % 360) + 360) % 360;
  return n === 0 ? 'N' : n === 90 ? 'E' : n === 180 ? 'S' : n === 270 ? 'W' : String(n / 10).padStart(2, '0');
};

/**
 * Écran de vol (PFD) décoratif : horizon artificiel qui suit la souris, bandes vitesse / altitude, cap.
 * Valeurs fictives (croisière Tango 4), aucune donnée réelle.
 */
function Pfd({ phase }: { phase: 'idle' | 'busy' | 'error' }) {
  const [t, setT] = useState(0);
  const [ptr, setPtr] = useState({ x: 0.5, y: 0.5 });
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t0 = performance.now();
    const still = reduceMotion();
    const id = window.setInterval(() => { if (!still) setT((performance.now() - t0) / 1000); setNow(new Date()); }, still ? 1000 : 80);
    const move = (e: PointerEvent) => { if (!still) setPtr({ x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight }); };
    window.addEventListener('pointermove', move);
    return () => { clearInterval(id); window.removeEventListener('pointermove', move); };
  }, []);

  const roll = (ptr.x - 0.5) * 24 + Math.sin(t / 4) * 3;
  const pitch = (0.5 - ptr.y) * 10 + Math.sin(t / 3.7) * 1.5;
  const hdg = 74 + Math.sin(t / 9) * 10 + roll * 0.4;
  const spd = 37 + Math.sin(t / 3.1) * 1.6;
  const alt = 2790 + Math.sin(t / 5.3) * 40;
  const vs = Math.cos(t / 5.3) * 40 * (60 / 5.3);
  const PX = 8; // px par degré de tangage

  return (
    <svg className={`lx-pfd phase-${phase}`} viewBox="-400 -450 800 900" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <defs>
        <linearGradient id="lxSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#030a1c" /><stop offset="1" stopColor="#1b4f96" /></linearGradient>
        <linearGradient id="lxGround" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4a3320" /><stop offset="1" stopColor="#0c0805" /></linearGradient>
        <clipPath id="lxSpd"><rect x="-345" y="-190" width="74" height="380" rx="6" /></clipPath>
        <clipPath id="lxAlt"><rect x="265" y="-190" width="84" height="380" rx="6" /></clipPath>
        <clipPath id="lxHdg"><rect x="-200" y="-418" width="400" height="44" rx="6" /></clipPath>
        <radialGradient id="lxVignette"><stop offset="0.55" stopColor="#000" stopOpacity="0" /><stop offset="1" stopColor="#000" stopOpacity="0.75" /></radialGradient>
      </defs>

      {/* horizon artificiel */}
      <g className="lx-horizon" style={{ transform: `rotate(${-roll}deg) translateY(${pitch * PX}px)` }}>
        <rect x="-1400" y="-1400" width="2800" height="1400" fill="url(#lxSky)" />
        <rect x="-1400" y="0" width="2800" height="1400" fill="url(#lxGround)" />
        <line x1="-1400" x2="1400" y1="0" y2="0" stroke="#e8f4ff" strokeWidth="2" />
        {[-20, -15, -10, -5, 5, 10, 15, 20].map((p) => {
          const y = -p * PX, w = p % 10 === 0 ? 70 : 34;
          return (
            <g key={p} className="lx-ladder">
              <line x1={-w} x2={w} y1={y} y2={y} />
              {p % 10 === 0 && <><text x={-w - 10} y={y + 5} textAnchor="end">{Math.abs(p)}</text><text x={w + 10} y={y + 5}>{Math.abs(p)}</text></>}
            </g>
          );
        })}
      </g>
      <rect x="-400" y="-450" width="800" height="900" fill="url(#lxVignette)" />

      {/* arc d'inclinaison */}
      <g className="lx-sym">
        <path d="M -199 -115 A 230 230 0 0 1 199 -115" fill="none" />
        {[-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60].map((a) => (
          <line key={a} x1="0" x2="0" y1="-230" y2={a % 30 === 0 ? -250 : -242} transform={`rotate(${a})`} />
        ))}
        <path d="M 0 -228 l -9 -14 h 18 z" className="lx-fill" />
        <g style={{ transform: `rotate(${-roll}deg)` }} className="lx-horizon"><path d="M 0 -226 l -10 16 h 20 z" className="lx-amber-fill" /></g>
      </g>

      {/* maquette avion */}
      <g className="lx-plane">
        <path d="M -150 0 H -62 L -40 22 M 150 0 H 62 L 40 22" />
        <rect x="-5" y="-5" width="10" height="10" />
      </g>

      {/* bande de vitesse (kt) */}
      <g className="lx-tape">
        <rect x="-345" y="-190" width="74" height="380" rx="6" />
        <g clipPath="url(#lxSpd)">
          <g transform={`translate(0 ${spd * 14})`}>
            {Array.from({ length: 31 }, (_, i) => 22 + i).map((v) => (
              <g key={v}>
                <line x1="-271" x2={v % 5 === 0 ? -287 : -279} y1={-v * 14} y2={-v * 14} />
                {v % 5 === 0 && <text x="-293" y={-v * 14 + 5} textAnchor="end">{v}</text>}
              </g>
            ))}
          </g>
        </g>
        <path d="M -352 -18 h 70 l 12 18 l -12 18 h -70 z" className="lx-box" />
        <text x="-292" y="8" textAnchor="end" className="lx-big">{Math.round(spd)}</text>
        <text x="-308" y="-206" textAnchor="middle" className="lx-unit">KT</text>
      </g>

      {/* bande d'altitude (ft) */}
      <g className="lx-tape">
        <rect x="265" y="-190" width="84" height="380" rx="6" />
        <g clipPath="url(#lxAlt)">
          <g transform={`translate(0 ${alt * 1.2})`}>
            {Array.from({ length: 31 }, (_, i) => 2500 + i * 20).map((v) => (
              <g key={v}>
                <line x1="265" x2={v % 100 === 0 ? 281 : 273} y1={-v * 1.2} y2={-v * 1.2} />
                {v % 100 === 0 && <text x="287" y={-v * 1.2 + 5}>{v}</text>}
              </g>
            ))}
          </g>
        </g>
        <path d="M 256 0 l 12 -18 h 88 v 36 h -88 z" className="lx-box" />
        <text x="276" y="8" className="lx-big">{Math.round(alt / 10) * 10}</text>
        <text x="307" y="-206" textAnchor="middle" className="lx-unit">FT</text>
        <text x="307" y="222" textAnchor="middle" className="lx-unit">{vs >= 0 ? '▲' : '▼'} {Math.abs(Math.round(vs / 10) * 10)} FPM</text>
      </g>

      {/* cap (descendu de 50 px pour rester visible quand l'écran est rogné) */}
      <g className="lx-tape" transform="translate(0 50)">
        <rect x="-200" y="-418" width="400" height="44" rx="6" />
        <g clipPath="url(#lxHdg)">
          <g transform={`translate(${-hdg * 5} 0)`}>
            {Array.from({ length: 49 }, (_, i) => i * 5).map((d) => (
              <g key={d}>
                <line x1={d * 5} x2={d * 5} y1="-374" y2={d % 10 === 0 ? -386 : -380} />
                {d % 30 === 0 && <text x={d * 5} y="-392" textAnchor="middle">{hdgLabel(d)}</text>}
              </g>
            ))}
          </g>
        </g>
        <path d="M -30 -446 h 60 v 24 h -22 l -8 8 l -8 -8 h -22 z" className="lx-box" />
        <text x="0" y="-428" textAnchor="middle" className="lx-mid">{String(Math.round(((hdg % 360) + 360) % 360)).padStart(3, '0')}°</text>
      </g>

      {/* bandeau d'état */}
      <g className="lx-status">
        <text x="-345" y="300">TANGO 4 · AUTO</text>
        <text x="-345" y="326" className="lx-dim">S 21°16′ · E 047°28′</text>
        <text x="345" y="300" textAnchor="end">{p2(now.getUTCHours())}:{p2(now.getUTCMinutes())}:{p2(now.getUTCSeconds())}Z</text>
        <text x="345" y="326" textAnchor="end" className="lx-dim">LOCAL {now.toLocaleTimeString('fr-FR', { timeZone: 'Indian/Antananarivo', hour: '2-digit', minute: '2-digit' })}</text>
        <text x="0" y="300" textAnchor="middle" className={`lx-flag lx-flag-${phase}`}>
          {phase === 'busy' ? 'CONTRÔLE ACCÈS…' : phase === 'error' ? 'ACCÈS REFUSÉ' : 'PRÊT · EN ATTENTE ÉQUIPAGE'}
        </text>
      </g>
    </svg>
  );
}

/** Check-list avant vol du formulaire de connexion */
function Checklist({ items }: { items: { label: string; ok: boolean; hint: string }[] }) {
  return (
    <ol className="lx-check" aria-label="Check-list de connexion">
      {items.map((it) => (
        <li key={it.label} className={it.ok ? 'ok' : ''}>
          <span className="lx-tick" aria-hidden>{it.ok ? '✓' : ''}</span>
          <span>{it.label}</span>
          <span className="lx-dots" aria-hidden />
          <span className="lx-state">{it.ok ? 'OK' : it.hint}</span>
        </li>
      ))}
    </ol>
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

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const phase = busy ? 'busy' : error ? 'error' : 'idle';

  return (
    <div className="lx">
      <aside className="lx-hud" aria-hidden>
        <Pfd phase={phase} />
        <div className="lx-hud-caption">
          <span className="lx-live" /> Flotte Tango 4 · livraisons médicales UNFPA · Madagascar
        </div>
      </aside>
      <main className="lx-side">
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
        <Checklist items={[
          { label: 'Identifiant', ok: emailOk, hint: 'à saisir' },
          { label: 'Mot de passe', ok: password.length > 0, hint: 'à saisir' },
          { label: 'Autorisation', ok: false, hint: busy ? 'contrôle…' : error ? 'refusée' : 'au décollage' },
        ]} />
        {notice && <div className="alert alert-ok">{notice}</div>}
        {error && <div className="alert alert-danger">{error}</div>}
        <button className={`btn btn-primary btn-block lx-go${emailOk && password ? ' armed' : ''}`} disabled={busy} style={{ height: 46 }}>
          <svg className="lx-prop" viewBox="-10 -10 20 20" aria-hidden>
            <g fill="currentColor">
              {[0, 120, 240].map((a) => <ellipse key={a} cx="0" cy="-5" rx="2.4" ry="5" transform={`rotate(${a})`} />)}
              <circle r="2.2" />
            </g>
          </svg>{busy ? 'Contrôle des accès…' : 'Se connecter'}
        </button>
        <p className="muted small login-switch">Pas encore de compte ? <button type="button" className="link-btn" onClick={() => { setNotice(null); setError(null); setMode('signup'); }}>Créer un compte pilote</button></p>
      </form>
      )}
      </main>
    </div>
  );
}
