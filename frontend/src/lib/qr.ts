/**
 * The Neurai-styled QR code for a Connect pairing URI.
 *
 * Adapted from the renderer in `neurai-relay`'s demo, kept to the single style
 * the faucet uses. Two rules decide whether a code still scans, and both are
 * why the numbers below are what they are:
 *
 * - **The logo covers modules**, so the code must carry enough redundancy to
 *   lose them: error correction `Q` plus a hole of 20% of the side, which stays
 *   clear of the alignment patterns a decoder needs to find its sampling grid.
 * - **Contrast is what a camera reads.** Modules stay near-black on white in
 *   both themes — an inverted code is refused by many scanners — and the brand
 *   orange is used only on the three finder patterns, which are big enough to
 *   survive the lower contrast.
 */

import QRCode from 'qrcode';

const DARK = '#111827';
const LIGHT = '#ffffff';
const EYE = '#9a3412';
const LOGO_SRC = '/logo.png';
/** Quiet zone. The standard asks for 4 modules; the white plate around the canvas adds the rest. */
const QUIET_MODULES = 2;
const LOGO_RATIO = 0.2;

let logoPromise: Promise<HTMLImageElement> | undefined;

function loadLogo(): Promise<HTMLImageElement> {
  logoPromise ??= new Promise((resolve, reject) => {
    const img = new Image();
    img.addEventListener('load', () => resolve(img));
    img.addEventListener('error', () => reject(new Error(`could not load ${LOGO_SRC}`)));
    img.src = LOGO_SRC;
  });
  return logoPromise;
}

/** Rounded rectangle drawn without `roundRect`, so older Safari copes. */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, side: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + side - r, y);
  ctx.quadraticCurveTo(x + side, y, x + side, y + r);
  ctx.lineTo(x + side, y + side - r);
  ctx.quadraticCurveTo(x + side, y + side, x + side - r, y + side);
  ctx.lineTo(x + r, y + side);
  ctx.quadraticCurveTo(x, y + side, x, y + side - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** The centred square of modules the logo sits on. Odd, so it is centred on a module. */
function holeRange(count: number): { from: number; to: number } {
  const span = Math.max(5, Math.round(count * LOGO_RATIO) | 1);
  const from = Math.floor((count - span) / 2);
  return { from, to: from + span - 1 };
}

/**
 * Draws `text` into `canvas`. Resolves once the logo is painted, so a caller
 * that measures or screenshots the canvas sees the finished code.
 */
export async function renderQr(canvas: HTMLCanvasElement, text: string, cssSize = 260): Promise<void> {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'Q' });
  const count = qr.modules.size;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);

  canvas.width = Math.round(cssSize * dpr);
  canvas.height = canvas.width;
  canvas.style.width = `${cssSize}px`;
  canvas.style.height = `${cssSize}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const module = canvas.width / (count + QUIET_MODULES * 2);
  const origin = QUIET_MODULES * module;

  ctx.fillStyle = LIGHT;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const hole = holeRange(count);
  // The finder patterns and the logo hole are drawn separately, so the generic
  // pass must not fight the shapes painted for them.
  const isFinder = (r: number, c: number) =>
    (r < 7 && c < 7) || (r < 7 && c >= count - 7) || (r >= count - 7 && c < 7);
  const inHole = (r: number, c: number) => r >= hole.from && r <= hole.to && c >= hole.from && c <= hole.to;

  ctx.fillStyle = DARK;
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (!qr.modules.get(r, c) || isFinder(r, c) || inHole(r, c)) continue;
      ctx.beginPath();
      ctx.arc(origin + c * module + module / 2, origin + r * module + module / 2, module * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (const [row, col] of [[0, 0], [0, count - 7], [count - 7, 0]]) {
    const x = origin + col * module;
    const y = origin + row * module;
    ctx.fillStyle = EYE;
    roundRectPath(ctx, x, y, 7 * module, 7 * module * 0.28);
    ctx.fill();
    ctx.fillStyle = LIGHT;
    roundRectPath(ctx, x + module, y + module, 5 * module, 5 * module * 0.28);
    ctx.fill();
    ctx.fillStyle = EYE;
    roundRectPath(ctx, x + 2 * module, y + 2 * module, 3 * module, 3 * module * 0.28);
    ctx.fill();
  }

  const plate = origin + hole.from * module;
  const plateSide = (hole.to - hole.from + 1) * module;
  ctx.fillStyle = LIGHT;
  roundRectPath(ctx, plate, plate, plateSide, plateSide * 0.22);
  ctx.fill();
  try {
    const logo = await loadLogo();
    const inset = plateSide * 0.1;
    ctx.drawImage(logo, plate + inset, plate + inset, plateSide - inset * 2, plateSide - inset * 2);
  } catch {
    // No logo: the white plate alone is still a valid, scannable code.
  }
}
