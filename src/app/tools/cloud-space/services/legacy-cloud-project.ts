import { detectProjectMode } from '@domain/project/public-api';

interface ArchiveStat { _isFile: boolean; _isDirectory: boolean; _isSymbolicLink: boolean }
interface ArchiveFiles {
  existsSync(path: string): boolean;
  lstatSync(path: string): ArchiveStat;
  readFileSync(path: string, encoding: string): string;
  readDirSync(path: string): Array<{ name: string; _isDirectory: boolean }>;
  mkdirSync(path: string): void;
  renameSync(source: string, target: string): void;
}

/** Only for a freshly extracted cloud archive, before any project is opened.
 * Older ABI-only cloud packages accidentally included the source's public map
 * without its ABS/baseline. Preserve those bytes outside the active sync paths;
 * the normal first save can then establish the destination's own generation.
 */
export function preserveLegacyCloudProjectMap(extracted: string,
  files: ArchiveFiles = window['fs'], paths: { join(...parts: string[]): string } = window['path']): string | undefined {
  const regular = (path: string) => files.existsSync(path) && files.lstatSync(path)._isFile
    && !files.lstatSync(path)._isSymbolicLink;
  let root = extracted;
  if (!regular(paths.join(root, 'package.json'))) {
    const entries = files.readDirSync(root);
    if (entries.length !== 1 || !entries[0]._isDirectory) return;
    root = paths.join(root, entries[0].name);
  }
  const rootStat = files.lstatSync(root);
  if (!rootStat._isDirectory || rootStat._isSymbolicLink) return;
  const manifestPath = paths.join(root, 'package.json'), abiPath = paths.join(root, 'project.abi');
  const mapPath = paths.join(root, 'project.abs.map.json');
  if (!regular(manifestPath) || !regular(abiPath) || !regular(mapPath)
    || files.existsSync(paths.join(root, 'project.abs'))
    || files.existsSync(paths.join(root, '.aily', 'abs-sync'))) return;
  let manifest: unknown, abi: any;
  try {
    manifest = JSON.parse(files.readFileSync(manifestPath, 'utf8'));
    if (detectProjectMode({ manifest, hasAbi: true, hasAci: files.existsSync(paths.join(root, 'project.aci')) }) !== 'blockly') return;
    abi = JSON.parse(files.readFileSync(abiPath, 'utf8'));
  } catch { return; }
  const object = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
  // Recognize the saved document only. Actual loading still validates all
  // blocks, identities, libraries and resources through the existing pipeline.
  if (!object(abi) || !(object(abi.blocks) || Array.isArray(abi.pages) && abi.pages.length > 0
    && abi.pages.every(page => object(page) && object(page.content) && object(page.content.blocks)))) return;
  const backupDirectory = paths.join(root, '.cloud-import-backup');
  if (files.existsSync(backupDirectory)) {
    const stat = files.lstatSync(backupDirectory);
    if (!stat._isDirectory || stat._isSymbolicLink) return;
  } else files.mkdirSync(backupDirectory);
  const backup = paths.join(backupDirectory, `project.abs.map.${crypto.randomUUID()}.json`);
  if (files.existsSync(backup)) throw new Error('Cloud map backup already exists; original map was retained.');
  files.renameSync(mapPath, backup);
  return backup;
}
