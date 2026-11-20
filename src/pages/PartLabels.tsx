import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { fetchAll, supabase } from '../lib/supabase';
import { useData } from '../lib/useData';
import type { PartRow } from '../lib/types';
import { Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { partQrValue, QrCode } from '../components/QrCode';
import { UavEmblem } from '../components/UavLogo';

type Size = 'xmini' | 'mini' | 'petit' | 'moyen' | 'grand';
const SIZES: Record<Size, { label: string; qr: number }> = {
  xmini: { label: 'Extra mini (20 × 10 mm) – code seul', qr: 34 },
  mini: { label: 'Mini (30 × 15 mm) – code seul', qr: 48 },
  petit: { label: 'Petite (40 × 25 mm)', qr: 72 },
  moyen: { label: 'Moyenne (60 × 35 mm)', qr: 104 },
  grand: { label: 'Grande (80 × 50 mm)', qr: 150 },
};

/** Planche d'étiquettes QR imprimable : ?ids=… ou ?codes=… (séparés par des virgules). */
export default function PartLabels() {
  const [params] = useSearchParams();
  const ids = (params.get('ids') ?? '').split(',').filter(Boolean);
  const codes = (params.get('codes') ?? '').split(',').filter(Boolean);
  const [size, setSize] = useState<Size>(() => (localStorage.getItem('uav.labelSize') as Size) || 'moyen');
  const [showSn, setShowSn] = useState(true);
  const [copies, setCopies] = useState(1);

  const { data, error, loading } = useData(async () => {
    if (!ids.length && !codes.length) return [] as PartRow[];
    const rows = await fetchAll<PartRow>((a, b) => {
      const q = supabase.from('v_parts').select('*');
      return (ids.length ? q.in('id', ids) : q.in('code', codes)).order('code').range(a, b);
    });
    return rows;
  }, [ids.join(), codes.join()]);

  const pickSize = (s: Size) => { setSize(s); try { localStorage.setItem('uav.labelSize', s); } catch { /* sans stockage */ } };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const parts = data ?? [];
  const codeOnly = size === 'mini' || size === 'xmini';
  const sheet = parts.flatMap((p) => Array.from({ length: copies }, (_, i) => ({ p, k: `${p.id}-${i}` })));

  return (
    <>
      <PageHeader title="Étiquettes QR" subtitle={`${parts.length} pièce(s) · ${sheet.length} étiquette(s) à imprimer`}
        actions={<>
          <Link className="btn" to="/pieces?onglet=inventaire">← Pièces</Link>
          <button className="btn btn-primary" disabled={!sheet.length} onClick={() => window.print()}>⎙ Imprimer</button>
        </>} />

      <div className="card filters no-print">
        <label className="field"><span className="field-label">Format</span>
          <select className="label-format" value={size} onChange={(e) => pickSize(e.target.value as Size)}>
            {(Object.keys(SIZES) as Size[]).map((s) => <option key={s} value={s}>{SIZES[s].label}</option>)}
          </select>
        </label>
        <label className="field"><span className="field-label">Exemplaires par pièce</span>
          <input type="number" min={1} max={10} value={copies} onChange={(e) => setCopies(Math.min(10, Math.max(1, Number(e.target.value) || 1)))} />
        </label>
        <label className="field checkbox-field"><input type="checkbox" disabled={codeOnly} checked={showSn} onChange={(e) => setShowSn(e.target.checked)} /> Afficher le n° de série</label>
      </div>
      <p className="small muted no-print">Le QR contient le code de la pièce. Scannez-le depuis <strong>Pièces → Scanner</strong> pour ouvrir directement sa fiche.</p>

      {parts.length === 0 ? <Empty>Aucune pièce sélectionnée.</Empty> : (
        <div className={`label-sheet label-${size}`}>
          {sheet.map(({ p, k }) => (
            <div key={k} className="part-label">
              <QrCode value={partQrValue(p.code)} size={SIZES[size].qr} />
              <div className="part-label-text">
                <strong className="part-label-code">{p.code}</strong>
                {!codeOnly && <>
                  <span>{p.type_name}</span>
                  {showSn && p.serial_number && <span>S/N {p.serial_number}</span>}
                  <span className="part-label-org"><UavEmblem size="1.25em" className="part-label-emblem" /> UAV Maintenance</span>
                </>}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
