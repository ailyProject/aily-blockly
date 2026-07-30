import {
  AilyDataLogicalType,
  AilyDataStorageEncoding,
  ProjectDataError,
} from './project-data.types';

const MAGIC_TEXT = 'AILYDAT1';
const MAGIC_BYTES = new TextEncoder().encode(MAGIC_TEXT);
const PREFIX_LENGTH = MAGIC_BYTES.length + 4;
const MAX_HEADER_LENGTH = 16 * 1024;
export const MAX_PROJECT_DATA_CONTAINER_OVERHEAD = PREFIX_LENGTH + MAX_HEADER_LENGTH;

export interface ProjectDataContainerHeader {
  readonly schemaVersion: 1;
  readonly id: `sha256:${string}`;
  readonly logicalType: AilyDataLogicalType;
  readonly codec: string;
  readonly storage: AilyDataStorageEncoding;
  readonly rawLength: number;
  readonly storedLength: number;
}

export interface ParsedProjectDataContainer {
  readonly header: ProjectDataContainerHeader;
  readonly storedPayload: Uint8Array;
}

export function createProjectDataContainer(
  header: ProjectDataContainerHeader,
  storedPayload: Uint8Array,
): Uint8Array {
  if (storedPayload.length !== header.storedLength) {
    throw new ProjectDataError('corrupt', 'Stored payload length does not match container header.');
  }
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  if (headerBytes.length > MAX_HEADER_LENGTH) {
    throw new ProjectDataError('too-large', 'Project data container header is too large.');
  }

  const output = new Uint8Array(PREFIX_LENGTH + headerBytes.length + storedPayload.length);
  output.set(MAGIC_BYTES, 0);
  new DataView(output.buffer).setUint32(MAGIC_BYTES.length, headerBytes.length, true);
  output.set(headerBytes, PREFIX_LENGTH);
  output.set(storedPayload, PREFIX_LENGTH + headerBytes.length);
  return output;
}

export function parseProjectDataContainer(bytes: Uint8Array): ParsedProjectDataContainer {
  if (bytes.length < PREFIX_LENGTH) {
    throw new ProjectDataError('corrupt', 'Project data container is truncated.');
  }
  for (let index = 0; index < MAGIC_BYTES.length; index++) {
    if (bytes[index] !== MAGIC_BYTES[index]) {
      throw new ProjectDataError('corrupt', 'Project data container magic is invalid.');
    }
  }

  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(MAGIC_BYTES.length, true);
  if (headerLength <= 0 || headerLength > MAX_HEADER_LENGTH || PREFIX_LENGTH + headerLength > bytes.length) {
    throw new ProjectDataError('corrupt', 'Project data container header length is invalid.');
  }

  let header: ProjectDataContainerHeader;
  try {
    const headerText = new TextDecoder('utf-8', { fatal: true })
      .decode(bytes.subarray(PREFIX_LENGTH, PREFIX_LENGTH + headerLength));
    header = JSON.parse(headerText) as ProjectDataContainerHeader;
  } catch (error) {
    throw new ProjectDataError('corrupt', 'Project data container header is invalid JSON.', {
      cause: String(error),
    });
  }

  const storedPayload = bytes.subarray(PREFIX_LENGTH + headerLength);
  if (!isValidHeader(header) || storedPayload.length !== header.storedLength) {
    throw new ProjectDataError('corrupt', 'Project data container header values are invalid.');
  }
  return { header, storedPayload };
}

function isValidHeader(value: unknown): value is ProjectDataContainerHeader {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const header = value as Record<string, unknown>;
  return header['schemaVersion'] === 1
    && typeof header['id'] === 'string'
    && /^sha256:[a-f0-9]{64}$/.test(header['id'])
    && (header['logicalType'] === 'text' || header['logicalType'] === 'json' || header['logicalType'] === 'binary')
    && typeof header['codec'] === 'string'
    && (header['storage'] === 'raw-v1' || header['storage'] === 'deflate-raw-v1')
    && isSafeLength(header['rawLength'])
    && isSafeLength(header['storedLength']);
}

function isSafeLength(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
