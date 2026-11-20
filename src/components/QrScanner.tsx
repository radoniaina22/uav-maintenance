import { FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import jsQR from 'jsqr';
import { supabase } from '../lib/supabase';
import { Modal } from './ui';

/** Extrait un code pièce (3 lettres + chiffres) d'un texte scanné ou saisi. */
export function extractPartCode(text: string): string | null {
  const m = text.toUpperCase().match(/\b([A-Z]{3}\d{3,})\b/);
  return m ? m[1] : null;
}

/** Renvoie l'id de la pièce portant ce code, ou null si inconnue / hors de votre drone port. */
export async function findPartId(code: string): Promise<string | null> {
  const { data } = await supabase.from('v_parts').select('id').eq('code', code).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };

/**
 * Scanner de QR code pièce : caméra (BarcodeDetector natif, sinon décodage jsQR)
 * ou saisie / douchette USB (qui tape le code puis Entrée).
 */
export function QrScannerModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const video = useRef<HTMLVideoElement>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [camOn, setCamOn] = useState(false);
  const [manual, setManual] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const busy = useRef(false);

  async function resolve(text: string) {
    if (busy.current) return;
    const code = extractPartCode(text);
    if (!code) { setMsg(`« ${text.slice(0, 40)} » n'est pas un code pièce.`); return; }
    busy.current = true;
    setMsg(`Recherche de ${code}…`);
    const id = await findPartId(code);
    if (id) { onClose(); navigate(`/pieces/${id}`); return; }
    setMsg(`Pièce ${code} introuvable, ou non accessible depuis votre drone port.`);
    setTimeout(() => { busy.current = false; }, 1500);
  }

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    const detector = BD ? new BD({ formats: ['qr_code'] }) : null;

    async function tick() {
      if (stopped) return;
      const v = video.current;
      if (v && v.readyState >= 2 && !busy.current) {
        try {
          let text: string | null = null;
          if (detector) text = (await detector.detect(v))[0]?.rawValue ?? null;
          else if (ctx) {
            const w = Math.min(640, v.videoWidth), h = Math.round(v.videoHeight * (w / v.videoWidth));
            canvas.width = w; canvas.height = h;
            ctx.drawImage(v, 0, 0, w, h);
            text = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })?.data ?? null;
          }
          if (text) await resolve(text);
        } catch { /* image suivante */ }
      }
      raf = window.setTimeout(tick, 200);
    }

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setCamError("Caméra non disponible sur cet appareil ou ce navigateur."); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        if (video.current) { video.current.srcObject = stream; await video.current.play(); }
        setCamOn(true);
        tick();
      } catch {
        setCamError("Accès à la caméra refusé ou indisponible. Vous pouvez saisir le code ou utiliser une douchette.");
      }
    })();
    return () => { stopped = true; clearTimeout(raf); stream?.getTracks().forEach((t) => t.stop()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submit(e: FormEvent) { e.preventDefault(); busy.current = false; resolve(manual); }

  return (
    <Modal title="Scanner une pièce" onClose={onClose}>
      <div className="scanner">
        <div className={`scanner-view${camOn ? ' on' : ''}`}>
          <video ref={video} muted playsInline />
          {camOn ? <span className="scanner-frame" aria-hidden /> : <span className="small muted">{camError ?? 'Ouverture de la caméra…'}</span>}
        </div>
        <form onSubmit={submit} className="scanner-form">
          <label className="field field-grow"><span className="field-label">Code pièce (saisie ou douchette)</span>
            <input autoFocus value={manual} onChange={(e) => setManual(e.target.value)} placeholder="ex. MOV0023" />
          </label>
          <button className="btn btn-primary" type="submit">Ouvrir</button>
        </form>
        {msg && <p className="small muted" role="status">{msg}</p>}
      </div>
    </Modal>
  );
}
