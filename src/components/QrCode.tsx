import { useMemo } from 'react';
import QRCode from 'qrcode';

/** Contenu encodé dans le QR d'une pièce : son code seul (ex. MOV0023), lisible par n'importe quel lecteur. */
export const partQrValue = (code: string) => code;

function matrix(value: string) {
  const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
  return { size: qr.modules.size, data: qr.modules.data };
}

/** Chemin SVG (un carré par module), marge de 2 modules. */
function qrPath(value: string) {
  const { size, data } = matrix(value);
  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (data[y * size + x]) d += `M${x + 2} ${y + 2}h1v1h-1z`;
  }
  return { d, n: size + 4 };
}

/** QR code vectoriel : toujours noir sur blanc pour rester lisible par les scanners, même en thème sombre. */
export function QrCode({ value, size = 128, title }: { value: string; size?: number; title?: string }) {
  const { d, n } = useMemo(() => qrPath(value), [value]);
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" role="img" aria-label={title ?? `QR code ${value}`}>
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

function download(href: string, name: string) {
  const a = document.createElement('a');
  a.href = href; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}

export async function downloadQrPng(value: string, name = value) {
  download(await QRCode.toDataURL(value, { errorCorrectionLevel: 'M', margin: 2, width: 600 }), `${name}.png`);
}

export async function downloadQrSvg(value: string, name = value) {
  const svg = await QRCode.toString(value, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  download(url, `${name}.svg`);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
