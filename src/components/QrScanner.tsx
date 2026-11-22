import { RefObject, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { supabase } from '../lib/supabase';

/** Extrait un code pièce (3 lettres + chiffres) d'un texte scanné ou saisi. */
export function extractPartCode(text: string): string | null {
  if (extractDroneCode(text)) return null;
  const m = text.toUpperCase().match(/\b([A-Z]{3}\d{3,})\b/);
  return m ? m[1] : null;
}

/** Contenu du QR d'un drone : « DRONE:<code> » (ex. DRONE:MAL2), distinct des codes pièce. */
export const droneQrValue = (code: string) => `DRONE:${code}`;
export function extractDroneCode(text: string): string | null {
  const m = text.trim().match(/^DRONE:(.+)$/i);
  return m ? m[1].trim() : null;
}

/** Renvoie l'id de la pièce portant ce code (ou cet ancien code), ou null si inconnue / hors de votre drone port. */
export async function findPartId(code: string): Promise<string | null> {
  const { data } = await supabase.from('v_parts').select('id').or(`code.eq.${code},legacy_code.eq.${code}`).limit(1).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
type TorchCaps = MediaTrackCapabilities & { torch?: boolean };

/**
 * Caméra arrière + lecture de QR code en continu (BarcodeDetector natif, sinon jsQR).
 * `onText` n'est appelé que lorsque `active` est vrai ; la lampe torche est proposée si le téléphone la gère.
 */
export function useQrCamera(video: RefObject<HTMLVideoElement>, active: boolean, onText: (text: string) => void) {
  const [camOn, setCamOn] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torch, setTorch] = useState(false);
  const track = useRef<MediaStreamTrack | null>(null);
  const cb = useRef(onText);
  const on = useRef(active);
  cb.current = onText;
  on.current = active;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    const detector = BD ? new BD({ formats: ['qr_code'] }) : null;

    async function tick() {
      if (stopped) return;
      const v = video.current;
      if (v && v.readyState >= 2 && on.current) {
        try {
          let text: string | null = null;
          if (detector) text = (await detector.detect(v))[0]?.rawValue ?? null;
          else if (ctx) {
            const w = Math.min(640, v.videoWidth), h = Math.round(v.videoHeight * (w / v.videoWidth));
            canvas.width = w; canvas.height = h;
            ctx.drawImage(v, 0, 0, w, h);
            text = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })?.data ?? null;
          }
          if (text && on.current) cb.current(text);
        } catch { /* image suivante */ }
      }
      timer = window.setTimeout(tick, 200);
    }

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setCamError('Caméra non disponible sur cet appareil ou ce navigateur.'); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        track.current = stream.getVideoTracks()[0] ?? null;
        setTorchAvailable(Boolean((track.current?.getCapabilities?.() as TorchCaps | undefined)?.torch));
        if (video.current) { video.current.srcObject = stream; await video.current.play(); }
        setCamOn(true);
        tick();
      } catch {
        setCamError('Accès à la caméra refusé ou indisponible. Vous pouvez saisir le code ou utiliser une douchette.');
      }
    })();
    return () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); track.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTorch = async () => {
    const t = track.current;
    if (!t) return;
    try {
      await t.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] });
      setTorch(!torch);
    } catch { setTorchAvailable(false); }
  };

  return { camOn, camError, torchAvailable, torch, toggleTorch };
}

/** Retour de lecture : vibration courte et bip (si le navigateur l'autorise). */
export function scanFeedback(ok = true) {
  try { navigator.vibrate?.(ok ? 60 : [40, 60, 40]); } catch { /* sans vibreur */ }
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ac = new AC();
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = ok ? 1320 : 330;
    g.gain.setValueAtTime(0.08, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.12);
    o.connect(g).connect(ac.destination);
    o.start(); o.stop(ac.currentTime + 0.13);
    o.onended = () => { void ac.close(); };
  } catch { /* audio indisponible */ }
}
