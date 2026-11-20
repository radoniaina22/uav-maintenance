import { FormEvent, useState } from 'react';
import { supabase, unwrap } from '../lib/supabase';
import type { TechnicalReport } from '../lib/types';
import ReportFields, { draftToPayload, emptyReport, reportToDraft } from './ReportFields';
import { ErrorBox, Modal } from './ui';

/** Création / modification d'un rapport technique ou incident pour un vol. */
export default function ReportModal({ flightId, report, onClose, onSaved }: {
  flightId: string;
  report?: TechnicalReport | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(report ? reportToDraft(report) : emptyReport());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft.description.trim()) return setError('La description est obligatoire.');
    setBusy(true);
    setError(null);
    try {
      const payload = draftToPayload(draft);
      if (report) unwrap(await supabase.from('technical_reports').update(payload).eq('id', report.id));
      else unwrap(await supabase.from('technical_reports').insert({ ...payload, flight_id: flightId }));
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={report ? 'Modifier le rapport' : 'Nouveau rapport technique / incident'}
      onClose={onClose}
      footer={<>
        <button className="btn" type="button" onClick={onClose}>Annuler</button>
        <button className="btn btn-primary" form="report-form" disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button>
      </>}
    >
      <form id="report-form" onSubmit={submit}>
        <ReportFields value={draft} onChange={setDraft} />
        <ErrorBox error={error} />
      </form>
    </Modal>
  );
}
