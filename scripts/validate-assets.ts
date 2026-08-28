/**
 * Asset and content validation.
 *
 * Runs in CI before the Pages deploy. Its job is to fail the build for the
 * classes of problem that are invisible in a typecheck but fatal at runtime
 * or legally: a referenced file that does not exist, an asset with no licence
 * record, an oversized texture, or an uncompressed audio blob in the runtime
 * folder.
 *
 * Exits non-zero on any error. Warnings are reported but do not fail.
 */

import { readdir, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_ASSETS = join(ROOT, 'public', 'assets');
const PUBLIC_PWA = join(ROOT, 'public', 'pwa');
const CONTENT_DIR = join(ROOT, 'content');
const LICENSE_MANIFEST = join(ROOT, 'ASSET_LICENSES.md');

/** Texture edge length that should never appear in a runtime asset. */
const MAX_TEXTURE_EDGE = 4096;
/** Largest single runtime file we accept without an explicit justification. */
const MAX_RUNTIME_FILE_BYTES = 12 * 1024 * 1024;
/** Uncompressed audio above this size in the runtime folder is a mistake. */
const MAX_WAV_BYTES = 256 * 1024;

const errors: string[] = [];
const warnings: string[] = [];

function error(message: string): void {
  errors.push(message);
}

function warn(message: string): void {
  warnings.push(message);
}

/** Recursively lists files, tolerating a missing directory. */
async function listFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runtime asset checks
// ---------------------------------------------------------------------------

async function checkRuntimeAssets(): Promise<void> {
  const files = await listFiles(PUBLIC_ASSETS);

  if (files.length === 0) {
    // Not an error yet: assets arrive with the world-building milestones.
    warn('public/assets contains no files yet');
    return;
  }

  for (const file of files) {
    const rel = relative(ROOT, file);
    const ext = extname(file).toLowerCase();
    const info = await stat(file);

    if (info.size === 0) {
      error(`${rel} is empty (0 bytes)`);
      continue;
    }

    if (info.size > MAX_RUNTIME_FILE_BYTES) {
      error(
        `${rel} is ${formatBytes(info.size)}, above the ${formatBytes(
          MAX_RUNTIME_FILE_BYTES,
        )} runtime budget`,
      );
    }

    if (ext === '.wav' && info.size > MAX_WAV_BYTES) {
      error(
        `${rel} is an uncompressed WAV of ${formatBytes(
          info.size,
        )}; convert to a compressed runtime format`,
      );
    }

    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
      const dims = await readImageSize(file);
      if (dims) {
        if (dims.width > MAX_TEXTURE_EDGE || dims.height > MAX_TEXTURE_EDGE) {
          error(
            `${rel} is ${dims.width}x${dims.height}, above the ${MAX_TEXTURE_EDGE}px limit`,
          );
        }
      }
      // Raw PNG/JPG in the models/textures tree means the KTX2 step was skipped.
      if (rel.includes(join('assets', 'textures'))) {
        warn(`${rel} is an uncompressed texture; expected KTX2 for runtime use`);
      }
    }

    if (ext === '.glb') {
      await checkGlb(file, rel);
    }

    if (ext === '.ktx2') {
      await checkKtx2(file, rel);
    }
  }
}

/** Verifies GLB container header and reported length. */
async function checkGlb(file: string, rel: string): Promise<void> {
  const buf = await readFile(file);
  if (buf.length < 12) {
    error(`${rel} is too short to be a GLB`);
    return;
  }
  const magic = buf.readUInt32LE(0);
  // 'glTF' little-endian.
  if (magic !== 0x46546c67) {
    error(`${rel} does not have a valid glTF magic header`);
    return;
  }
  const version = buf.readUInt32LE(4);
  if (version !== 2) {
    error(`${rel} is glTF version ${version}; version 2 is required`);
  }
  const declaredLength = buf.readUInt32LE(8);
  if (declaredLength !== buf.length) {
    error(
      `${rel} declares ${declaredLength} bytes but the file is ${buf.length}; it is truncated or padded`,
    );
  }
}

/** Verifies the KTX2 identifier so a mislabelled file fails in CI, not on a phone. */
async function checkKtx2(file: string, rel: string): Promise<void> {
  const buf = await readFile(file);
  const KTX2_ID = Buffer.from([
    0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (buf.length < KTX2_ID.length || !buf.subarray(0, KTX2_ID.length).equals(KTX2_ID)) {
    error(`${rel} does not have a valid KTX2 identifier`);
  }
}

/**
 * Reads PNG/JPEG dimensions from the header.
 *
 * Avoids an image-decoding dependency for what is a few bytes of parsing.
 * Returns null when the format is not recognised.
 */
async function readImageSize(
  file: string,
): Promise<{ width: number; height: number } | null> {
  const buf = await readFile(file);

  // PNG: 8-byte signature, then IHDR with width/height as big-endian uint32.
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // JPEG: walk segment markers to SOFn.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buf[offset + 1];
      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry dimensions.
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      const segmentLength = buf.readUInt16BE(offset + 2);
      if (segmentLength <= 0) break;
      offset += 2 + segmentLength;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Licence manifest
// ---------------------------------------------------------------------------

async function checkLicenceRecords(): Promise<void> {
  if (!existsSync(LICENSE_MANIFEST)) {
    error('ASSET_LICENSES.md is missing');
    return;
  }

  const manifest = await readFile(LICENSE_MANIFEST, 'utf8');
  // Icons live under public/pwa but still need attribution records.
  const files = [...(await listFiles(PUBLIC_ASSETS)), ...(await listFiles(PUBLIC_PWA))];

  // Binary asset types that must be attributable. Text/JSON we author
  // ourselves and it is covered by the repository licence.
  const NEEDS_RECORD = new Set([
    '.glb',
    '.gltf',
    '.ktx2',
    '.png',
    '.jpg',
    '.jpeg',
    '.hdr',
    '.exr',
    '.svg',
    '.woff2',
    '.ogg',
    '.mp3',
    '.m4a',
  ]);

  for (const file of files) {
    const ext = extname(file).toLowerCase();
    if (!NEEDS_RECORD.has(ext)) continue;

    const name = basename(file);
    if (!manifest.includes(name)) {
      error(`${relative(ROOT, file)} has no entry in ASSET_LICENSES.md`);
    }
  }
}

// ---------------------------------------------------------------------------
// Content JSON checks
// ---------------------------------------------------------------------------

async function checkContentJson(): Promise<void> {
  const files = (await listFiles(CONTENT_DIR)).filter((f) => extname(f) === '.json');

  if (files.length === 0) {
    warn('content/ contains no JSON yet');
    return;
  }

  const seenDialogueIds = new Map<string, string>();

  for (const file of files) {
    const rel = relative(ROOT, file);
    let parsed: unknown;

    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      error(`${rel} is not valid JSON: ${(err as Error).message}`);
      continue;
    }

    // Dialogue scenes must have globally unique node ids so audio and
    // subtitle files can be addressed deterministically.
    if (isRecord(parsed) && Array.isArray(parsed.nodes)) {
      const sceneId = typeof parsed.sceneId === 'string' ? parsed.sceneId : rel;
      for (const node of parsed.nodes) {
        if (!isRecord(node) || typeof node.id !== 'string') continue;
        const key = `${sceneId}:${node.id}`;
        const previous = seenDialogueIds.get(key);
        if (previous) {
          error(`duplicate dialogue node id "${key}" in ${rel} and ${previous}`);
        } else {
          seenDialogueIds.set(key, rel);
        }

        // Placeholder text must never reach a build.
        if (typeof node.text === 'string') {
          const lowered = node.text.toLowerCase();
          if (
            lowered.includes('lorem ipsum') ||
            lowered.includes('todo') ||
            lowered.includes('placeholder') ||
            node.text.trim().length === 0
          ) {
            error(`${rel} node "${node.id}" contains placeholder text`);
          }
        }

        // Referenced audio must exist once the TTS pipeline has been run.
        if (typeof node.audio === 'string' && node.audio.length > 0) {
          const audioPath = join(ROOT, 'public', 'assets', 'audio', node.audio);
          if (!existsSync(audioPath)) {
            warn(`${rel} node "${node.id}" references missing audio ${node.audio}`);
          }
        }
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Validating TIDELOCK assets and content...\n');

  await checkRuntimeAssets();
  await checkLicenceRecords();
  await checkContentJson();

  for (const w of warnings) console.log(`  warn   ${w}`);
  for (const e of errors) console.error(`  ERROR  ${e}`);

  console.log(
    `\n${errors.length} error(s), ${warnings.length} warning(s).`,
  );

  if (errors.length > 0) {
    console.error('\nAsset validation failed.');
    process.exit(1);
  }

  console.log('Asset validation passed.');
}

main().catch((err) => {
  console.error('Asset validation crashed:', err);
  process.exit(1);
});
