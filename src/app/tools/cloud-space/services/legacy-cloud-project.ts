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
 * ABI-based cloud archives can contain one leftover ABS companion. Preserve
 * it outside the active sync paths so the first save can establish a baseline.
 */
export function preserveUnpairedCloudProjectFile(extracted: string,
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
  const absPath = paths.join(root, 'project.abs'), mapPath = paths.join(root, 'project.abs.map.json');
  const hasAbs = files.existsSync(absPath), hasMap = files.existsSync(mapPath);

  if (!regular(manifestPath) || !regular(abiPath) || hasAbs === hasMap
    || files.existsSync(paths.join(root, '.aily', 'abs-sync'))
    || files.existsSync(paths.join(root, '.aily', 'workspace-mode.json'))) return;

  const unpaired = hasAbs ? absPath : mapPath;

  if (!regular(unpaired)) return;

  let manifest: unknown, abi: any;

  try {
    manifest = JSON.parse(files.readFileSync(manifestPath, 'utf8'));

    if (detectProjectMode({ manifest, hasAbi: true, hasAci: files.existsSync(paths.join(root, 'project.aci')) }) !== 'blockly') return;

    abi = JSON.parse(files.readFileSync(abiPath, 'utf8'));

    if (hasAbs) {
      const source = files.readFileSync(absPath, 'utf8');

      if (!/^# =+\r?\n# Blockly ABS File\r?\n# Generated: [^\r\n]+/u.test(source)
        || /^\s*#\s*@project-state\s*:/mu.test(source)) return;
    }
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

  const backupName = hasAbs ? `project.${crypto.randomUUID()}.abs` : `project.abs.map.${crypto.randomUUID()}.json`;
  const backup = paths.join(backupDirectory, backupName);

  if (files.existsSync(backup)) throw new Error('Cloud project backup already exists.');

  files.renameSync(unpaired, backup);

  return backup;
}
