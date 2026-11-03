const fs = require('node:fs');
const path = require('node:path');
const { copyProjectLibraryLink } = require('./project-library-copy');
const SAVE_AS_EXCLUDED_DIRECTORIES = new Set(['.workspace-history', '.temp', '.log', '.build']);
const BUILD_WORKSPACE_OWNER_FILES = new Set([
  '.build/aily-workspace.lock', '.build/aily-builder.lock', '.build/aily-workspace-recovery.lock',
]);

// Runtime ownership belongs to the source's physical workspace, never a new copy.
// Preserve all other recovery/resource data and the harmless native lock anchor.
function isProjectWriterTransient(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  const name = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  return name === '.aily/project-files.write.lock'
    || name === '.aily/project-open.lock'
    || BUILD_WORKSPACE_OWNER_FILES.has(name)
    || /^(?:\.aily\/abs-sync\/(?:baselines\/)?)?\.abs-sync-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(name)
    || /^\.(?:project\.(?:abi|abs|abs\.map\.json)|project-data-backup)\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(name);
}

/** Filtered directory copy, not a point-in-time snapshot or a multi-file transaction. */
function copyProjectDirectory(source, destination, excludeRuntimeDirectories = true, recoveryCopy = false) {
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
  const libraryLinks = [];
  fs.cpSync(root, target, { recursive: true, force: false, errorOnExist: true,
    filter: file => {
      const relativePath = path.relative(root, file);
      const name = process.platform === 'win32' ? relativePath.toLowerCase() : relativePath;
      const normalized = name.split(path.sep).join('/');
      if (relativePath && fs.lstatSync(file).isSymbolicLink()) {
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

/** Resolve an archive's single wrapper before reserving a new project directory. */
function importProjectDirectory(source, destination, unwrapArchive = false) {
  if (!path.isAbsolute(source) || !path.isAbsolute(destination) || typeof unwrapArchive !== 'boolean') {
    throw new Error('Project import requires absolute paths and an explicit archive option.');
  }
  let root = fs.realpathSync(source);
  const hasPackage = directory => {
    try { const stat = fs.lstatSync(path.join(directory, 'package.json')); return stat.isFile() && !stat.isSymbolicLink(); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  if (!hasPackage(root) && unwrapArchive) {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    if (entries.length === 1 && entries[0].isDirectory() && !entries[0].isSymbolicLink()) root = path.join(root, entries[0].name);
  }
  if (!hasPackage(root)) throw new Error('Project import source must contain package.json (at root or in one archive wrapper).');
  const parent = resolveFutureDirectory(path.dirname(destination));
  const target = path.join(parent, path.basename(destination));
  const relative = path.relative(root, target);
  if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
    throw new Error('Project import destination must not be inside the source project.');
  }
  // An existing directory is never deleted or merged, even on random-name collision.
  fs.mkdirSync(parent, { recursive: true });
  fs.mkdirSync(target);
  // Imports preserve caches/artifacts, but never another workspace's runtime ownership.
  copyProjectDirectory(root, target, false);
  // Zip archives may mark project metadata read-only. These are fresh copies
  // that the importer and project-data writer must update; leave the archive
  // source and installed libraries untouched.
  for (const name of ['package.json', 'project.abi', 'project.abs', 'project.abs.map.json']) {
    const file = path.join(target, name);
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isFile() && !(stat.mode & 0o200)) fs.chmodSync(file, (stat.mode & 0o7777) | 0o200);
  }
  return destination;
}

module.exports = { copyProjectDirectory, copyRecoveryProjectDirectory, importProjectDirectory, isProjectWriterTransient };
