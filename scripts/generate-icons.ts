/**
 * Generates the PWA icon set and favicon.
 *
 * Icons are produced from code rather than committed as opaque binaries so
 * the art direction stays in one place and the files are reproducible. The
 * mark is a flood gate: three horizontal bars with a waterline, in the
 * project's amber-on-slate palette.
 *
 * PNGs are written with a minimal encoder (zlib stored/deflate via
 * node:zlib) to avoid pulling in an image dependency for four files.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'public', 'pwa');

// Palette, matching src/ui/styles/tokens.css.
const SLATE: RGB = [0x0d, 0x15, 0x19];
const STEEL: RGB = [0x24, 0x34, 0x3b];
const AMBER: RGB = [0xe0, 0xa0, 0x3c];
const WATER: RGB = [0x4a, 0x6b, 0x68];

type RGB = [number, number, number];

/** Simple RGBA raster we can draw rectangles into. */
class Raster {
  readonly data: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    fill: RGB,
  ) {
    this.data = new Uint8Array(width * height * 4);
    this.fillRect(0, 0, width, height, fill, 1);
  }

  fillRect(x: number, y: number, w: number, h: number, colour: RGB, alpha = 1): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));

    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        const i = (py * this.width + px) * 4;
        // Source-over composite so translucent overlays read correctly.
        const a = alpha;
        this.data[i] = Math.round(colour[0] * a + this.data[i] * (1 - a));
        this.data[i + 1] = Math.round(colour[1] * a + this.data[i + 1] * (1 - a));
        this.data[i + 2] = Math.round(colour[2] * a + this.data[i + 2] * (1 - a));
        this.data[i + 3] = 255;
      }
    }
  }

  /** Encodes to a PNG buffer (8-bit RGBA, single IDAT). */
  toPng(): Buffer {
    // Each scanline is prefixed with filter type 0 (None).
    const stride = this.width * 4;
    const rawSize = (stride + 1) * this.height;
    const raw = Buffer.allocUnsafe(rawSize);

    for (let y = 0; y < this.height; y += 1) {
      const rowStart = y * (stride + 1);
      raw[rowStart] = 0;
      Buffer.from(this.data.buffer, y * stride, stride).copy(raw, rowStart + 1);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // colour type: RGBA
    ihdr[10] = 0; // compression: deflate
    ihdr[11] = 0; // filter method
    ihdr[12] = 0; // interlace: none

    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Draws the flood-gate mark.
 *
 * @param safeInset Fraction of the canvas kept clear at the edges. Maskable
 *   icons need ~10% so platform shape masks never crop the mark.
 */
function drawMark(size: number, safeInset: number): Raster {
  const r = new Raster(size, size, SLATE);

  const inset = size * safeInset;
  const boxX = inset;
  const boxY = inset;
  const boxW = size - inset * 2;
  const boxH = size - inset * 2;

  // Gate housing.
  r.fillRect(boxX, boxY, boxW, boxH, STEEL);

  // Standing water in the lower third.
  const waterY = boxY + boxH * 0.62;
  r.fillRect(boxX, waterY, boxW, boxY + boxH - waterY, WATER, 0.85);

  // Three gate bars, the top one raised (the gate is partially open).
  const barH = boxH * 0.11;
  const gap = boxH * 0.08;
  const barX = boxX + boxW * 0.14;
  const barW = boxW * 0.72;

  r.fillRect(barX, boxY + gap * 0.6, barW, barH, AMBER);
  r.fillRect(barX, boxY + gap * 0.6 + (barH + gap) * 1, barW, barH, AMBER);
  r.fillRect(barX, boxY + gap * 0.6 + (barH + gap) * 2, barW, barH, AMBER);

  // Waterline highlight.
  r.fillRect(boxX, waterY, boxW, Math.max(1, size * 0.012), AMBER, 0.9);

  return r;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const outputs: { file: string; raster: Raster }[] = [
    { file: 'icon-192.png', raster: drawMark(192, 0.08) },
    { file: 'icon-512.png', raster: drawMark(512, 0.08) },
    // Maskable icons need a larger safe area for platform shape masks.
    { file: 'icon-maskable-512.png', raster: drawMark(512, 0.18) },
    { file: 'apple-touch-icon.png', raster: drawMark(180, 0.08) },
  ];

  for (const { file, raster } of outputs) {
    await writeFile(join(OUT_DIR, file), raster.toPng());
    console.log(`wrote public/pwa/${file} (${raster.width}x${raster.height})`);
  }

  // Favicon as SVG: crisp at any size and a fraction of the bytes.
  const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#0d1519"/>
  <rect x="6" y="6" width="52" height="52" fill="#24343b"/>
  <rect x="6" y="38" width="52" height="20" fill="#4a6b68"/>
  <rect x="6" y="38" width="52" height="1.5" fill="#e0a03c"/>
  <rect x="13" y="10" width="38" height="6" fill="#e0a03c"/>
  <rect x="13" y="21" width="38" height="6" fill="#e0a03c"/>
  <rect x="13" y="32" width="38" height="6" fill="#e0a03c"/>
</svg>
`;
  await writeFile(join(OUT_DIR, 'favicon.svg'), favicon, 'utf8');
  console.log('wrote public/pwa/favicon.svg');
}

main().catch((err) => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});
