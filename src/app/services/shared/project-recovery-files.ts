export interface ProjectRecoveryFileBytes {
  encoding: 'utf8' | 'base64';
  bytes: number;
  hash: string;
  /** Valid UTF-8 is already held losslessly in files; only binary needs base64. */
  contents?: string;
}

export interface ProjectRecoveryFiles {
  files: Record<string, string | null>;
  rawFiles: Record<string, ProjectRecoveryFileBytes | null>;
}

export interface ProjectRecoveryFileReader {
  existsSync(path: string): boolean;
  readFileBuffer?(path: string): unknown;
  readFileSync(path: string, encoding: string | null): unknown;
}

const limit = 128 * 1024 * 1024;
const fault = (message: string) => Object.assign(new Error(message), { code: 'PROJECT_RECOVERY_SOURCE_CHANGED' });
const location = (project: string, name: string) => {
  if (!['package.json', 'project.abi', 'project.abs', 'project.abs.map.json'].includes(name))
    throw new Error('Unsupported recovery source file.');
  return `${project}/${name}`;
};

function readBytes(file: string, native: ProjectRecoveryFileReader): Uint8Array | null {
  if (!native.existsSync(file)) return null;
  // Passing null is significant: the preload's default encoding is UTF-8.
  // Older test/in-memory ports may return their already-textual value.
  const value = native.readFileBuffer ? native.readFileBuffer(file) : native.readFileSync(file, null);
  let bytes: Uint8Array;
  if (typeof value === 'string') bytes = new TextEncoder().encode(value);
  else if (ArrayBuffer.isView(value)) bytes = Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  else if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') bytes = Uint8Array.from(new Uint8Array(value as ArrayBuffer));
  else throw new Error('Recovery requires an exact binary filesystem read.');
  if (bytes.byteLength > limit) throw new Error('Recovery source exceeds the 128 MiB file limit.');
  return bytes;
}

function base64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  return btoa(chunks.join(''));
}

function originalBytes(capture: ProjectRecoveryFiles, name: string): Uint8Array | null {
  const raw = capture.rawFiles[name];
  if (raw === null) return null;
  if (!raw) throw fault('Recovery byte metadata is missing.');
  if (raw.encoding === 'utf8' && typeof capture.files[name] === 'string')
    return new TextEncoder().encode(capture.files[name]!);
  if (raw.encoding === 'base64' && typeof raw.contents === 'string')
    return Uint8Array.from(atob(raw.contents), value => value.charCodeAt(0));
  throw fault('Recovery byte metadata is invalid.');
}

/** Pure readback guard; neither private state nor source mirrors are mutated. */
export function assertProjectRecoveryFilesCurrent(project: string, capture: ProjectRecoveryFiles,
  native: ProjectRecoveryFileReader = window['fs']): void {
  for (const name of Object.keys(capture.rawFiles)) {
    const actual = readBytes(location(project, name), native), expected = originalBytes(capture, name);
    if (actual === null ? expected !== null : expected === null || actual.length !== expected.length
      || actual.some((value, index) => value !== expected![index]))
      throw fault('The saved source changed during recovery capture. Preserve both versions and inspect again.');
  }
}

/** UTF-8 decoding is not recovery authority. Opaque/corrupt drafts remain
 * exact bytes in an archive, while only valid ABI text may be a primary. */
export async function captureProjectRecoveryFiles(project: string, names: readonly string[], assertCurrent: () => void,
  native: ProjectRecoveryFileReader = window['fs']): Promise<ProjectRecoveryFiles> {
  assertCurrent();
  const captured = names.map(name => [name, readBytes(location(project, name), native)] as const);
  const result: ProjectRecoveryFiles = { files: {}, rawFiles: {} };
  for (const [name, bytes] of captured) {
    if (bytes === null) { result.files[name] = null; result.rawFiles[name] = null; continue; }
    let text: string | null = null;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { /* Archive raw bytes. */ }
    const digest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
    const hash = 'sha256:' + Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
    result.files[name] = text;
    result.rawFiles[name] = { encoding: text === null ? 'base64' : 'utf8', bytes: bytes.length, hash,
      ...(text === null ? { contents: base64(bytes) } : {}) };
  }
  assertCurrent();
  assertProjectRecoveryFilesCurrent(project, result, native);
  return result;
}
