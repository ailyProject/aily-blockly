const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const backupDirectories = new Set();
process.once('exit', () => { for (const directory of backupDirectories) {
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
} });

const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'ailyLocalLibrarySources'];
const fault = message => Object.assign(new Error(message), { code: 'LIBRARY_HISTORY_CONFLICT' });

/** Private, project-bound checkpoints. Only library inputs are restored;
 * unrelated project settings and independently refreshed build metadata survive. */
class LibraryHistory {
  constructor() { this.entries = new Map(); this.directories = new Set(); }

  capture(root, names, backup) {
    const reusable = backup ? [...this.entries.values()].filter(entry => entry.root === root)
      .flatMap(entry => [entry.before, entry.after].filter(Boolean).flatMap(snapshot => snapshot.sources))
      .filter(source => source.copy && names.includes(source.name)) : [];
    return runHistoryIO('capture', [root, names, backup, reusable]);
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
    const token = randomUUID(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-library-history-'));
    try {
      const before = await this.capture(root, names, path.join(directory, 'before'));
      backupDirectories.add(directory);
      this.directories.add(directory);
      this.entries.set(token, { root, names, directory, before });
      return { token };
    } catch (error) { await fs.promises.rm(directory, { recursive: true, force: true }); throw error; }
  }

  get(root, token) {
    const entry = this.entries.get(token);
    if (!entry || entry.root !== root) throw fault('Library undo checkpoint is unavailable for this project.');
    return entry;
  }

  async commit(root, token) {
    const entry = this.get(root, token);
    if (entry.after) throw fault('Library checkpoint was already committed.');
    entry.after = await this.capture(root, entry.names, path.join(entry.directory, 'after'));
    const changed = JSON.stringify(this.identity(entry.before)) !== JSON.stringify(this.identity(entry.after));
    return { token, changed };
  }

  identity(snapshot) {
    return { dependencies: snapshot.dependencies, lock: snapshot.lock,
      sources: snapshot.sources.map(({ copy, ...source }) => source) };
  }

  async prepare(root, token, forward) {
    const entry = this.get(root, token);
    if (!entry.after || typeof forward !== 'boolean') throw fault('Library undo checkpoint is incomplete.');
    const target = forward ? entry.after : entry.before, expected = forward ? entry.before : entry.after;
    const current = await this.capture(root, entry.names);
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

  restoreSources(...args) { return runHistoryIO('restoreSources', args); }
  restoreLinks(...args) { return runHistoryIO('restoreLinks', args); }

  async discard(root, token) {
    const entry = this.get(root, token);
    this.entries.delete(token);
    // A later step may share this immutable backup. Keep it until its last
    // reference disappears; never hard-link the editable package into history.
    const retained = [...this.entries.values()].flatMap(item => [item.directory,
      ...[item.before, item.after].filter(Boolean).flatMap(snapshot => snapshot.sources.map(source => source.copy).filter(Boolean))]);
    for (const directory of this.directories) {
      if (retained.some(file => file === directory || file.startsWith(directory + path.sep))) continue;
      await fs.promises.rm(directory, { recursive: true, force: true });
      this.directories.delete(directory); backupDirectories.delete(directory);
    }
  }
}

// Read through Electron's ASAR-aware fs once; the worker needs only Node built-ins.
// No native resource path or application module is resolved from an eval worker.
let ioSource;
function runHistoryIO(operation, args) {
  ioSource ??= fs.readFileSync(path.join(__dirname, 'library-history-io.js'), 'utf8');
  const { Worker } = require('node:worker_threads');
  return new Promise((resolve, reject) => {
    const worker = new Worker(ioSource + `
      const { parentPort, workerData } = require('node:worker_threads');
      try { parentPort.postMessage({ ok: true, value: module.exports[workerData.operation](...workerData.args) }); }
      catch (error) { parentPort.postMessage({ ok: false, error: { message: error.message, code: error.code } }); }
    `, { eval: true, workerData: { operation, args } });
    let result;
    worker.once('message', value => { result = value; });
    worker.once('error', reject);
    // Keep the caller's project lease until the worker has stopped touching files.
    worker.once('exit', code => {
      if (code === 0 && result?.ok) resolve(result.value);
      else reject(Object.assign(new Error(result?.error?.message || `Library history worker exited: ${code}`),
        { code: result?.error?.code || 'LIBRARY_HISTORY_IO_FAILED' }));
    });
  });
}

module.exports = { LibraryHistory };
