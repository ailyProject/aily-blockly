interface BuildRequestFiles {
  join: (...parts: string[]) => string;
  exists: (path: string) => boolean;
  mkdir: (path: string) => Promise<unknown>;
  write: (path: string, text: string) => unknown | Promise<unknown>;
}

/** Guard the small live configuration used to create a request across awaits.
 * This is a capture boundary, not a lock for the compiler's entire lifetime.
 */
export function captureBuildRequestGuard(read: () => unknown): () => void {
  const captured = JSON.stringify(read());
  return () => {
    if (JSON.stringify(read()) !== captured) throw new Error('BUILD_SOURCE_STALE: Build configuration changed while preparing the request; build again.');
  };
}

/** Freeze before the first await. A later UI/background request cannot overwrite
 * another process's input before that process gets scheduled. The child consumes
 * only this reserved .temp/compile-request-UUID.json form; saved configs remain.
 */
export async function writeBuildRequest(projectPath: string, config: unknown, files: BuildRequestFiles): Promise<string> {
  const text = JSON.stringify(config, null, 2);
  const directory = files.join(projectPath, '.temp');
  const filename = files.join(directory, `compile-request-${crypto.randomUUID()}.json`);
  if (!files.exists(directory)) await files.mkdir(directory);
  await files.write(filename, text);
  return filename;
}
