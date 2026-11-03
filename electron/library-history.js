const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const backupDirectories = new Set();
process.once('exit', () => { for (const directory of backupDirectories) {
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
} });

const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'ailyLocalLibrarySources'];
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const fault = message => Object.assign(new Error(message), { code: 'LIBRARY_HISTORY_CONFLICT' });
const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
const dependencies = manifest => Object.fromEntries(fields.map(field => [field,
  Object.fromEntries(Object.entries(manifest[field] || {}).sort(([a], [b]) => a.localeCompare(b)))]));

function sourceHash(directory) {
  const digest = createHash('sha256'), seen = new Set();
  const visit = (directory, relative = '') => {
    const real = fs.realpathSync(directory);
    if (!inside(root, real) || seen.has(real)) throw fault('Library source links changed or escape their package.');
    seen.add(real);
    for (const name of fs.readdirSync(directory).sort()) {
      if (['node_modules', '.git', '.DS_Store'].includes(name) || name.startsWith('.src-extract-')) continue;
      const file = path.join(directory, name), key = `${relative}/${name}`, stat = fs.statSync(file);
      digest.update(key); digest.update(stat.isDirectory() ? 'directory' : 'file');
      if (stat.isDirectory()) visit(file, key);
      else if (stat.isFile()) {
        if (!inside(root, fs.realpathSync(file))) throw fault('Library source escapes its package.');
        digest.update(fs.readFileSync(file));
      } else throw fault('Library history requires regular source files.');
    }
    seen.delete(real);
  };
  const root = fs.realpathSync(directory);
  visit(directory);
  return digest.digest('hex');
}

/** Private, project-bound checkpoints. Only library inputs are restored;
 * unrelated project settings and independently refreshed build metadata survive. */
class LibraryHistory {
  constructor() { this.entries = new Map(); }

  capture(root, names, backup) {
    const packageText = read(path.join(root, 'package.json'));
    const manifest = JSON.parse(packageText);
    const sources = names.map(name => {
      const logical = path.join(root, 'node_modules', name);
      if (!fs.existsSync(path.join(logical, 'package.json'))) return { name, exists: false };
      const physical = fs.realpathSync(logical), hash = sourceHash(physical);
      const owned = inside(root, physical) ? path.relative(root, physical) : undefined;
      const copy = backup && owned ? path.join(backup, Buffer.from(name).toString('base64url')) : undefined;
      if (copy) {
        fs.cpSync(physical, copy, { recursive: true, dereference: true,
          filter: file => !path.relative(physical, file).split(path.sep).some(part => ['node_modules', '.git', '.DS_Store'].includes(part)) });
        if (sourceHash(physical) !== hash || sourceHash(copy) !== hash) throw fault('Library changed while creating its undo checkpoint.');
      }
      return { name, exists: true, hash, ...(fs.lstatSync(logical).isSymbolicLink() ? { link: physical } : {}), ...(owned ? { owned } : {}), ...(copy ? { copy } : {}) };
    });
    return { dependencies: dependencies(manifest), lock: read(path.join(root, 'package-lock.json')), sources };
  }

  begin(root, packages) {
    if (!Array.isArray(packages) || !packages.length) throw fault('Library history requires package names.');
    const names = [...new Set(packages.map(spec => {
      if (typeof spec !== 'string') throw fault('Invalid library history package.');
      const version = spec.indexOf('@', 1);
      const name = version < 0 ? spec : spec.slice(0, version);
      if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name) || name === '.' || name === '..') throw fault('Invalid library history package.');
      return name;
    }))];
    const token = randomUUID(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-library-history-'));
    try {
      const before = this.capture(root, names, path.join(directory, 'before'));
      backupDirectories.add(directory);
      this.entries.set(token, { root, names, directory, before });
      return { token };
    } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  }

  get(root, token) {
    const entry = this.entries.get(token);
    if (!entry || entry.root !== root) throw fault('Library undo checkpoint is unavailable for this project.');
    return entry;
  }

  commit(root, token) {
    const entry = this.get(root, token);
    if (entry.after) throw fault('Library checkpoint was already committed.');
    entry.after = this.capture(root, entry.names, path.join(entry.directory, 'after'));
    const changed = JSON.stringify(this.identity(entry.before)) !== JSON.stringify(this.identity(entry.after));
    return { token, changed };
  }

  identity(snapshot) {
    return { dependencies: snapshot.dependencies, lock: snapshot.lock,
      sources: snapshot.sources.map(({ copy, ...source }) => source) };
  }

  prepare(root, token, forward) {
    const entry = this.get(root, token);
    if (!entry.after || typeof forward !== 'boolean') throw fault('Library undo checkpoint is incomplete.');
    const target = forward ? entry.after : entry.before, expected = forward ? entry.before : entry.after;
    const current = this.capture(root, entry.names);
    if (JSON.stringify(this.identity(current)) !== JSON.stringify(this.identity(expected))) {
      throw fault('Project dependencies or library sources changed since this undo step. The newer files were retained.');
    }
    return { target, expected, names: entry.names };
  }

  patch(manifest, snapshot) {
    const result = { ...manifest };
    for (const field of fields) {
      if (!Object.keys(snapshot.dependencies[field]).length) delete result[field];
      else result[field] = snapshot.dependencies[field];
    }
    return result;
  }

  restoreSources(root, target, expected, npmManaged) {
    for (const source of target.sources) {
      if (!source.owned || source.owned.startsWith(`node_modules${path.sep}`) !== npmManaged) continue;
      const destination = path.join(root, source.owned);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (!inside(root, fs.realpathSync(path.dirname(destination)))) {
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
        fs.cpSync(source.copy, path.join(staging, 'source'), { recursive: true });
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
      if (!inside(root, fs.realpathSync(path.dirname(logical)))) throw fault('Library link destination escaped this project.');
      if (fs.existsSync(logical) && fs.realpathSync(logical) === source.link) continue;
      fs.rmSync(logical, { recursive: true, force: true });
      fs.symlinkSync(process.platform === 'win32' ? source.link : path.relative(path.dirname(logical), source.link), logical,
        process.platform === 'win32' ? 'junction' : 'dir');
    }
  }

  discard(root, token) {
    const entry = this.get(root, token);
    this.entries.delete(token);
    backupDirectories.delete(entry.directory);
    fs.rmSync(entry.directory, { recursive: true, force: true });
  }
}

module.exports = { LibraryHistory };
