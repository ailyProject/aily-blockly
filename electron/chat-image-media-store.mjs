import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

export const CHAT_IMAGE_LIMITS = Object.freeze({
  maxOriginalBytes: 30 * 1024 * 1024,
  maxProcessedBytes: 5 * 1024 * 1024,
  maxTotalProcessedBytes: 10 * 1024 * 1024,
  maxImages: 10,
  maxPixels: 40_000_000,
  maxEdge: 2048,
});

const MIME_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
});
const MANAGED_MEDIA_REF_PATTERN = /^aily-media:v1:([a-f0-9]{64})$/iu;
const SESSION_REFERENCE_DIRECTORY = 'session-references';
let mediaReferenceMutation = Promise.resolve();

export class ChatImageError extends Error {
  constructor(code, message, attachmentId = '') {
    super(message);
    this.name = 'ChatImageError';
    this.code = code;
    this.attachmentId = attachmentId;
    this.retryable = false;
  }
}

export function resolveChatImageMediaRoot(env = process.env) {
  const appDataPath = normalizeString(env.AILY_APPDATA_PATH)
    || normalizeString(env.AILY_APP_DATA_PATH)
    || normalizeString(env.AILY_CHAT_APP_DATA_PATH)
    || normalizeString(env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'aily-project'))
    || normalizeString(env.APPDATA && path.join(env.APPDATA, 'aily-project'))
    || path.join(os.homedir(), '.aily');
  return path.join(appDataPath, 'runtime-host', 'chat-media', 'v1');
}

export async function resolveChatImageAttachments(drafts, options = {}) {
  const normalizedDrafts = Array.isArray(drafts) ? drafts.filter(Boolean) : [];
  const limits = { ...CHAT_IMAGE_LIMITS, ...(options.limits || {}) };
  if (normalizedDrafts.length > limits.maxImages) {
    throw new ChatImageError('IMAGE_TOO_MANY', `A maximum of ${limits.maxImages} images can be sent in one request.`);
  }

  const mediaRoot = normalizeString(options.mediaRoot) || resolveChatImageMediaRoot(options.env);
  const results = [];
  let totalBytes = 0;
  for (const draft of normalizedDrafts) {
    const resolved = await resolveOneChatImage(draft, { mediaRoot, limits });
    totalBytes += resolved.byteLength;
    if (totalBytes > limits.maxTotalProcessedBytes) {
      throw new ChatImageError(
        'IMAGE_TOO_LARGE',
        `The combined image payload exceeds ${limits.maxTotalProcessedBytes} bytes.`,
        resolved.id,
      );
    }
    results.push(resolved);
  }
  return results;
}

export function toManagedChatImageAttachment(image) {
  return {
    id: image.id,
    type: 'image',
    name: image.name,
    origin: image.origin,
    source: { kind: 'managed-ref', mediaRef: image.mediaRef },
    mimeType: image.mimeType,
    detail: image.detail,
    width: image.width,
    height: image.height,
    byteLength: image.byteLength,
    sha256: image.sha256,
  };
}

/**
 * Return the only image fields allowed in diagnostic logs. In particular this
 * excludes source paths, managed references, full hashes, base64 and headers.
 */
export function toChatImageDiagnostic(image) {
  return {
    attachmentId: normalizeString(image?.id),
    mimeType: normalizeMimeType(image?.mimeType) || undefined,
    width: Number.isInteger(image?.width) ? image.width : undefined,
    height: Number.isInteger(image?.height) ? image.height : undefined,
    byteLength: Number.isInteger(image?.byteLength) ? image.byteLength : undefined,
    originalByteLength: Number.isInteger(image?.originalByteLength) ? image.originalByteLength : undefined,
    sha256Prefix: normalizeString(image?.sha256).slice(0, 12),
    deduplicated: image?.deduplicated === true,
    preprocessed: image?.preprocessed === true,
    transformations: Array.isArray(image?.transformations)
      ? image.transformations.filter(value => typeof value === 'string').slice(0, 10)
      : [],
    durationMs: Number.isFinite(image?.durationMs) ? Math.max(0, Math.round(image.durationMs)) : undefined,
  };
}

export function collectChatImageMediaRefs(value) {
  const refs = new Set();
  collectManagedMediaRefs(value, refs, new Set());
  return [...refs].sort();
}

/**
 * Persist the complete image-reference set for one session and release only
 * files that this session stopped referencing and no remaining manifest uses.
 *
 * Candidate-based cleanup avoids deleting legacy or abandoned media that was
 * never registered by this reference index.
 */
export function updateChatImageSessionReferences(sessionId, mediaRefs, options = {}) {
  const operation = mediaReferenceMutation.then(() => updateSessionReferences(
    sessionId,
    mediaRefs,
    options,
  ));
  mediaReferenceMutation = operation.catch(() => undefined);
  return operation;
}

export function releaseChatImageSessionReferences(sessionId, options = {}) {
  return updateChatImageSessionReferences(sessionId, [], options);
}

/**
 * Resolve one durable media reference for a Workbench request-attachment
 * renderer. The caller receives validated bytes only; filesystem paths never
 * cross the host boundary.
 */
export async function readManagedChatImageMedia(mediaRef, options = {}) {
  const normalizedMediaRef = normalizeString(mediaRef);
  const mediaRoot = normalizeString(options.mediaRoot) || resolveChatImageMediaRoot(options.env);
  const bytes = await readDraftBytes({
    id: normalizeString(options.attachmentId),
    type: 'image',
    source: {
      kind: 'managed-ref',
      mediaRef: normalizedMediaRef,
    },
    ...(normalizeMimeType(options.mimeType) ? { mimeType: normalizeMimeType(options.mimeType) } : {}),
  }, {
    mediaRoot,
    limits: { ...CHAT_IMAGE_LIMITS, ...(options.limits || {}) },
  }, normalizeString(options.attachmentId));
  const detected = inspectImage(bytes, normalizeString(options.attachmentId));
  return {
    mediaRef: normalizedMediaRef,
    mimeType: detected.mimeType,
    width: detected.width,
    height: detected.height,
    byteLength: bytes.byteLength,
    content: bytes.toString('base64'),
  };
}

async function resolveOneChatImage(draft, options) {
  const id = normalizeString(draft?.id) || randomUUID();
  const startedAt = Date.now();
  const originalBytes = await readDraftBytes(draft, options, id);
  const detectedOriginal = inspectImage(originalBytes, id);
  const declaredMimeType = normalizeMimeType(draft?.mimeType);
  if (declaredMimeType && declaredMimeType !== detectedOriginal.mimeType) {
    throw new ChatImageError('IMAGE_UNSUPPORTED_FORMAT', 'Declared image MIME type does not match the file content.', id);
  }
  const processed = await preprocessChatImage(originalBytes, {
    attachmentId: id,
    detected: detectedOriginal,
    limits: options.limits,
  });
  const bytes = processed.bytes;
  const detected = {
    mimeType: processed.mimeType,
    width: processed.width,
    height: processed.height,
  };

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const extension = MIME_EXTENSIONS[detected.mimeType];
  await fs.mkdir(options.mediaRoot, { recursive: true });
  const storedPath = path.join(options.mediaRoot, `${sha256}.${extension}`);
  const deduplicated = await persistContentAddressedFile(storedPath, bytes);
  const detail = draft?.detail === 'low' || draft?.detail === 'high' ? draft.detail : 'auto';
  const result = {
    id,
    type: 'image',
    name: normalizeString(draft?.name) || `image.${extension}`,
    origin: normalizeImageOrigin(draft?.origin),
    mediaRef: `aily-media:v1:${sha256}`,
    mimeType: detected.mimeType,
    width: detected.width,
    height: detected.height,
    byteLength: bytes.byteLength,
    originalByteLength: originalBytes.byteLength,
    sha256,
    detail,
    content: bytes.toString('base64'),
    deduplicated,
    preprocessed: processed.preprocessed,
    transformations: processed.transformations,
    durationMs: Date.now() - startedAt,
  };
  return result;
}

export async function preprocessChatImage(bytes, options = {}) {
  const attachmentId = normalizeString(options.attachmentId);
  const limits = { ...CHAT_IMAGE_LIMITS, ...(options.limits || {}) };
  const detected = options.detected || inspectImage(bytes, attachmentId);
  let metadata;
  try {
    metadata = await sharp(bytes, {
      animated: true,
      failOn: 'error',
      limitInputPixels: limits.maxPixels,
      sequentialRead: true,
    }).metadata();
  } catch (error) {
    throw new ChatImageError(
      isSharpPixelLimitError(error) ? 'IMAGE_TOO_LARGE' : 'IMAGE_DECODE_FAILED',
      isSharpPixelLimitError(error)
        ? `Image dimensions exceed the ${limits.maxPixels} pixel safety limit.`
        : 'Image bytes could not be fully decoded.',
      attachmentId,
    );
  }

  const decodedMimeType = sharpFormatToMimeType(metadata.format);
  if (!decodedMimeType || decodedMimeType !== detected.mimeType) {
    throw new ChatImageError(
      'IMAGE_UNSUPPORTED_FORMAT',
      'Decoded image format does not match the supported file signature.',
      attachmentId,
    );
  }
  const width = Number(metadata.width);
  const pageHeight = Number(metadata.pageHeight || metadata.height);
  if (!Number.isInteger(width) || !Number.isInteger(pageHeight) || width <= 0 || pageHeight <= 0) {
    throw new ChatImageError('IMAGE_DECODE_FAILED', 'Decoded image dimensions are invalid.', attachmentId);
  }
  if (width * pageHeight > limits.maxPixels) {
    throw new ChatImageError(
      'IMAGE_TOO_LARGE',
      `Image dimensions exceed the ${limits.maxPixels} pixel safety limit.`,
      attachmentId,
    );
  }

  const pageCount = Math.max(1, Number(metadata.pages) || 1);
  const orientation = Number(metadata.orientation) || 1;
  const hasRemovableMetadata = Boolean(
    metadata.exif
    || metadata.icc
    || metadata.iptc
    || metadata.xmp
    || metadata.tifftagPhotoshop,
  );
  const needsResize = Math.max(width, pageHeight) > limits.maxEdge;
  const needsTransform = (
    bytes.byteLength > limits.maxProcessedBytes
    || needsResize
    || orientation !== 1
    || pageCount > 1
    || detected.mimeType === 'image/gif'
    || hasRemovableMetadata
  );

  if (!needsTransform) {
    return {
      bytes,
      mimeType: detected.mimeType,
      width,
      height: pageHeight,
      preprocessed: false,
      transformations: [],
    };
  }

  const transformations = [];
  if (orientation !== 1) transformations.push('exif-orientation');
  if (needsResize) transformations.push('resize');
  if (bytes.byteLength > limits.maxProcessedBytes) transformations.push('compress');
  if (pageCount > 1 || detected.mimeType === 'image/gif') transformations.push('first-frame');
  if (hasRemovableMetadata) transformations.push('metadata-stripped');

  const output = await encodeProcessedImage(bytes, detected.mimeType, limits, attachmentId);
  if (output.data.byteLength < bytes.byteLength && !transformations.includes('compress')) {
    transformations.push('compress');
  }
  return {
    bytes: output.data,
    mimeType: sharpFormatToMimeType(output.info.format),
    width: output.info.width,
    height: output.info.height,
    preprocessed: true,
    transformations,
  };
}

async function encodeProcessedImage(bytes, sourceMimeType, limits, attachmentId) {
  const edgeCandidates = [...new Set([
    limits.maxEdge,
    Math.min(limits.maxEdge, 1600),
    Math.min(limits.maxEdge, 1280),
    Math.min(limits.maxEdge, 1024),
  ].filter(value => Number.isInteger(value) && value > 0))];
  const qualityCandidates = [88, 78, 68, 58];

  for (const maxEdge of edgeCandidates) {
    for (const quality of qualityCandidates) {
      const pipeline = sharp(bytes, {
        animated: false,
        failOn: 'error',
        limitInputPixels: limits.maxPixels,
        sequentialRead: true,
      })
        .rotate()
        .resize({
          width: maxEdge,
          height: maxEdge,
          fit: 'inside',
          withoutEnlargement: true,
        });

      const encoded = await encodePipeline(pipeline, sourceMimeType, quality);
      if (encoded.data.byteLength <= limits.maxProcessedBytes) {
        return encoded;
      }
    }
  }

  throw new ChatImageError(
    'IMAGE_TOO_LARGE',
    `Image remains larger than ${limits.maxProcessedBytes} bytes after safe preprocessing.`,
    attachmentId,
  );
}

async function encodePipeline(pipeline, sourceMimeType, quality) {
  if (sourceMimeType === 'image/jpeg') {
    return pipeline
      .jpeg({ quality, progressive: true, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  }
  if (sourceMimeType === 'image/webp') {
    return pipeline
      .webp({ quality, effort: 4, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
  }
  if ((sourceMimeType === 'image/png' || sourceMimeType === 'image/gif') && quality === 88) {
    return pipeline
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer({ resolveWithObject: true });
  }
  return pipeline
    .webp({ quality, effort: 4, smartSubsample: true })
    .toBuffer({ resolveWithObject: true });
}

function sharpFormatToMimeType(format) {
  if (format === 'png') return 'image/png';
  if (format === 'jpeg' || format === 'jpg') return 'image/jpeg';
  if (format === 'gif') return 'image/gif';
  if (format === 'webp') return 'image/webp';
  return '';
}

function isSharpPixelLimitError(error) {
  const message = String(error?.message || error).toLowerCase();
  return message.includes('pixel limit') || message.includes('image exceeds pixel limit');
}

async function readDraftBytes(draft, options, attachmentId) {
  const limits = options.limits;
  const source = draft?.source && typeof draft.source === 'object' ? draft.source : null;
  const sourceKind = normalizeString(source?.kind);
  if (sourceKind === 'local-file') {
    const filePath = normalizeString(source?.uri);
    if (!filePath || !path.isAbsolute(filePath)) {
      throw new ChatImageError('IMAGE_MEDIA_MISSING', 'Image file path must be absolute.', attachmentId);
    }
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      throw new ChatImageError('IMAGE_MEDIA_MISSING', 'Image file is unavailable.', attachmentId);
    }
    if (!stat.isFile()) {
      throw new ChatImageError('IMAGE_MEDIA_MISSING', 'Image source is not a regular file.', attachmentId);
    }
    if (stat.size <= 0 || stat.size > limits.maxOriginalBytes) {
      throw new ChatImageError('IMAGE_TOO_LARGE', `Image must contain 1-${limits.maxOriginalBytes} bytes.`, attachmentId);
    }
    return fs.readFile(filePath);
  }

  if (sourceKind === 'inline-base64') {
    const data = normalizeString(source?.data).replace(/^data:[^;,]+;base64,/i, '').replace(/\s/g, '');
    if (!data || !/^[a-z\d+/]+={0,2}$/i.test(data)) {
      throw new ChatImageError('IMAGE_DECODE_FAILED', 'Inline image data is not valid base64.', attachmentId);
    }
    const bytes = Buffer.from(data, 'base64');
    if (bytes.byteLength <= 0 || bytes.byteLength > limits.maxOriginalBytes) {
      throw new ChatImageError('IMAGE_TOO_LARGE', `Image must contain 1-${limits.maxOriginalBytes} bytes.`, attachmentId);
    }
    return bytes;
  }

  if (sourceKind === 'url' || sourceKind === 'remote-url') {
    throw new ChatImageError(
      'IMAGE_URL_BLOCKED',
      'Remote image URLs are blocked. Attach a local image or clipboard image instead.',
      attachmentId,
    );
  }

  if (sourceKind === 'managed-ref') {
    const match = /^aily-media:v1:([a-f0-9]{64})$/i.exec(normalizeString(source?.mediaRef));
    if (!match) {
      throw new ChatImageError('IMAGE_MEDIA_MISSING', 'Managed image reference is invalid.', attachmentId);
    }
    const declaredMimeType = normalizeMimeType(draft?.mimeType);
    const extensions = declaredMimeType
      ? [MIME_EXTENSIONS[declaredMimeType]]
      : Object.values(MIME_EXTENSIONS);
    for (const extension of extensions) {
      const mediaPath = path.join(options.mediaRoot, `${match[1].toLowerCase()}.${extension}`);
      try {
        const bytes = await fs.readFile(mediaPath);
        if (bytes.byteLength <= 0 || bytes.byteLength > limits.maxProcessedBytes) {
          throw new ChatImageError('IMAGE_TOO_LARGE', 'Managed image exceeds the processed-image limit.', attachmentId);
        }
        const actualHash = createHash('sha256').update(bytes).digest('hex');
        if (actualHash !== match[1].toLowerCase()) {
          throw new ChatImageError('IMAGE_DECODE_FAILED', 'Managed image content hash is invalid.', attachmentId);
        }
        return bytes;
      } catch (error) {
        if (error instanceof ChatImageError) throw error;
        if (error?.code !== 'ENOENT') {
          throw new ChatImageError('IMAGE_MEDIA_MISSING', 'Managed image could not be read.', attachmentId);
        }
      }
    }
    throw new ChatImageError('IMAGE_MEDIA_MISSING', 'Managed image is unavailable.', attachmentId);
  }

  throw new ChatImageError('IMAGE_MEDIA_MISSING', 'Image source is missing or unsupported.', attachmentId);
}

export function inspectImage(bytes, attachmentId = '') {
  if (!Buffer.isBuffer(bytes)) {
    bytes = Buffer.from(bytes || []);
  }
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return checkedDimensions('image/png', width, height, attachmentId);
  }
  if (bytes.length >= 10 && (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return checkedDimensions('image/gif', bytes.readUInt16LE(6), bytes.readUInt16LE(8), attachmentId);
  }
  if (bytes.length >= 12 && bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) {
    return inspectJpeg(bytes, attachmentId);
  }
  if (bytes.length >= 30 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return inspectWebp(bytes, attachmentId);
  }
  throw new ChatImageError('IMAGE_UNSUPPORTED_FORMAT', 'Only PNG, JPEG, GIF, and WebP images are supported.', attachmentId);
}

function inspectJpeg(bytes, attachmentId) {
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && length >= 7) {
      return checkedDimensions('image/jpeg', bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3), attachmentId);
    }
    offset += length;
  }
  throw new ChatImageError('IMAGE_DECODE_FAILED', 'JPEG dimensions could not be decoded.', attachmentId);
}

function inspectWebp(bytes, attachmentId) {
  const chunk = bytes.subarray(12, 16).toString('ascii');
  const dataOffset = 20;
  if (chunk === 'VP8X' && bytes.length >= dataOffset + 10) {
    const width = 1 + bytes.readUIntLE(dataOffset + 4, 3);
    const height = 1 + bytes.readUIntLE(dataOffset + 7, 3);
    return checkedDimensions('image/webp', width, height, attachmentId);
  }
  if (chunk === 'VP8 ' && bytes.length >= dataOffset + 10
    && bytes[dataOffset + 3] === 0x9d && bytes[dataOffset + 4] === 0x01 && bytes[dataOffset + 5] === 0x2a) {
    return checkedDimensions(
      'image/webp',
      bytes.readUInt16LE(dataOffset + 6) & 0x3fff,
      bytes.readUInt16LE(dataOffset + 8) & 0x3fff,
      attachmentId,
    );
  }
  if (chunk === 'VP8L' && bytes.length >= dataOffset + 5 && bytes[dataOffset] === 0x2f) {
    const bits = bytes.readUInt32LE(dataOffset + 1);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return checkedDimensions('image/webp', width, height, attachmentId);
  }
  throw new ChatImageError('IMAGE_DECODE_FAILED', 'WebP dimensions could not be decoded.', attachmentId);
}

function checkedDimensions(mimeType, width, height, attachmentId) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new ChatImageError('IMAGE_DECODE_FAILED', 'Image dimensions are invalid.', attachmentId);
  }
  return { mimeType, width, height };
}

async function persistContentAddressedFile(filePath, bytes) {
  try {
    const existing = await fs.stat(filePath);
    if (existing.isFile() && existing.size === bytes.byteLength) return true;
  } catch {
    // Persist below.
  }
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, bytes, { mode: 0o600 });
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    await fs.rm(temporary, { force: true });
    return true;
  }
  return false;
}

async function updateSessionReferences(sessionId, mediaRefs, options) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    return { sessionIdHash: '', referenced: 0, released: 0 };
  }
  const mediaRoot = normalizeString(options.mediaRoot) || resolveChatImageMediaRoot(options.env);
  const referenceRoot = path.join(mediaRoot, SESSION_REFERENCE_DIRECTORY);
  const sessionIdHash = createHash('sha256').update(normalizedSessionId).digest('hex');
  const manifestPath = path.join(referenceRoot, `${sessionIdHash}.json`);
  const nextRefs = new Set(normalizeManagedMediaRefs(mediaRefs));
  const previousManifest = await readReferenceManifest(manifestPath);
  const previousRefs = new Set(previousManifest?.mediaRefs ?? []);

  await fs.mkdir(referenceRoot, { recursive: true });
  if (nextRefs.size > 0) {
    await writeReferenceManifest(manifestPath, {
      schemaVersion: 1,
      sessionIdHash,
      mediaRefs: [...nextRefs].sort(),
      updatedAt: Date.now(),
    });
  } else {
    await fs.rm(manifestPath, { force: true });
  }

  const candidates = [...previousRefs].filter(mediaRef => !nextRefs.has(mediaRef));
  if (candidates.length === 0) {
    return { sessionIdHash, referenced: nextRefs.size, released: 0 };
  }

  const remainingRefs = await readAllReferenceManifestRefs(referenceRoot);
  let released = 0;
  for (const mediaRef of candidates) {
    if (remainingRefs.has(mediaRef)) {
      continue;
    }
    const match = MANAGED_MEDIA_REF_PATTERN.exec(mediaRef);
    if (!match) {
      continue;
    }
    for (const extension of Object.values(MIME_EXTENSIONS)) {
      const candidatePath = path.resolve(mediaRoot, `${match[1]}.${extension}`);
      if (path.dirname(candidatePath) !== path.resolve(mediaRoot)) {
        continue;
      }
      try {
        const stat = await fs.stat(candidatePath);
        if (!stat.isFile()) {
          continue;
        }
        await fs.rm(candidatePath, { force: true });
        released += 1;
        break;
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }
  return { sessionIdHash, referenced: nextRefs.size, released };
}

function collectManagedMediaRefs(value, refs, visited) {
  if (typeof value === 'string') {
    if (MANAGED_MEDIA_REF_PATTERN.test(value)) {
      refs.add(value.toLowerCase());
    }
    return;
  }
  if (!value || typeof value !== 'object' || visited.has(value)) {
    return;
  }
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      collectManagedMediaRefs(item, refs, visited);
    }
    return;
  }
  for (const entry of Object.values(value)) {
    collectManagedMediaRefs(entry, refs, visited);
  }
}

function normalizeManagedMediaRefs(mediaRefs) {
  return (Array.isArray(mediaRefs) ? mediaRefs : [])
    .map(value => normalizeString(value).toLowerCase())
    .filter(value => MANAGED_MEDIA_REF_PATTERN.test(value));
}

async function readReferenceManifest(manifestPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    return {
      mediaRefs: normalizeManagedMediaRefs(parsed?.mediaRefs),
    };
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function readAllReferenceManifestRefs(referenceRoot) {
  const refs = new Set();
  let entries;
  try {
    entries = await fs.readdir(referenceRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return refs;
    }
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/iu.test(entry.name)) {
      continue;
    }
    const manifest = await readReferenceManifest(path.join(referenceRoot, entry.name));
    for (const mediaRef of manifest?.mediaRefs ?? []) {
      refs.add(mediaRef);
    }
  }
  return refs;
}

async function writeReferenceManifest(manifestPath, manifest) {
  const temporary = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(manifest), { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.rename(temporary, manifestPath);
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') {
      throw error;
    }
    await fs.rm(manifestPath, { force: true });
    await fs.rename(temporary, manifestPath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function normalizeMimeType(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'image/jpg') return 'image/jpeg';
  return Object.hasOwn(MIME_EXTENSIONS, normalized) ? normalized : '';
}

function normalizeImageOrigin(value) {
  const normalized = normalizeString(value);
  return normalized === 'clipboard' || normalized === 'tool' ? normalized : 'file';
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}
