import { useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { byPort, useApp } from '../lib/app';
import { useData } from '../lib/useData';
import type { LogbookRow, PilotStatsRow } from '../lib/types';
import { date, hours, minutes, num, time } from '../lib/format';
import { Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import UavLogo from '../components/UavLogo';
import PilotCockpit from '../components/PilotCockpit';

export default function Logbook() {
  const { pilotId: routeId } = useParams();
  const { pilot: me, isAdmin, portFilter } = useApp();
  const nav = useNavigate();
  const pilotId = routeId ?? me?.id ?? '';
  const [year, setYear] = useState('');

  // Admin : liste des pilotes pour le sélecteur
  const pilots = useData(async () => (isAdmin
    ? unwrap(await byPort(supabase.from('pilots').select('id, full_name, active, drone_port_id'), portFilter).order('full_name')) as { id: string; full_name: string; active: boolean }[]
    : []), [isAdmin, portFilter]);

  const { data, error, loading } = useData(async () => {
    if (!pilotId) return null;
    const [stats, entries] = await Promise.all([
      supabase.from('v_pilot_stats').select('*').eq('id', pilotId).maybeSingle(),
      supabase.from('v_logbook').select('*').eq('pilot_id', pilotId)
        .order('entry_date', { ascending: false }).order('takeoff_time', { ascending: false }).order('created_at', { ascending: false }),
    ]);
    return { stats: unwrap(stats) as PilotStatsRow | null, entries: unwrap(entries) as LogbookRow[] };
  }, [pilotId]);

  if (!isAdmin && routeId && routeId !== me?.id) return <Navigate to="/carnet" replace />;

  const entries = (data?.entries ?? []).filter((e) => !year || e.entry_date.startsWith(year));
  const years = Array.from(new Set((data?.entries ?? []).map((e) => e.entry_date.slice(0, 4)))).sort().reverse();
  const p = data?.stats;

  return (
    <>
      <div className="logbook-screen">
      <PageHeader
        title={<>Carnet de vol{p ? ` – ${p.full_name}` : ''}</>}
        subtitle={p ? <>{p.drone_port_name ?? 'Sans drone port'}{p.license_number ? ` · Licence ${p.license_number}` : ''} · les heures sont inscrites à la clôture de chaque vol</> : 'Heures de vol des pilotes'}
        actions={<>
          {isAdmin && (
            <select className="select-inline" value={pilotId} onChange={(e) => nav(e.target.value ? `/carnet/${e.target.value}` : '/carnet')} aria-label="Pilote">
              <option value="">— Choisir un pilote —</option>
              {pilots.data?.map((x) => <option key={x.id} value={x.id}>{x.full_name}{x.active ? '' : ' (inactif)'}</option>)}
            </select>
          )}
          {p && <button className="btn no-print" onClick={() => window.print()}>⎙ Imprimer le carnet</button>}
        </>}
      />

      {!pilotId ? (
        <Empty>{isAdmin ? 'Choisissez un pilote pour afficher son carnet de vol.' : "Votre compte n'est pas relié à une fiche pilote."}</Empty>
      ) : loading && !data ? <Loading /> : error ? <ErrorBox error={error} /> : !p ? (
        <Empty>Pilote introuvable ou non accessible.</Empty>
      ) : (
        <PilotCockpit pilot={p} all={data!.entries} entries={entries} year={year} years={years} setYear={setYear} />
      )}
      </div>
      {p && <LogbookPrint pilot={p} entries={entries} year={year} />}
    </>
  );
}

/** Feuille imprimable du carnet de vol (invisible à l'écran). */
function LogbookPrint({ pilot: p, entries, year }: { pilot: PilotStatsRow; entries: LogbookRow[]; year: string }) {
  // ordre chronologique, comme un carnet papier
  const rows = [...entries].reverse();
  const first = rows[0];
  const carried = first ? Number(first.cumulative_hours) - Number(first.duration_min) / 60 : null;
  const periodMin = rows.reduce((s, e) => s + Number(e.duration_min), 0);
  const picMin = rows.filter((e) => e.role === 'pilote').reduce((s, e) => s + Number(e.duration_min), 0);
  const copMin = periodMin - picMin;
  const deliveries = rows.filter((e) => e.flight_type === 'livraison').length;
  const now = new Date();
  const period = year ? `Année ${year}` : rows.length ? `Du ${date(rows[0].entry_date)} au ${date(rows[rows.length - 1].entry_date)}` : 'Aucun vol';
  const ref = `CV-${p.full_name.normalize('NFD').replace(/[^A-Za-z]/g, '').slice(0, 6).toUpperCase()}-${year || now.getFullYear()}`;
  const hm = (m: number) => `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')}`;

  return (
    <article className="logbook-print" aria-hidden>
      <header className="lb-head">
        <UavLogo className="lb-logo lb-logo-uav" />
        <div className="lb-title">
          <div className="lb-org">UNFPA Madagascar · Livraison par drones</div>
          <h1>Carnet de vol pilote</h1>
          <div className="lb-sub">Drones VTOL Tango 4 · Relevé des heures de vol</div>
        </div>
        <dl className="lb-ref">
          <div><dt>Référence</dt><dd>{ref}</dd></div>
          <div><dt>Période</dt><dd>{period}</dd></div>
          <div><dt>Édité le</dt><dd>{now.toLocaleDateString('fr-FR')}</dd></div>
        </dl>
      </header>

      <section className="lb-id">
        <div><span>Pilote</span><strong>{p.full_name}</strong></div>
        <div><span>N° de licence</span><strong>{p.license_number ?? '—'}</strong></div>
        <div><span>Drone port</span><strong>{p.drone_port_name ?? '—'}</strong></div>
        <div><span>Dernier vol</span><strong>{date(p.last_flight_date)}</strong></div>
      </section>

      <section className="lb-kpis">
        <div><span>Heures totales (cumul)</span><strong>{hours(p.total_hours)}</strong></div>
        <div><span>Report antérieur</span><strong>{carried != null ? `${num(carried, 1)} h` : '—'}</strong></div>
        <div><span>Heures de la période</span><strong>{hm(periodMin)}</strong></div>
        <div><span>Commandant de bord</span><strong>{hm(picMin)}</strong></div>
        <div><span>Copilote</span><strong>{hm(copMin)}</strong></div>
        <div><span>Vols · livraisons</span><strong>{rows.length} · {deliveries}</strong></div>
      </section>

      <table className="lb-table">
        <thead>
          <tr>
            <th className="c">N°</th><th>Date</th><th>Aéronef</th><th>Type de vol</th><th>Destination</th>
            <th className="c">Départ</th><th className="c">Arrivée</th><th className="r">Durée</th><th className="c">Fonction</th><th className="r">Cumul</th>
          </tr>
        </thead>
        <tbody>
          {carried != null && (
            <tr className="lb-carry"><td colSpan={9}>Report des heures antérieures</td><td className="r">{num(carried, 1)} h</td></tr>
          )}
          {rows.map((e, i) => (
            <tr key={e.id}>
              <td className="c lb-muted">{i + 1}</td>
              <td className="nowrap">{date(e.entry_date)}</td>
              <td><strong>{e.drone_code ?? '—'}</strong></td>
              <td>{e.flight_type === 'controle' ? 'Contrôle' : 'Livraison'}</td>
              <td>{e.destination_name ?? '—'}</td>
              <td className="c">{time(e.takeoff_time)}</td>
              <td className="c">{time(e.landing_time)}</td>
              <td className="r nowrap">{minutes(e.duration_min)}</td>
              <td className="c">{e.role === 'pilote' ? 'CdB' : 'COP'}</td>
              <td className="r nowrap"><strong>{num(e.cumulative_hours, 1)} h</strong></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={10} className="c lb-muted">Aucun vol clôturé sur la période.</td></tr>}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={7}>Total de la période · {rows.length} vol(s)</td>
            <td className="r nowrap">{hm(periodMin)}</td>
            <td />
            <td className="r nowrap">{rows.length ? `${num(rows[rows.length - 1].cumulative_hours, 1)} h` : '—'}</td>
          </tr>
        </tfoot>
      </table>
      <p className="lb-legend">CdB : commandant de bord · COP : copilote · Heures inscrites à la clôture de chaque vol dans UAV Maintenance.</p>

      <section className="lb-sign">
        <div>
          <span>Le pilote</span>
          <p>Je certifie l'exactitude des inscriptions portées sur ce carnet.</p>
          <div className="lb-sign-line">Nom : <strong>{p.full_name}</strong></div>
          <div className="lb-sign-line">Date :</div>
          <div className="lb-sign-box">Signature</div>
        </div>
        <div>
          <span>Visa du responsable des opérations</span>
          <p>Vérifié et certifié conforme aux enregistrements de vol.</p>
          <div className="lb-sign-line">Nom :</div>
          <div className="lb-sign-line">Date :</div>
          <div className="lb-sign-box">Signature et cachet</div>
        </div>
      </section>

      <footer className="lb-foot">
        <span>{ref} · Carnet de vol de {p.full_name}</span>
        <span>UAV Maintenance · UNFPA Madagascar</span>
      </footer>
    </article>
  );
}