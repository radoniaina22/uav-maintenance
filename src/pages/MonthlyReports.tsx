import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase, unwrap } from '../lib/supabase';
import { useApp } from '../lib/app';
import { useData } from '../lib/useData';
import { download, toCsv } from '../lib/stats';
import { elementToPdf } from '../lib/localArchive';
import {
  AdminReport, AnyReport, csvRows, DeliveryReport, fileBase, isMonth, monthLabel, MonthlyReportRow, previousMonth, REPORT_KINDS,
  REPORT_RPC, ReportKind, shiftMonth, snapshotChanges, TechReport,
} from '../lib/monthlyReports';
import { date } from '../lib/format';
import { AdminReportView, DeliveryReportView, TechReportView } from '../components/MonthlyReportViews';
import ReportRecipients from '../components/ReportRecipients';
import { describeResults, invokeSend } from '../lib/reportMail';
import { ErrorBox, Field, Loading, PageHeader, PortSelect } from '../components/ui';
import { Icon } from '../components/icons';

/** Rapports mensuels : consultation, impression, export PDF / CSV (calculés à la demande en base) */
export default function MonthlyReports() {
  const { isAdmin, ports, portFilter, setPortFilter, myPort } = useApp();
  const [params, setParams] = useSearchParams();
  const kinds = REPORT_KINDS.filter((k) => isAdmin || !k.adminOnly);
  const kindParam = params.get('type') as ReportKind | null;
  const kind: ReportKind = kinds.some((k) => k.key === kindParam) ? kindParam! : 'pilotes';
  // onglet « Destinataires e-mail » (administrateur)
  const showRecipients = isAdmin && params.get('type') === 'destinataires';
  const month = isMonth(params.get('mois')) ? params.get('mois')! : previousMonth();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const sheet = useRef<HTMLDivElement>(null);

  const set = (patch: Record<string, string>) => setParams((p) => {
    const n = new URLSearchParams(p);
    Object.entries(patch).forEach(([k, v]) => n.set(k, v));
    return n;
  }, { replace: true });

  // pilote : toujours son drone port ; administrateur : filtre global (vide = tous les ports)
  const port = kind === 'pilotes' ? (isAdmin ? portFilter || null : myPort?.id ?? null) : null;

  const { data, error, loading } = useData(async () => {
    const args = kind === 'pilotes' ? { p_month: `${month}-01`, p_port: port } : { p_month: `${month}-01` };
    return unwrap(await supabase.rpc(REPORT_RPC[kind], args)) as AnyReport;
  }, [kind, month, port]);

  // rapport UNFPA : état de validation du mois et historique des derniers mois
  const validation = useData(async () => {
    if (kind !== 'unfpa') return null;
    const [row, history] = await Promise.all([
      supabase.from('monthly_reports').select('*').eq('kind', 'unfpa').eq('month', `${month}-01`).maybeSingle()
        .then((r) => unwrap(r) as MonthlyReportRow | null),
      supabase.from('monthly_reports').select('month, status').eq('kind', 'unfpa').order('month', { ascending: false }).limit(12)
        .then((r) => unwrap(r) as Pick<MonthlyReportRow, 'month' | 'status'>[]),
    ]);
    return { row, history };
  }, [kind, month]);
  const vRow = kind === 'unfpa' && validation.data?.row?.month.startsWith(month) ? validation.data.row : null;

  const live = data && data.kind === kind && data.period.month === month ? data : null;
  // rapport validé : on affiche les chiffres figés à la validation
  const frozen = vRow?.status === 'valide' ? vRow.snapshot : null;
  const report: AnyReport | null = frozen ?? live;
  const portName = kind === 'pilotes' ? (ports.find((p) => p.id === port)?.name ?? null) : null;

  async function exportPdf() {
    const el = sheet.current?.querySelector<HTMLElement>('.mr-sheet');
    if (!el || !report) return;
    setBusy(true); setActionError(null);
    try {
      const blob = await elementToPdf(el, '.mr-block, tr');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${fileBase(report, portName)}.pdf`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function exportCsv() {
    if (!report) return;
    const rows = csvRows(report);
    if (!rows.length) { setActionError('Rien à exporter pour ce mois.'); return; }
    setActionError(null);
    download(`${fileBase(report, portName)}.csv`, toCsv(rows));
  }

  const csvLabel = kind === 'unfpa' ? 'CSV des CSB' : kind === 'admin' ? 'CSV par CSB' : 'CSV de la flotte';

  const tabs = kinds.length > 1 && (
    <div className="tabs" role="tablist">
      {kinds.map((k) => (
        <button key={k.key} role="tab" aria-selected={!showRecipients && kind === k.key} className={`tab${!showRecipients && kind === k.key ? ' active' : ''}`} onClick={() => set({ type: k.key })}>
          {k.label}
        </button>
      ))}
      {isAdmin && (
        <button role="tab" aria-selected={showRecipients} className={`tab${showRecipients ? ' active' : ''}`} onClick={() => set({ type: 'destinataires' })}>
          Destinataires e-mail
        </button>
      )}
    </div>
  );

  if (showRecipients) {
    return (
      <div className="mr-page">
        <PageHeader title="Rapports mensuels" subtitle="Destinataires des rapports envoyés par e-mail." />
        {tabs}
        <ReportRecipients />
      </div>
    );
  }

  return (
    <div className="mr-page">
      <div className="no-print">
        <PageHeader
          title="Rapports mensuels"
          subtitle="Calculés à partir des données de l'application. Le rapport UNFPA se valide ici ; l'envoi automatique par e-mail (le 1er du mois à 07h00) viendra dans une prochaine étape."
          actions={<>
            <button className="btn" onClick={() => window.print()} disabled={!report}><Icon name="book" size={16} /> Imprimer</button>
            <button className="btn" onClick={exportCsv} disabled={!report}><Icon name="box" size={16} /> {csvLabel}</button>
            <button className="btn btn-primary" onClick={exportPdf} disabled={!report || busy}><Icon name="box" size={16} /> {busy ? 'Création du PDF…' : 'Télécharger le PDF'}</button>
          </>}
        />

        {tabs}

        <div className="card filter-row">
          <Field label="Mois">
            <div className="mr-month-picker">
              <button type="button" className="btn btn-ghost btn-sm" aria-label="Mois précédent" onClick={() => set({ mois: shiftMonth(month, -1) })}><Icon name="chevronLeft" size={16} /></button>
              <input type="month" value={month} max={shiftMonth(previousMonth(), 1)} onChange={(e) => isMonth(e.target.value) && set({ mois: e.target.value })} />
              <button type="button" className="btn btn-ghost btn-sm" aria-label="Mois suivant" onClick={() => set({ mois: shiftMonth(month, 1) })}><Icon name="chevronRight" size={16} /></button>
            </div>
          </Field>
          {kind === 'pilotes' && (isAdmin ? (
            <Field label="Drone port">
              <PortSelect value={portFilter} onChange={setPortFilter} ports={ports} emptyLabel="Tous les drone ports" />
            </Field>
          ) : (
            <Field label="Drone port"><input value={myPort?.name ?? ''} readOnly /></Field>
          ))}
          <p className="muted small mr-kind-hint">{REPORT_KINDS.find((k) => k.key === kind)!.hint} · {monthLabel(month)}</p>
        </div>

        <ErrorBox error={error ?? validation.error ?? actionError} />

        {kind === 'unfpa' && validation.data && (
          <ValidationPanel
            month={month} row={vRow} history={validation.data.history}
            live={live as DeliveryReport | null}
            onChanged={validation.reload} onPickMonth={(m) => set({ mois: m })}
          />
        )}
      </div>

      {(loading || validation.loading) && !report ? <Loading /> : report && (
        <div ref={sheet} className={`mr-sheet-wrap${loading ? ' viz-refetch' : ''}`}>
          {report.kind === 'pilotes' && <TechReportView r={report as TechReport} />}
          {report.kind === 'admin' && <AdminReportView r={report as AdminReport} />}
          {report.kind === 'unfpa' && <DeliveryReportView r={report as DeliveryReport} validation={vRow} />}
        </div>
      )}
    </div>
  );
}

/** Validation du rapport UNFPA : commentaire « faits marquants », validation (chiffres figés), réouverture */
function ValidationPanel({ month, row, history, live, onChanged, onPickMonth }: {
  month: string; row: MonthlyReportRow | null; history: Pick<MonthlyReportRow, 'month' | 'status'>[];
  live: DeliveryReport | null; onChanged: () => void; onPickMonth: (m: string) => void;
}) {
  const validated = row?.status === 'valide';
  const ended = month <= previousMonth();
  const [comment, setComment] = useState(row?.comment ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [sent, setSent] = useState<string[] | null>(null);
  // le commentaire suit le mois affiché
  useEffect(() => { setComment(row?.comment ?? ''); setSaved(false); setErr(null); }, [row?.id, row?.comment, month]);
  useEffect(() => { setSent(null); }, [month]);

  const changes = validated && row?.snapshot && live ? snapshotChanges(row.snapshot, live) : [];
  const dirty = (comment.trim() || null) !== (row?.comment ?? null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null); setSaved(false); setSent(null);
    try { await fn(); onChanged(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const saveComment = () => run(async () => {
    unwrap(await supabase.rpc('save_monthly_report_comment', { p_kind: 'unfpa', p_month: `${month}-01`, p_comment: comment }));
    setSaved(true);
  });
  /** Envoi du rapport validé à la liste UNFPA (après validation, ou renvoi) */
  async function sendToUnfpa() {
    try {
      const r = await invokeSend({ mode: 'send', kind: 'unfpa', month: `${month}-01` });
      setSent(describeResults(r));
    } catch (e) {
      setErr(`Rapport validé, mais l'envoi a échoué : ${e instanceof Error ? e.message : String(e)}. Utilisez « Renvoyer à l'équipe UNFPA ».`);
    }
  }
  const validate = () => run(async () => {
    const { count } = await supabase.from('flights').select('id', { count: 'exact', head: true })
      .eq('status', 'ouvert').gte('flight_date', `${month}-01`).lt('flight_date', `${shiftMonth(month, 1)}-01`);
    const warn = count ? `\n\nAttention : ${count} vol(s) du mois sont encore ouverts. Ils sont comptés tels quels.` : '';
    if (!window.confirm(`Valider le rapport UNFPA de ${monthLabel(month)} ?\n\nLes chiffres seront figés tels qu'affichés, puis le rapport sera envoyé par e-mail à l'équipe UNFPA.${warn}`)) return;
    unwrap(await supabase.rpc('validate_monthly_report', { p_kind: 'unfpa', p_month: `${month}-01`, p_comment: comment }));
    await sendToUnfpa();
  });
  const resend = () => run(async () => {
    if (!window.confirm(`Renvoyer le rapport UNFPA de ${monthLabel(month)} à toute la liste des destinataires ?`)) return;
    await sendToUnfpa();
  });
  const reopen = () => run(async () => {
    if (!window.confirm(`Rouvrir le rapport UNFPA de ${monthLabel(month)} ?\n\nLes chiffres figés seront abandonnés et recalculés à partir des données actuelles.`)) return;
    unwrap(await supabase.rpc('reopen_monthly_report', { p_kind: 'unfpa', p_month: `${month}-01` }));
  });

  return (
    <section className={`card mr-validation${validated ? ' is-validated' : ''}`}>
      <div className="row-between">
        <div>
          <h2 className="card-title">Validation du rapport · {monthLabel(month)}</h2>
          <p className="muted small">
            {validated
              ? <>Validé le {date(row!.validated_at)}{row!.validated_by_name ? ` par ${row!.validated_by_name}` : ''} : les chiffres affichés sont figés.</>
              : ended ? 'Brouillon : les chiffres sont recalculés à chaque ouverture. Validez pour les figer (l\'envoi à l\'équipe UNFPA se fera à la validation).'
                : 'Mois en cours : la validation sera possible à partir du 1er du mois suivant.'}
          </p>
        </div>
        <span className={`badge badge-${validated ? 'ok' : 'neutral'}`}>{validated ? 'Validé' : 'Brouillon'}</span>
      </div>

      {changes.length > 0 && (
        <div className="alert alert-warn">
          <strong>Les données ont changé depuis la validation.</strong> Rouvrez puis validez à nouveau pour mettre le rapport à jour.
          <ul>{changes.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      )}

      <Field label="Faits marquants (affichés en tête du rapport)" wide>
        <textarea rows={3} value={comment} disabled={validated || busy} maxLength={2000}
          placeholder="Ex. : forte demande à Ikongo, 2 jours sans vol à cause du cyclone, nouveau CSB desservi…"
          onChange={(e) => { setComment(e.target.value); setSaved(false); }} />
      </Field>

      <div className="mr-validation-actions">
        {!validated && <button className="btn" onClick={saveComment} disabled={busy || !dirty}>Enregistrer le commentaire</button>}
        {!validated && <button className="btn btn-primary" onClick={validate} disabled={busy || !ended}>Valider et figer les chiffres</button>}
        {validated && <button className="btn" onClick={resend} disabled={busy}>Renvoyer à l'équipe UNFPA</button>}
        {validated && <button className="btn" onClick={reopen} disabled={busy}>Rouvrir le rapport</button>}
        {saved && <span className="small muted">Commentaire enregistré.</span>}
      </div>
      {sent && <div className="alert alert-ok">{sent.length === 1 ? sent[0] : <ul>{sent.map((l) => <li key={l}>{l}</li>)}</ul>}</div>}
      <ErrorBox error={err} />

      {history.length > 0 && (
        <div className="mr-history">
          <span className="small muted">Historique :</span>
          {history.map((h) => (
            <button key={h.month} type="button" className={`chip${h.month.startsWith(month) ? ' active' : ''}`} onClick={() => onPickMonth(h.month.slice(0, 7))}>
              {monthLabel(h.month.slice(0, 7))} · {h.status === 'valide' ? '✓ validé' : 'brouillon'}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
