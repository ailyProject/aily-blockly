const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const realpath = fs.realpathSync.native || fs.realpathSync;
const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'ailyLocalLibrarySources'];
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const fault = message => Object.assign(new Error(message), { code: 'LIBRARY_HISTORY_CONFLICT' });
const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
const dependencies = manifest => Object.fromEntries(fields.map(field => [field,
  Object.fromEntries(Object.entries(manifest[field] || {}).sort(([a], [b]) => a.localeCompare(b)))]));

const sameFile = (a, b) => a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
  && (a.dev === b.dev || (process.platform === 'win32' && (a.dev === 0 || b.dev === 0)));

function captureSource(directory) {
  const digest = createHash('sha256'), seen = new Set(), observations = [];
  const root = realpath(directory), buffer = Buffer.allocUnsafe(64 * 1024);
  const changed = () => { throw fault('Library source changed while creating its undo checkpoint.'); };
  const visit = (directory, relative = '') => {
    const real = realpath(directory), directoryStat = fs.statSync(directory);
    if (!inside(root, real) || seen.has(real)) throw fault('Library source links changed or escape their package.');
    seen.add(real); observations.push({ file: directory, real, stat: directoryStat });
    for (const name of fs.readdirSync(directory).sort()) {
      if (['node_modules', '.git', '.DS_Store'].includes(name) || name.startsWith('.src-extract-')) continue;
      const file = path.join(directory, name), key = `${relative}/${name}`, stat = fs.statSync(file);
      digest.update(key); digest.update(stat.isDirectory() ? 'directory' : 'file');
      if (stat.isDirectory()) visit(file, key);
      else if (stat.isFile()) {
        const physical = realpath(file);
        if (!inside(root, physical)) throw fault('Library source escapes its package.');
        const fd = fs.openSync(file, 'r');
        try {
          const opened = fs.fstatSync(fd);
          if (!opened.isFile() || !sameFile(stat, opened)) changed();
          let bytes = 0, count;
          while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            if ((bytes += count) > opened.size) changed();
            digest.update(buffer.subarray(0, count));
          }
          if (bytes !== opened.size || !sameFile(opened, fs.fstatSync(fd))) changed();
          observations.push({ file, real: physical, stat });
        } finally { fs.closeSync(fd); }
      } else throw fault('Library history requires regular source files.');
    }
    seen.delete(real);
  };
  visit(directory);
  const confirm = () => {
    for (const { file, real, stat } of observations) {
      if (realpath(file) !== real || !sameFile(stat, fs.statSync(file))) changed();
    }
  };
  confirm();
  return { hash: digest.digest('hex'), confirm };
}
const sourceHash = directory => captureSource(directory).hash;


class LibraryHistoryIO {
  capture(root, names, backup, reusable = []) {
    const packageText = read(path.join(root, 'package.json'));
    const lock = read(path.join(root, 'package-lock.json'));
    const manifest = JSON.parse(packageText);
    const sources = names.map(name => {
      const logical = path.join(root, 'node_modules', name);
      if (!fs.existsSync(path.join(logical, 'package.json'))) return { name, exists: false };
      const physical = realpath(logical), captured = captureSource(physical), hash = captured.hash;
      const owned = inside(root, physical) ? path.relative(root, physical) : undefined;
      let copy = backup && owned ? path.join(backup, Buffer.from(name).toString('base64url')) : undefined;
      const existing = copy && reusable.find(source => source.name === name && source.hash === hash
        && fs.existsSync(source.copy) && sourceHash(source.copy) === hash);
      if (existing) {
        // Byte verification, never timestamp/cache-only acceptance. Windows
        // avoids thousands of fresh small-file creations for install → remove.
        captured.confirm();
        copy = existing.copy;
      } else if (copy) {
        fs.cpSync(physical, copy, { recursive: true, dereference: true, mode: fs.constants.COPYFILE_FICLONE,
          filter: file => !path.relative(physical, file).split(path.sep).some(part => ['node_modules', '.git', '.DS_Store'].includes(part)) });
        if (sourceHash(copy) !== hash) throw fault('Library changed while creating its undo checkpoint.');
        // Hash every current source and backup byte, but do not read the current
        // 200+ MiB font tree a second time. Descriptor/path identity, size and
        // change times fence the copy interval; no cross-operation stat cache.
        captured.confirm();
      }
      return { name, exists: true, hash, ...(fs.lstatSync(logical).isSymbolicLink() ? { link: physical } : {}), ...(owned ? { owned } : {}), ...(copy ? { copy } : {}) };
    });
    if (JSON.stringify(dependencies(JSON.parse(read(path.join(root, 'package.json'))))) !== JSON.stringify(dependencies(manifest))
      || read(path.join(root, 'package-lock.json')) !== lock) {
      throw fault('Project dependencies changed while capturing library history.');
    }
    return { dependencies: dependencies(manifest), lock, sources };
  }
  restoreSources(root, target, expected, npmManaged) {
    for (const source of target.sources) {
      if (!source.owned || source.owned.startsWith(`node_modules${path.sep}`) !== npmManaged) continue;
      const destination = path.join(root, source.owned);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (!inside(root, realpath(path.dirname(destination)))) {
        throw fault('Library undo destination is no longer project-owned.');
      }
      if (sourceHash(source.copy) !== source.hash) throw fault('Library undo source backup changed.');
      if (npmManaged && fs.lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(destination);
      if (fs.existsSync(destination)) {
        const hash = sourceHash(destination);
        if (hash === source.hash) continue;
        const previous = expected.sources.find(item => item.owned === source.owned);
        if (!npmManaged && (!previous || hash !== previous.hash)) throw fault('Newer local library sources were retained; undo did not overwrite them.');
      }
      const staging = fs.mkdtempSync(path.join(path.dirname(destination), '.library-history-'));
      try {
        fs.cpSync(source.copy, path.join(staging, 'source'), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
        if (fs.existsSync(destination)) fs.renameSync(destination, path.join(staging, 'previous'));
        try { fs.renameSync(path.join(staging, 'source'), destination); }
        catch (error) {
          if (fs.existsSync(path.join(staging, 'previous'))) fs.renameSync(path.join(staging, 'previous'), destination);
          throw error;
        }
      } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    }
    // Uninstalling a package does not delete its canonical local source. It may
    // predate the install and remain the user's only editable library copy.

  }

  restoreLinks(root, snapshot) {
    for (const source of snapshot.sources) {
      if (!source.link) continue;
      if (sourceHash(source.link) !== source.hash) throw fault('Linked library source changed; its newer contents were retained.');
      const logical = path.join(root, 'node_modules', source.name);
      fs.mkdirSync(path.dirname(logical), { recursive: true });
      if (!inside(root, realpath(path.dirname(logical)))) throw fault('Library link destination escaped this project.');
      if (fs.existsSync(logical) && realpath(logical) === source.link) continue;
      fs.rmSync(logical, { recursive: true, force: true });
      fs.symlinkSync(process.platform === 'win32' ? source.link : path.relative(path.dirname(logical), source.link), logical,
        process.platform === 'win32' ? 'junction' : 'dir');
    }
  }

}
module.exports = new LibraryHistoryIO();
