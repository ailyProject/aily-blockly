const fs = require('node:fs');
const path = require('node:path');

// Only artifacts owned by the project writer. Do not exclude all .aily, *.tmp,
// backups, resource files or future sync recovery records.
function isProjectWriterTransient(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  const name = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  return name === '.aily/project-files.write.lock'
    || /^(?:\.aily\/abs-sync\/(?:baselines\/)?)?\.abs-sync-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(name)
    || /^\.(?:project\.(?:abi|abs|abs\.map\.json)|project-data-backup)\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(name);
}

/** Filtered directory copy, not a point-in-time snapshot or a multi-file transaction. */
function copyProjectDirectory(source, destination) {
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
  fs.cpSync(root, target, { recursive: true, force: false, errorOnExist: true,
    filter: file => !isProjectWriterTransient(path.relative(root, file)) });
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
  copyProjectDirectory(root, target);
  return destination;
}

module.exports = { copyProjectDirectory, importProjectDirectory, isProjectWriterTransient };
