import { FormEvent, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { byPort, useApp } from '../lib/app';
import { useData } from '../lib/useData';
import type { Pilot, PilotStatsRow } from '../lib/types';
import { date, hours, num, toNum, toStr } from '../lib/format';
import { addDays, daysBetween, iso } from '../lib/stats';
import { milestoneProgress } from '../lib/milestones';
import { Empty, ErrorBox, Field, Loading, Modal, PageHeader } from '../components/ui';
import { Icon } from '../components/icons';
import { ChoiceCards, FormSection } from '../components/FormKit';

const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join('') || '?';
/** Teinte d'avatar stable dérivée du nom */
const hue = (s: string) => Math.round(([...s].reduce((h, c) => h + c.charCodeAt(0) * 7, 0) * 137.508) % 360);

/** Récence : jours depuis le dernier vol */
type Recency = 'actif' | 'surveiller' | 'reprise' | 'jamais';
const RECENCY: Record<Recency, { label: string; desc: string }> = {
  actif: { label: 'En activité', desc: 'a volé dans les 30 derniers jours' },
  surveiller: { label: 'À surveiller', desc: 'aucun vol depuis plus de 30 jours' },
  reprise: { label: 'Remise en main', desc: 'aucun vol depuis plus de 90 jours' },
  jamais: { label: 'Aucun vol', desc: 'pas encore de vol enregistré' },
};
function recency(last: string | null, today: string): Recency {
  if (!last) return 'jamais';
  const d = daysBetween(last, today);
  return d <= 30 ? 'actif' : d <= 90 ? 'surveiller' : 'reprise';
}

const WEEKS = 12;

// ---------------------------------------------------------------------
// Fenêtre de création / modification
// ---------------------------------------------------------------------
function PilotModal({ pilot, onClose, onSaved }: { pilot: (Pilot & Partial<PilotStatsRow>) | null; onClose: () => void; onSaved: () => void }) {
  const { ports, portFilter } = useApp();
  const [f, setF] = useState({
    full_name: pilot?.full_name ?? '',
    license_number: pilot?.license_number ?? '',
    phone: pilot?.phone ?? '',
    active: pilot?.active ?? true,
    maintenance_lead: pilot?.maintenance_lead ?? false,
    drone_port_id: pilot ? pilot.drone_port_id ?? '' : portFilter,
    initial_hours: pilot ? String(Number(pilot.initial_flight_minutes) / 60) : '0',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((cur) => ({ ...cur, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const payload = {
      full_name: f.full_name.trim(), license_number: toStr(f.license_number), phone: toStr(f.phone), active: f.active, maintenance_lead: f.maintenance_lead,
      drone_port_id: toStr(f.drone_port_id),
      initial_flight_minutes: Math.round((toNum(f.initial_hours) ?? 0) * 600) / 10,
    };
    try {
      if (pilot) unwrap(await supabase.from('pilots').update(payload).eq('id', pilot.id));
      else unwrap(await supabase.from('pilots').insert(payload));
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  // ---- aperçu
  const oldInitial = pilot ? Number(pilot.initial_flight_minutes) / 60 : 0;
  const newInitial = toNum(f.initial_hours) ?? 0;
  const total = Number(pilot?.total_hours ?? 0) - oldInitial + newInitial;
  const ms = milestoneProgress(total);
  const portName = ports.find((p) => p.id === f.drone_port_id)?.name;
  const name = f.full_name.trim() || 'Nom du pilote';
  const warnings: string[] = [];
  if (pilot && (pilot.drone_port_id ?? '') !== f.drone_port_id) warnings.push(`Changement de drone port : le pilote verra désormais les données de ${portName ?? 'aucun drone port'} et ne pourra plus signer les CRM de l'ancien.`);
  if (pilot && pilot.active && !f.active) warnings.push('Un pilote inactif n\'est plus proposé dans les nouveaux vols. Son historique est conservé.');
  if (pilot && Math.abs(newInitial - oldInitial) > 0.05) warnings.push(`Le total d'heures passe de ${hours(pilot.total_hours ?? oldInitial)} à ${hours(total)}.`);
  if (!f.drone_port_id) warnings.push('Sans drone port, le pilote ne voit aucune donnée.');

  return (
    <Modal title={pilot ? `Modifier ${pilot.full_name}` : 'Nouveau pilote'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Annuler</button><button className="btn btn-primary" form="pilot-form" disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button></>}>
      <div className="bm">
        <form id="pilot-form" className="bm-form" onSubmit={submit}>
          <FormSection n={1} icon="users" title="Identité">
            <div className="form-grid">
              <Field label="Nom complet" required wide><input required value={f.full_name} onChange={(e) => set('full_name', e.target.value)} placeholder="Prénom Nom" /></Field>
              <Field label="N° de licence / brevet"><input className="mono" value={f.license_number} onChange={(e) => set('license_number', e.target.value)} placeholder="ex. MDG-UAS-0042" /></Field>
              <Field label="Téléphone"><input type="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+261 …" /></Field>
            </div>
          </FormSection>
          <FormSection n={2} icon="pin" title="Drone port" hint="détermine les données visibles et les CRM à signer">
            <div className="bm-packs">
              <button type="button" className={`bm-pack${!f.drone_port_id ? ' active' : ''}`} onClick={() => set('drone_port_id', '')}><strong>Non affecté</strong></button>
              {ports.filter((p) => p.active !== false || p.id === f.drone_port_id).map((p) => (
                <button key={p.id} type="button" className={`bm-pack${f.drone_port_id === p.id ? ' active' : ''}`} onClick={() => set('drone_port_id', p.id)}><strong>{p.name}</strong></button>
              ))}
            </div>
          </FormSection>
          <FormSection n={3} icon="shield" title="Statut">
            <ChoiceCards label="Statut" value={f.active ? 'on' : 'off'} onChange={(v) => set('active', v === 'on')} options={[
              { value: 'on', label: 'Actif', desc: 'peut être affecté aux vols', icon: 'flight', tone: 'ok' },
              { value: 'off', label: 'Inactif', desc: 'historique conservé, plus proposé', icon: 'box', tone: 'neutral' },
            ]} />
            <label className={`pl-lead${f.maintenance_lead ? ' active' : ''}`}>
              <input type="checkbox" checked={f.maintenance_lead} onChange={(e) => set('maintenance_lead', e.target.checked)} />
              <span className="pl-lead-icon"><Icon name="wrench" size={16} /></span>
              <span><strong>Responsable maintenance</strong><small>Signe et clôture les ordres de travail de son drone port. Plusieurs pilotes peuvent avoir cette qualification.</small></span>
            </label>
          </FormSection>
          <FormSection n={4} icon="book" title="Carnet de vol">
            <Field label="Heures de vol antérieures" hint="heures déjà au carnet avant l'utilisation du logiciel">
              <input type="number" step="0.1" min="0" value={f.initial_hours} onChange={(e) => set('initial_hours', e.target.value)} />
            </Field>
          </FormSection>
          <ErrorBox error={error} />
        </form>

        <aside className="bm-aside">
          <span className="pd-kicker">Aperçu</span>
          <div className="pl-preview" style={{ ['--h' as string]: hue(name) }}>
            <span className="pl-avatar">{initials(name)}</span>
            <div>
              <strong>{name}</strong>
              <span className="mono">{f.license_number || 'licence non renseignée'}</span>
              <span>{portName ?? 'non affecté'}</span>
            </div>
          </div>
          <span className="pl-pills"><span className={`fk-pill tone-${f.active ? 'ok' : 'neutral'}`}>{f.active ? 'Actif' : 'Inactif'}</span>{f.maintenance_lead && <span className="fk-pill tone-warn">🔧 Resp. maintenance</span>}</span>
          <div className="fk-kv"><span>Heures totales</span><b>{hours(total)}</b></div>
          {pilot && <div className="fk-kv"><span>dont vols suivis</span><b>{hours(Number(pilot.total_hours ?? 0) - oldInitial)}</b></div>}
          <div className="bm-meter">
            <div className="row-between small"><span>Prochain palier</span><b>{ms.next} h</b></div>
            <div className="pb-bar"><i style={{ width: `${ms.pct}%` }} /></div>
            <span className="small muted">reste {hours(ms.remaining)}</span>
          </div>
          {pilot && !pilot.has_account && <div className="fk-note info"><Icon name="users" size={14} /> Pas encore de compte de connexion : un administrateur peut lui en créer un.</div>}
          {warnings.length > 0 && <ul className="bm-warn">{warnings.map((w) => <li key={w}><Icon name="alert" size={13} /> {w}</li>)}</ul>}
        </aside>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Page Pilotes : l'équipage
// ---------------------------------------------------------------------
export default function Pilots() {
  const { portFilter, isAdmin } = useApp();
  const [modal, setModal] = useState<{ pilot: PilotStatsRow | null } | null>(null);
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [sort, setSort] = useState<'heures' | 'recent' | 'nom'>('heures');
  const todayIso = iso(new Date());

  const { data, error, loading, reload } = useData(async () => {
    const since = addDays(todayIso, -(WEEKS * 7 - 1));
    const [stats, flights] = await Promise.all([
      byPort(supabase.from('v_pilot_stats').select('*'), portFilter).order('full_name'),
      byPort(supabase.from('v_flights').select('id, flight_date, duration_min'), portFilter).gte('flight_date', since).limit(5000),
    ]);
    const fl = (unwrap(flights) ?? []) as { id: string; flight_date: string; duration_min: number | null }[];
    const crew = fl.length
      ? (unwrap(await supabase.from('flight_pilots').select('flight_id, pilot_id, role').in('flight_id', fl.map((x) => x.id))) ?? []) as { flight_id: string; pilot_id: string; role: string }[]
      : [];
    return { pilots: unwrap(stats) as PilotStatsRow[], flights: fl, crew };
  }, [portFilter]);

  // activité récente par pilote : heures par semaine (12 semaines), vols sur 30 jours
  const activity = useMemo(() => {
    const m = new Map<string, { weeks: number[]; f30: number; h30: number }>();
    if (!data) return m;
    const byId = new Map(data.flights.map((x) => [x.id, x]));
    const start = addDays(todayIso, -(WEEKS * 7 - 1));
    for (const c of data.crew) {
      const fl = byId.get(c.flight_id);
      if (!fl) continue;
      const a = m.get(c.pilot_id) ?? { weeks: Array(WEEKS).fill(0), f30: 0, h30: 0 };
      const w = Math.min(WEEKS - 1, Math.floor(daysBetween(start, fl.flight_date) / 7));
      const h = Number(fl.duration_min ?? 0) / 60;
      a.weeks[w] += h;
      if (daysBetween(fl.flight_date, todayIso) < 30) { a.f30++; a.h30 += h; }
      m.set(c.pilot_id, a);
    }
    return m;
  }, [data, todayIso]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const all = data.pilots;
  const active = all.filter((p) => p.active);
  const rows = all
    .filter((p) => (showInactive || p.active) && (!q || `${p.full_name} ${p.license_number ?? ''} ${p.drone_port_name ?? ''}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => sort === 'nom' ? a.full_name.localeCompare(b.full_name)
      : sort === 'recent' ? (b.last_flight_date ?? '').localeCompare(a.last_flight_date ?? '')
      : Number(b.total_hours) - Number(a.total_hours));
  const teamHours = active.reduce((s, p) => s + Number(p.total_hours), 0);
  const flying = active.filter((p) => recency(p.last_flight_date, todayIso) === 'actif').length;
  const toWatch = active.filter((p) => ['surveiller', 'reprise'].includes(recency(p.last_flight_date, todayIso)));
  const noAccount = active.filter((p) => !p.has_account).length;
  const toClose = all.reduce((s, p) => s + p.open_flight_count, 0);
  const maxWeek = Math.max(0.5, ...[...activity.values()].flatMap((a) => a.weeks));

  return (
    <div className="pilots-page">
      <PageHeader title="Pilotes" subtitle="L'équipage · heures = antérieures + vols clôturés · récence = jours depuis le dernier vol"
        actions={isAdmin && <button className="btn btn-primary" onClick={() => setModal({ pilot: null })}>+ Nouveau pilote</button>} />

      <div className="flight-kpis pl-kpis">
        <div className="fk"><span className="fk-icon"><Icon name="users" size={18} /></span>
          <div><strong>{active.length}</strong><span>pilote(s) actif(s){all.length > active.length ? ` · ${all.length - active.length} inactif(s)` : ''}</span></div></div>
        <div className="fk fk-ok"><span className="fk-icon"><Icon name="flight" size={18} /></span>
          <div><strong>{flying}</strong><span>en activité (vol &lt; 30 j)</span></div></div>
        <div className={`fk${toWatch.length ? ' fk-warn' : ''}`}><span className="fk-icon"><Icon name="clock" size={18} /></span>
          <div><strong>{toWatch.length}</strong><span>{toWatch.length ? `sans vol depuis 30 j · ${toWatch.slice(0, 2).map((p) => p.full_name.split(' ')[0]).join(', ')}${toWatch.length > 2 ? '…' : ''}` : 'tout l\'équipage vole régulièrement'}</span></div></div>
        <div className="fk"><span className="fk-icon"><Icon name="book" size={18} /></span>
          <div><strong>{hours(teamHours)}</strong><span>heures cumulées de l'équipage</span></div></div>
        {isAdmin && <div className={`fk${noAccount || toClose ? ' fk-warn' : ''}`}><span className="fk-icon"><Icon name="pen" size={18} /></span>
          <div><strong>{toClose}</strong><span>vol(s) à clôturer{noAccount ? ` · ${noAccount} pilote(s) sans compte` : ''}</span></div></div>}
      </div>

      <div className="card filters pl-filters">
        <label className="field field-grow"><span className="field-label">Recherche</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nom, licence, drone port…" /></label>
        <div className="field pl-sort"><span className="field-label">Tri</span>
          <div className="segmented segmented-sm" role="tablist">
            {([['heures', 'Heures'], ['recent', 'Dernier vol'], ['nom', 'Nom']] as const).map(([k, l]) => (
              <button key={k} type="button" className={sort === k ? 'active' : ''} onClick={() => setSort(k)}>{l}</button>
            ))}
          </div>
        </div>
        <label className="check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Afficher les inactifs</label>
      </div>

      {rows.length === 0 ? <Empty>Aucun pilote{q ? ' pour cette recherche' : ' enregistré'}.</Empty> : (
        <div className="crew">
          {rows.map((p) => {
            const rec = recency(p.last_flight_date, todayIso);
            const act = activity.get(p.id);
            const ms = milestoneProgress(Number(p.total_hours));
            const pic = Number(p.pic_hours), cop = Number(p.copilot_hours);
            const picPct = pic + cop > 0 ? (100 * pic) / (pic + cop) : 0;
            const since = p.last_flight_date ? daysBetween(p.last_flight_date, todayIso) : null;
            return (
              <article key={p.id} className={`crew-card rec-${rec}${p.active ? '' : ' is-off'}`} style={{ ['--h' as string]: hue(p.full_name) }}>
                <header className="crew-head">
                  <span className="pl-avatar">{initials(p.full_name)}</span>
                  <div className="crew-id">
                    <strong>{p.full_name}</strong>
                    <span>{p.drone_port_name ?? <span className="text-warn">Non affecté</span>}{p.license_number ? <> · <span className="mono">{p.license_number}</span></> : ''}</span>
                  </div>
                  <span className="crew-tags">{p.maintenance_lead && <span className="crew-lead" title="Responsable maintenance : signe les ordres de travail">🔧 Resp. maint.</span>}<span className={`crew-rec rec-${rec}`} title={RECENCY[rec].desc}>{p.active ? RECENCY[rec].label : 'Inactif'}</span></span>
                </header>

                <div className="crew-hours">
                  <div><b>{num(Number(p.total_hours), 1)}</b><span>heures</span></div>
                  <div><b>{num(p.flight_count, 0)}</b><span>vols</span></div>
                  <div><b>{act?.f30 ?? 0}</b><span>vols · 30 j</span></div>
                </div>

                <div className="crew-ms">
                  <div className="row-between small"><span className="muted">Palier {ms.next} h</span><span>reste <b>{hours(ms.remaining)}</b></span></div>
                  <div className="rank-ms-track"><span style={{ width: `${ms.pct}%` }} /></div>
                </div>

                <div className="crew-split" title={`Commandant de bord ${hours(pic)} · copilote ${hours(cop)}`}>
                  <span className="crew-split-bar"><i style={{ width: `${picPct}%` }} /></span>
                  <span className="small muted">CdB {hours(pic)} · copilote {hours(cop)}</span>
                </div>

                <div className="crew-spark" aria-label={`Heures par semaine sur ${WEEKS} semaines`}>
                  {(act?.weeks ?? Array(WEEKS).fill(0)).map((h, i) => (
                    <i key={i} style={{ height: `${h > 0 ? Math.max(14, Math.sqrt(h / maxWeek) * 100) : 4}%` }} className={h > 0 ? 'on' : ''} title={`Semaine ${i + 1 - WEEKS === 0 ? 'en cours' : `S${i + 1 - WEEKS}`} : ${num(h, 1)} h`} />
                  ))}
                </div>

                <footer className="crew-foot">
                  <span className="small muted">
                    {since == null ? 'jamais volé' : since === 0 ? 'a volé aujourd\'hui' : `dernier vol ${date(p.last_flight_date)} (${since} j)`}
                    {p.open_flight_count > 0 && <span className="text-warn"> · {p.open_flight_count} à clôturer</span>}
                    {isAdmin && !p.has_account && <span className="text-warn"> · sans compte</span>}
                  </span>
                  <span className="crew-actions">
                    <Link className="btn btn-sm" to={`/carnet/${p.id}`}><Icon name="book" size={13} /> Carnet</Link>
                    {isAdmin && <button className="btn btn-sm btn-ghost" onClick={() => setModal({ pilot: p })}>Modifier</button>}
                  </span>
                </footer>
              </article>
            );
          })}
        </div>
      )}
      {modal && <PilotModal pilot={modal.pilot} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
    </div>
  );
}
