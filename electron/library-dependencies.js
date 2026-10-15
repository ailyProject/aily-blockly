const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createProjectFileAccess, acquireProjectFileLock, assertNoPendingAbsGeneration } = require('./project-file-access');
const { readProjectMode } = require('./project-companion');

const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const deps = manifest => Object.assign({}, ...fields.map(field => manifest[field]));
const conflict = () => new Error('项目依赖已被外部修改，请先放弃未保存的库变更后重试。');
const workers = new Set();
let shuttingDown = false;

/** Process-owned memory survives a renderer refresh so reopen can restore the
 * saved dependency tree. package.json is authoritative outside this edit session. */
class LibraryDependencies {
  constructor({ run = runDependencyWorker, trashLocalDirectory } = {}) {
    this.run = run;
    this.states = new Map();
    this.queues = new Map();
    this.locals = new (require('./library-local-changes').LocalLibraryChanges)({ trash: trashLocalDirectory });
  }

  root(project) { return fs.realpathSync(project); }
  read(root) { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); }

  effective(root) {
    const disk = this.read(root), state = this.states.get(root);
    if (!state) return disk;
    const result = clone(disk);
    for (const field of [...fields, 'ailyLocalLibrarySources']) {
      const before = state.base[field] || {}, after = state.manifest[field] || {};
      for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (same(before[name], after[name])) continue;
        const current = disk[field]?.[name];
        if (!same(current, before[name]) && !same(current, after[name])) throw conflict();
        result[field] ||= {};
        if (after[name] === undefined) delete result[field][name];
        else result[field][name] = after[name];
      }
    }
    return { ...result, ...state.metadata };
  }

  status(project) {
    const root = this.root(project);
    return { dirty: this.states.has(root) || this.locals.dirty(root), busy: this.queues.has(root), manifest: this.effective(root) };
  }

  queue(project, operation) {
    const root = this.root(project);
    const previous = this.queues.get(root) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => operation(root));
    this.queues.set(root, task);
    const cleanup = () => { if (this.queues.get(root) === task) this.queues.delete(root); };
    void task.then(cleanup, cleanup);
    return task;
  }

  plan(disk, effective) {
    const before = deps(disk), after = deps(effective);
    return {
      add: Object.keys(after).filter(name => before[name] !== after[name]).map(name => `${name}@${after[name]}`),
      remove: Object.keys(before).filter(name => after[name] === undefined),
    };
  }

  async locked(root, operation) {
    const access = createProjectFileAccess(root, root);
    const lock = await acquireProjectFileLock(access, () => {});
    try {
      access.readRegular(path.join(root, 'package.json'));
      access.readRegular(path.join(root, 'package-lock.json'));
      assertNoPendingAbsGeneration(access); return await operation(lock.assertOwned);
    }
    finally { lock.release(); }
  }

  mutate(project, request) {
    return this.queue(project, root => this.locked(root, async assertCurrent => {
      const disk = this.read(root), previous = this.effective(root);
      const plan = this.plan(disk, previous);
      const names = request.packages;
      if (!Array.isArray(names) || !names.length || names.some(name => typeof name !== 'string' || !name || name.startsWith('-'))) {
        throw new Error('Invalid library packages');
      }
      const effective = clone(previous);
      if (request.action === 'remove') {
        for (const name of names) for (const field of [...fields, 'ailyLocalLibrarySources']) delete effective[field]?.[name];
        Object.assign(plan, this.plan(disk, effective));
      } else if (request.action === 'install') {
        // Replaying all outstanding additions/removals is essential: separate
        // npm --no-save commands prune earlier additions and resurrect removals.
        plan.install = names;
      } else throw new Error('Invalid library operation');
      const original = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
      let result;
      try {
        result = await this.run(root, { ...plan, options: request.options });
        assertCurrent();
        if (fs.readFileSync(path.join(root, 'package.json'), 'utf8') !== original) throw conflict();
      } catch (error) {
        // npm may have partially altered node_modules; restore the last accepted
        // tree. Never restore package.json bytes over an external writer.
        if (fs.readFileSync(path.join(root, 'package.json'), 'utf8') === original) {
          try { await this.run(root, { ...this.plan(disk, previous), options: request.options }); }
          catch (rollback) {
            // Keep a recoverable dirty session even when the first operation
            // failed: discard must retry repairing the actual dependency tree.
            if (!this.states.has(root)) this.states.set(root, { base: disk, manifest: previous, options: request.options, metadata: {} });
            throw new AggregateError([error, rollback], `库操作失败，依赖恢复也失败：${error.message}; ${rollback.message}`);
          }
        }
        throw error;
      }
      const manifest = { ...effective };
      for (const field of fields) {
        if (result.manifest[field]) manifest[field] = result.manifest[field];
        else delete manifest[field];
      }
      if (request.localSources) manifest.ailyLocalLibrarySources = { ...manifest.ailyLocalLibrarySources, ...request.localSources };
      const prior = this.states.get(root);
      this.states.set(root, { base: prior?.base || disk, manifest, options: request.options || prior?.options, metadata: prior?.metadata || {} });
      if (fields.every(field => same(manifest[field] || {}, disk[field] || {}))
        && same(manifest.ailyLocalLibrarySources, disk.ailyLocalLibrarySources) && !Object.keys(prior?.metadata || {}).length) this.states.delete(root);
      return this.status(root);
    }));
  }

  patch(project, manifest) {
    return this.queue(project, root => {
      const disk = this.read(root);
      const state = this.states.get(root) || { base: disk, manifest: clone(disk), metadata: {} };
      const current = this.effective(root);
      for (const [key, value] of Object.entries(manifest)) {
        if (fields.includes(key) && !same(value, current[key])) throw new Error('请先保存或放弃库变更，再修改项目依赖配置。');
        if (!same(value, current[key]) && !fields.includes(key) && key !== 'ailyLocalLibrarySources') state.metadata[key] = value;
      }
      if (Object.keys(state.metadata).length) this.states.set(root, state);
      return this.status(root);
    });
  }

  removeLocal(project, { folderName }) {
    return this.queue(project, root => this.locked(root, async () => {
      await this.locals.remove(root, folderName);
      return this.status(root);
    }));
  }

  restore(project, snapshot) {
    return this.queue(project, root => this.locked(root, async () => {
      const disk = this.read(root);
      if (!same(this.states.get(root), snapshot.state)) {
        await this.run(root, { ...this.plan(disk, snapshot.manifest), options: snapshot.state?.options });
      }
      if (snapshot.state) this.states.set(root, clone(snapshot.state));
      else this.states.delete(root);
      await this.locals.restore(root, snapshot.locals);
      return this.status(root);
    }));
  }

  save(project) {
    return this.queue(project, root => this.locked(root, async assertCurrent => {
      const state = this.states.get(root);
      if (!state) { this.locals.save(root); return this.status(root); }
      const disk = this.read(root), effective = this.effective(root);
      // npm owns lockfile creation and resolution. Only this explicit save is
      // permitted to write the root manifest/lockfile; no installation is deferred.
      await this.run(root, { ...this.plan(disk, effective), options: state.options, save: true });
      assertCurrent();
      const saved = this.read(root);
      for (const field of [...fields, 'ailyLocalLibrarySources']) {
        if (effective[field] === undefined) delete saved[field];
        else saved[field] = effective[field];
      }
      Object.assign(saved, state.metadata);
      const temp = path.join(root, `.package.json.${require('node:crypto').randomUUID()}.tmp`);
      try { fs.writeFileSync(temp, JSON.stringify(saved, null, 2) + '\n', { flag: 'wx' }); assertCurrent(); fs.renameSync(temp, path.join(root, 'package.json')); }
      finally { fs.rmSync(temp, { force: true }); }
      this.states.delete(root);
      this.locals.save(root);
      return this.status(root);
    }));
  }

  discard(project, { reconcile = false, historyRestored = false } = {}) {
    return this.queue(project, root => this.locked(root, async () => {
      const state = this.states.get(root);
      if (historyRestored) this.locals.save(root);
      if (!state && !reconcile) {
        await this.locals.restore(root);
        return this.status(root);
      }
      // Read the CURRENT saved manifest: Chat restore/external edits are never
      // overwritten with an old in-memory baseline.
      await this.run(root, {
        add: [], remove: [], options: state?.options,
        // Only Coder's clean reopen uses the fast tree check. Blockly retains
        // its existing npm reconciliation, including Chat history reloads.
        reconcileOnly: reconcile && !state && !historyRestored && isCoderProject(root),
      });
      this.states.delete(root);
      await this.locals.restore(root);
      return this.status(root);
    }));
  }
}

function isCoderProject(root) {
  try { return readProjectMode(root) === 'coder'; }
  catch { return false; }
}

function runDependencyWorker(root, request) {
  if (shuttingDown) return Promise.reject(new Error('Application is shutting down'));
  const childRoot = process.env.AILY_CHILD_PATH || path.join(__dirname, '..', 'child');
  const node = path.join(childRoot, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  const npmRoot = path.join(childRoot, 'node', process.platform === 'win32' ? 'node_modules/npm' : 'lib/node_modules/npm');
  const source = fs.readFileSync(path.join(__dirname, 'library-dependency-worker.js'), 'utf8');
  return new Promise((resolve, reject) => {
    const child = spawn(node, ['-e', source], { cwd: root, windowsHide: true,
      env: { ...process.env, AILY_LIBRARY_WORKER: '1' }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    workers.add(child);
    let response, detail = '';
    child.on('message', value => { response = value; });
    child.stdout.on('data', value => { detail = (detail + value).slice(-8000); });
    child.stderr.on('data', value => { detail = (detail + value).slice(-8000); });
    child.on('error', error => { workers.delete(child); reject(error); });
    child.on('close', code => {
      workers.delete(child);
      response?.ok && code === 0 ? resolve(response) : reject(new Error(response?.error || detail || `npm dependency worker exited: ${code}`));
    });
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify({ ...request, npmRoot }));
  });
}

async function stopLibraryDependencyWorkers() {
  shuttingDown = true;
  const { killRegisteredProcessTree } = require('./process-tree');
  return Promise.all([...workers].map(child => killRegisteredProcessTree(child.pid, 'library-dependencies')));
}

module.exports = { LibraryDependencies, runDependencyWorker, stopLibraryDependencyWorkers };
