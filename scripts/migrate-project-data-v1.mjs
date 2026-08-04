import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const MAGIC = Buffer.from('AILYDAT1', 'ascii');
const SCHEMA_MARKER = Object.freeze({ schemaVersion: 1, mode: 'external-only' });
const STORAGE = 'raw-v1';
const GENERIC_VALUE_SCHEMA_VERSION = 1;
const GENERIC_VALUE_THRESHOLD = 32 * 1024;

const projectPath = process.argv[2] ? resolve(process.argv[2]) : '';
if (!projectPath) {
  throw new Error('Usage: node scripts/migrate-project-data-v1.mjs <project-path>');
}

const abiPath = join(projectPath, 'project.abi');
const backupPath = join(projectPath, 'project.abi.pre-project-data-v1.bak');
const abi = JSON.parse(await readFile(abiPath, 'utf8'));
const migrated = [];

await visit(abi, '$');
await externalizeGenericValues(abi, '$');
abi.$ailyProjectData = SCHEMA_MARKER;

if (!existsSync(backupPath)) await copyFile(abiPath, backupPath);
await writeAtomically(abiPath, Buffer.from(JSON.stringify(abi)));

console.log(JSON.stringify({
  projectPath,
  migratedCount: migrated.length,
  resources: migrated,
  abiBytes: (await readFile(abiPath)).byteLength,
}, null, 2));

async function visit(value, jsonPath) {
  if (!value || typeof value !== 'object') return;
  if (isInlineTftAnimation(value)) {
    const format = value.format;
    const codec = format === 'rgb332' ? 'tft-rgb332-frames-v1' : 'tft-rgb565-be-frames-v1';
    const encoding = format === 'rgb332' ? 'rgb332' : 'rgb565-be';
    const frameByteLength = value.width * value.height * (format === 'rgb332' ? 1 : 2);
    const frames = value.frames.map((frame, index) => {
      const bytes = Buffer.from(frame, 'base64');
      if (bytes.byteLength !== frameByteLength) {
        throw new Error(`${jsonPath}/frames/${index} has ${bytes.byteLength} bytes; expected ${frameByteLength}.`);
      }
      return bytes;
    });
    const canonicalBytes = Buffer.concat(frames);
    const ref = await persistResource(projectPath, codec, STORAGE, 'binary', canonicalBytes);

    delete value.version;
    value.schemaVersion = 1;
    value.encoding = encoding;
    value.frameCount = frames.length;
    value.frames = ref;
    migrated.push({ jsonPath, codec, frameCount: frames.length, rawLength: canonicalBytes.byteLength, id: ref.$ailyData.id });
    return;
  }
  if (isInlineU8g2Animation(value)) {
    const bytesPerRow = Math.ceil(value.width / 8);
    const frameByteLength = bytesPerRow * value.height;
    const canonicalBytes = Buffer.alloc(frameByteLength * value.frames.length);
    value.frames.forEach((frame, frameIndex) => {
      const frameOffset = frameIndex * frameByteLength;
      frame.forEach((row, y) => row.forEach((cell, x) => {
        if (cell === 1) {
          canonicalBytes[frameOffset + y * bytesPerRow + Math.floor(x / 8)] |= 1 << (x % 8);
        }
      }));
    });
    const codec = 'u8g2-xbm-frames-v1';
    const ref = await persistResource(projectPath, codec, STORAGE, 'binary', canonicalBytes);
    value.schemaVersion = 1;
    value.encoding = 'xbm-lsb-row-v1';
    value.frameCount = value.frames.length;
    value.frames = ref;
    migrated.push({
      jsonPath,
      codec,
      frameCount: value.frameCount,
      rawLength: canonicalBytes.byteLength,
      id: ref.$ailyData.id,
    });
    return;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) await visit(value[index], `${jsonPath}/${index}`);
    return;
  }
  for (const [key, member] of Object.entries(value)) await visit(member, `${jsonPath}/${escapePointer(key)}`);
}

async function externalizeGenericValues(value, jsonPath) {
  if (!value || typeof value !== 'object' || isDataRef(value) || isGenericValue(value)) return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      await externalizeGenericValues(value[index], `${jsonPath}/${index}`);
    }
    return;
  }

  if (value.fields && typeof value.fields === 'object' && !Array.isArray(value.fields)) {
    for (const [fieldName, fieldValue] of Object.entries(value.fields)) {
      value.fields[fieldName] = await externalizeGenericCandidate(
        fieldValue,
        `${jsonPath}/fields/${escapePointer(fieldName)}`,
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, 'extraState')) {
    value.extraState = await externalizeGenericCandidate(value.extraState, `${jsonPath}/extraState`);
  }

  for (const [key, member] of Object.entries(value)) {
    if (key === 'fields' || key === 'extraState') continue;
    await externalizeGenericValues(member, `${jsonPath}/${escapePointer(key)}`);
  }
}

async function externalizeGenericCandidate(value, jsonPath) {
  if (value === null || value === undefined || isDataRef(value) || isGenericValue(value)) return value;
  const codec = typeof value === 'string'
    ? 'utf8-v1'
    : isPlainJsonContainer(value)
      ? 'canonical-json-v1'
      : '';
  if (!codec || containsDataRef(value)) return value;

  const canonicalBytes = Buffer.from(
    codec === 'utf8-v1' ? value : canonicalJsonStringify(value),
    'utf8',
  );
  if (canonicalBytes.byteLength <= GENERIC_VALUE_THRESHOLD) return value;

  const logicalType = codec === 'utf8-v1' ? 'text' : 'json';
  const ref = await persistResource(projectPath, codec, STORAGE, logicalType, canonicalBytes);
  migrated.push({ jsonPath, codec, rawLength: canonicalBytes.byteLength, id: ref.$ailyData.id });
  return {
    $ailyProjectDataValue: {
      schemaVersion: GENERIC_VALUE_SCHEMA_VERSION,
      ref,
    },
  };
}

function canonicalJsonStringify(value) {
  const normalize = (current) => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current && typeof current === 'object') {
      return Object.fromEntries(Object.keys(current).sort().map((key) => [key, normalize(current[key])]));
    }
    return current;
  };
  return JSON.stringify(normalize(value));
}

function isPlainJsonContainer(value) {
  return Array.isArray(value)
    || (!!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
}

function isDataRef(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1
    && !!value.$ailyData;
}

function isGenericValue(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1
    && value.$ailyProjectDataValue?.schemaVersion === GENERIC_VALUE_SCHEMA_VERSION
    && isDataRef(value.$ailyProjectDataValue.ref);
}

function containsDataRef(value) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if (isDataRef(current) || isGenericValue(current)) return true;
    pending.push(...(Array.isArray(current) ? current : Object.values(current)));
  }
  return false;
}

function isInlineTftAnimation(value) {
  return value.version === 1
    && (value.format === 'rgb565' || value.format === 'rgb332')
    && (value.encoding === 'rgb565-be-base64' || value.encoding === 'rgb332-base64')
    && Number.isSafeInteger(value.width)
    && Number.isSafeInteger(value.height)
    && Array.isArray(value.frames)
    && value.frames.length > 0
    && value.frames.every((frame) => typeof frame === 'string');
}

function isInlineU8g2Animation(value) {
  return Number.isSafeInteger(value.width)
    && value.width > 0
    && Number.isSafeInteger(value.height)
    && value.height > 0
    && typeof value.dither === 'boolean'
    && Number.isFinite(value.threshold)
    && Array.isArray(value.frames)
    && value.frames.length > 0
    && value.frames.every((frame) => (
      Array.isArray(frame)
      && frame.length === value.height
      && frame.every((row) => (
        Array.isArray(row)
        && row.length === value.width
        && row.every((cell) => cell === 0 || cell === 1)
      ))
    ));
}

async function persistResource(root, codec, storage, logicalType, canonicalBytes) {
  const digest = createHash('sha256')
    .update(codec)
    .update(Buffer.from([0]))
    .update(storage)
    .update(Buffer.from([0]))
    .update(canonicalBytes)
    .digest('hex');
  const id = `sha256:${digest}`;
  const ref = {
    $ailyData: {
      schemaVersion: 1,
      id,
      logicalType,
      codec,
      storage,
      rawLength: canonicalBytes.byteLength,
      storedLength: canonicalBytes.byteLength,
    },
  };
  const header = Buffer.from(JSON.stringify(ref.$ailyData), 'utf8');
  const headerLength = Buffer.allocUnsafe(4);
  headerLength.writeUInt32LE(header.byteLength);
  const container = Buffer.concat([MAGIC, headerLength, header, canonicalBytes]);
  const target = join(root, 'assets', 'project-data', digest.slice(0, 2), `${digest}.bin`);
  if (!existsSync(target)) await writeAtomically(target, container);
  return ref;
}

async function writeAtomically(target, bytes) {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, target);
}

function escapePointer(value) {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}
