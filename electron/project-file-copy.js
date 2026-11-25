const fs = require('node:fs');
const path = require('node:path');
const { copyProjectLibraryLink } = require('./project-library-copy');
const { readProjectMode } = require('./project-companion');
const SAVE_AS_EXCLUDED_DIRECTORIES = new Set(['.workspace-history', '.temp', '.log', '.build']);
const CODER_HISTORY_COPY_INPUTS = ['.workspace-history', '.aily/workspace-mode.json'];
const BUILD_WORKSPACE_OWNER_FILES = new Set([
  '.build/aily-workspace.lock', '.build/aily-builder.lock', '.build/aily-workspace-recovery.lock',
]);

// Runtime ownership belongs to the source's physical workspace, never a new copy.
// Preserve other recovery/resource data. The view anchor may be locked by Windows.
function isProjectWriterTransient(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  const folded = normalized.toLowerCase();
  const name = process.platform === 'win32' ? folded : normalized;
  return name === '.aily/project-files.write.lock'
    || /^\.aily\/\.project-files\.write\.lock\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/.test(name)
    || folded === '.aily/project-open.lock'
    || folded === '.aily/project-view.guard'
    || /^\.aily\/\.project-open\.lock\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/.test(folded)
    || name === '.aily/build-executions' || name === '.aily/cloud-build' || name === '.build/requests'
    || /^\.log\/compile\/requests\/(?:[a-f0-9]{64}\.build\.json|\.build-receipts\.guard)$/.test(name)
    || BUILD_WORKSPACE_OWNER_FILES.has(name)
    || /^(?:\.aily\/abs-sync\/(?:baselines\/)?)?\.abs-sync-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(name)
    || /^\.(?:project\.(?:abi|abs|abs\.map\.json)|project-data-backup)\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(name);
}

function coderCopyHistory(root, coderTemplate) {
  const inputs = new Map();
  const metadata = fs.lstatSync(path.join(root, '.aily'), { throwIfNoEntry: false });
  const historyEntries = CODER_HISTORY_COPY_INPUTS.flatMap(name => {
    if (name.startsWith('.aily/') && !metadata?.isDirectory()) return [];
    const source = path.join(root, name);
    const entry = fs.lstatSync(source, { throwIfNoEntry: false });
    return entry ? [{ source, name, entry }] : [];
  });
  if (!historyEntries.length) return inputs;
  const manifestPath = path.join(root, 'package.json');
  const manifest = fs.lstatSync(manifestPath, { throwIfNoEntry: false });
  if (manifest?.isSymbolicLink()) throw new Error('Project metadata must not be copied through a symbolic link.');
  if (!coderTemplate) {
    try {
      if (readProjectMode(root) !== 'coder') return inputs;
      const absPath = path.join(root, 'project.abs');
      const abs = fs.lstatSync(absPath, { throwIfNoEntry: false });
      // Match the editor's ABS-only Blockly fallback even when an obsolete
      // Coder launcher is present. An explicit Coder manifest still wins.
      if (abs?.isFile() && (!manifest || JSON.parse(fs.readFileSync(manifestPath, 'utf8'))?.type !== 'coder')
        && fs.readFileSync(absPath).includes('\n# @project-state:')) return inputs;
    } catch { return inputs; }
  }
  if (metadata?.isSymbolicLink()) throw new Error('Project metadata must not be copied through a symbolic link.');
  for (const { source, name, entry } of historyEntries) {
    if (entry.isSymbolicLink()) throw new Error('Coder History metadata must not be copied through a symbolic link.');
    // Use the actual directory-entry spelling on a case-insensitive filesystem.
    inputs.set(path.relative(root, fs.realpathSync.native(source)), { source, name: path.basename(name) });
  }
  return inputs;
}

function archiveCoderCopyHistory(target, history) {
  if (!history.size) return;
  const metadata = path.join(target, '.aily');
  const recovery = path.join(metadata, 'history-recovery');
  for (const directory of [metadata, recovery]) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('Coder History recovery requires a regular directory.');
  }
  const archive = fs.mkdtempSync(path.join(recovery, 'copy-'));
  for (const { source, name } of history.values()) {
    fs.cpSync(source, path.join(archive, name), {
      recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true,
    });
  }
}

/** Filtered directory copy, not a point-in-time snapshot or a multi-file transaction. */
function copyProjectContents(source, destination, { excludeRuntimeDirectories, recoveryCopy, coderTemplate }) {
  if (!path.isAbsolute(source) || !path.isAbsolute(destination)) throw new Error('Project copy requires absolute paths.');
  const root = fs.realpathSync(source);
  const target = fs.realpathSync(destination); // Caller must reserve the destination first.
  const relative = path.relative(root, target);
  if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
    throw new Error('Project copy destination must not be inside the source project.');
  }
  if (!fs.lstatSync(root).isDirectory() || !fs.lstatSync(target).isDirectory()
    || fs.lstatSync(destination).isSymbolicLink()) throw new Error('Project copy requires regular directories.');
  if (fs.readdirSync(target).length) throw new Error('Project copy destination must be empty.');
  const history = coderCopyHistory(root, coderTemplate);
  const libraryLinks = [];
  fs.cpSync(root, target, { recursive: true, force: false, errorOnExist: true,
    filter: file => {
      const relativePath = path.relative(root, file);
      if (history.has(relativePath)) return false;
      const name = process.platform === 'win32' ? relativePath.toLowerCase() : relativePath;
      const normalized = name.split(path.sep).join('/');
      if (coderTemplate && ['package.json', 'project.aci'].includes(normalized)) return false;
      if (relativePath && fs.lstatSync(file).isSymbolicLink()) {
        if (coderTemplate) throw new Error('Coder project templates must not contain symbolic links.');
        if (['package.json', 'project.abi', 'project.abs', 'project.abs.map.json', '.aily'].includes(normalized)) {
          throw new Error('Project metadata must not be copied through a symbolic link.');
        }
        if (/^node_modules\/@aily-project\/lib-[^/]+$/.test(normalized)) {
          libraryLinks.push(relativePath); return false;
        }
      }
      return !isProjectWriterTransient(relativePath)
        && !(recoveryCopy && ['project.abs', 'project.abs.map.json', '.aily/abs-sync'].includes(normalized))
        && !(excludeRuntimeDirectories && SAVE_AS_EXCLUDED_DIRECTORIES.has(name)
          && fs.statSync(file, { throwIfNoEntry: false })?.isDirectory());
    } });
  for (const relative of libraryLinks) copyProjectLibraryLink(root, target, relative);
  // A fresh project owns a new History. Keep its predecessor outside the active
  // store; the existing cloud rule excludes the enclosing .aily directory.
  archiveCoderCopyHistory(target, history);
}

function copyProjectDirectory(source, destination, excludeRuntimeDirectories = true, recoveryCopy = false) {
  return copyProjectContents(source, destination, { excludeRuntimeDirectories, recoveryCopy });
}

function copyCoderTemplateDirectory(source, destination) {
  if (!fs.lstatSync(source).isDirectory()) throw new Error('Coder project templates must be regular directories.');
  return copyProjectContents(source, destination, { excludeRuntimeDirectories: true, coderTemplate: true });
}

/** A recovery target starts without another physical workspace's ABS authority. */
function copyRecoveryProjectDirectory(source, destination) {
  return copyProjectDirectory(source, destination, true, true);
}

// Resolve existing ancestors before creating anything, including destinations under a junction.
function resolveFutureDirectory(directory) {
  try { return fs.realpathSync(directory); }
  catch (error) {
    const parent = path.dirname(directory);
    if (error.code !== 'ENOENT' || parent === directory) throw error;
    return path.join(resolveFutureDirectory(parent), path.basename(directory));
  }
}

function hasPackage(directory) {
  return fs.lstatSync(path.join(directory, 'package.json'), { throwIfNoEntry: false })?.isFile() === true;
}

/** Resolve a downloaded archive's single wrapper before copying its extracted project. */
function importProjectDirectory(source, destination, unwrapArchive = false) {
  if (!path.isAbsolute(source) || !path.isAbsolute(destination) || typeof unwrapArchive !== 'boolean') {
    throw new Error('Project import requires absolute paths and an explicit archive option.');
  }
  let root = fs.realpathSync(source);
  if (!hasPackage(root) && unwrapArchive) {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    if (entries.length === 1 && entries[0].isDirectory() && !entries[0].isSymbolicLink()) root = path.join(root, entries[0].name);
  }
  if (!hasPackage(root)) throw new Error('Project import source must contain package.json (at root or in one archive wrapper).');
  const parent = resolveFutureDirectory(path.dirname(destination));
  const target = path.join(parent, path.basename(destination));
  const relative = path.relative(root, target);
  if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) {
    throw new Error('Project import destination must not be inside the source project.');
  }
  // An existing directory is never deleted or merged, even on random-name collision.
  fs.mkdirSync(parent, { recursive: true });
  fs.mkdirSync(target);
  const created = fs.lstatSync(target, { bigint: true });
  try {
    copyProjectDirectory(root, target, false);
    // Folder and cloud archive imports may have read-only source metadata.
    for (const name of ['package.json', 'project.abi', 'project.abs', 'project.abs.map.json']) {
      const file = path.join(target, name);
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (stat?.isFile() && !(stat.mode & 0o200)) fs.chmodSync(file, (stat.mode & 0o7777) | 0o200);
    }
  } catch (error) {
    try {
      const current = fs.lstatSync(target, { bigint: true, throwIfNoEntry: false });
      if (current?.isDirectory() && !current.isSymbolicLink() && current.dev === created.dev && current.ino === created.ino
        && current.birthtimeNs === created.birthtimeNs) fs.rmSync(target, { recursive: true, force: true });
    } catch (cleanupError) {
      console.warn('Could not clean incomplete project import:', target, cleanupError);
    }
    throw error;
  }
  return destination;
}

module.exports = { copyProjectDirectory, copyCoderTemplateDirectory, copyRecoveryProjectDirectory,
  importProjectDirectory, isProjectWriterTransient };
