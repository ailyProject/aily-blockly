const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'ailyLocalLibrarySources'];
const fault = message => Object.assign(new Error(message), { code: 'LIBRARY_HISTORY_CONFLICT' });
const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
const dependencies = manifest => Object.fromEntries(fields.map(field => [field,
  Object.fromEntries(Object.entries(manifest[field] || {}).sort(([a], [b]) => a.localeCompare(b)))]));

/** Dependency history records intent and lock resolution, never library bytes.
 * Confirmed undo reuses the normal npm/source-preparation path. Canonical local
 * libraries remain user-owned; their content is never copied or rolled back. */
class LibraryHistory {
  constructor() { this.entries = new Map(); }

  async capture(root, names = []) {
    const packageText = read(path.join(root, 'package.json'));
    const lock = read(path.join(root, 'package-lock.json'));
    const links = [];
    for (const name of names) {
      const logical = path.join(root, 'node_modules', name);
      if (fs.lstatSync(logical, { throwIfNoEntry: false })?.isSymbolicLink()) {
        links.push({ name, target: fs.realpathSync(logical) });
      }
    }
    const inputs = dependencies(JSON.parse(packageText));
    if (JSON.stringify(dependencies(JSON.parse(read(path.join(root, 'package.json'))))) !== JSON.stringify(inputs)
      || read(path.join(root, 'package-lock.json')) !== lock) throw fault('Dependencies changed while recording library history.');
    return { dependencies: inputs, lock, links };
  }

  async begin(root, packages) {
    if (!Array.isArray(packages) || !packages.length) throw fault('Library history requires package names.');
    const names = [...new Set(packages.map(spec => {
      if (typeof spec !== 'string') throw fault('Invalid library history package.');
      const version = spec.indexOf('@', 1);
      const name = version < 0 ? spec : spec.slice(0, version);
      if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name) || name === '.' || name === '..') throw fault('Invalid library history package.');
      return name;
    }))];
    const token = randomUUID(), before = await this.capture(root, names);
    this.entries.set(token, { root, names, before });
    return { token };
  }

  get(root, token) {
    const entry = this.entries.get(token);
    if (!entry || entry.root !== root) throw fault('Library undo record is unavailable for this project.');
    return entry;
  }

  async commit(root, token) {
    const entry = this.get(root, token);
    if (entry.after) throw fault('Library history was already committed.');
    entry.after = await this.capture(root, entry.names);
    return { token, changed: JSON.stringify(this.identity(entry.before)) !== JSON.stringify(this.identity(entry.after)) };
  }

  identity(record) { return record; }

  async prepare(root, token, forward) {
    const entry = this.get(root, token);
    if (!entry.after || typeof forward !== 'boolean') throw fault('Library undo record is incomplete.');
    const target = forward ? entry.after : entry.before, expected = forward ? entry.before : entry.after;
    const current = await this.capture(root, entry.names);
    if (JSON.stringify(this.identity(current)) !== JSON.stringify(this.identity(expected))) {
      throw fault('Project dependencies changed since this undo step. The newer dependencies were retained.');
    }
    return { target, expected, names: entry.names };
  }

  async preview(root, token, forward) {
    const { target, expected, names } = await this.prepare(root, token, forward);
    const changes = [];
    for (const field of fields.filter(field => field !== 'ailyLocalLibrarySources')) {
      for (const name of new Set([...Object.keys(expected.dependencies[field]), ...Object.keys(target.dependencies[field])])) {
        const before = expected.dependencies[field][name], after = target.dependencies[field][name];
        if (before !== after) changes.push({ name, field, before: before ?? null, after: after ?? null });
      }
    }
    return { changes, packages: names };
  }

  patch(manifest, record) {
    const result = { ...manifest };
    for (const field of fields) {
      if (!Object.keys(record.dependencies[field]).length) delete result[field];
      else result[field] = record.dependencies[field];
    }
    return result;
  }

  async restoreLinks(root, record) {
    for (const { name, target } of record.links) {
      // npm validates the saved local spec first. Retain its original link
      // topology without reading or overwriting the canonical source tree.
      const logical = path.join(root, 'node_modules', name);
      if (!fs.existsSync(path.join(target, 'package.json'))) throw fault('Local library source is unavailable.');
      const parent = path.dirname(logical);
      fs.mkdirSync(parent, { recursive: true });
      const relative = path.relative(root, fs.realpathSync(parent));
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw fault('Library link destination escaped this project.');
      if (fs.existsSync(logical) && fs.realpathSync(logical) === target) continue;
      await fs.promises.rm(logical, { recursive: true, force: true });
      fs.symlinkSync(process.platform === 'win32' ? target : path.relative(parent, target), logical,
        process.platform === 'win32' ? 'junction' : 'dir');
    }
  }

  async discard(root, token) { this.get(root, token); this.entries.delete(token); }
}

module.exports = { LibraryHistory };
