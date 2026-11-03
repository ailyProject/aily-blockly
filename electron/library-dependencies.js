const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createProjectFileAccess, acquireProjectFileLock, assertNoPendingAbsGeneration } = require('./project-file-access');
const { readProjectMode } = require('./project-companion');
const { mergeDependencies, LibraryDependencyConflicts, archiveDependencyResolution, digest, fault } = require('./library-dependency-conflicts');

const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const deps = manifest => Object.assign({}, ...fields.map(field => manifest[field]));
// Build fingerprints can be refreshed independently while npm is running.
// Keep all other project inputs guarded, and preserve the latest fingerprints.
const sameLibraryInput = (before, after) => {
  const input = text => {
    const { codeHash, buildInfo, ...manifest } = JSON.parse(text);
    return manifest;
  };
  try { return same(input(before), input(after)); } catch { return false; }
};
const conflict = () => fault('LIBRARY_DEPENDENCY_INPUT_CHANGED', 'Project dependencies changed outside this operation. Inspect dependency recovery; every version was retained.');
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
    this.conflicts = new LibraryDependencyConflicts();
    this.history = new (require('./library-history').LibraryHistory)();
  }

  root(project) { return fs.realpathSync(project); }
  read(root) { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); }

  effective(root) {
    const input = this.dependencyInput(root), disk = JSON.parse(input.package), state = this.states.get(root);
    const merged = mergeDependencies(disk, state);
    if (merged.conflicts.length) throw fault('LIBRARY_DEPENDENCY_CONFLICT', 'Dependency entries have conflicting staged and disk changes. Inspect and choose only those entries; no version was discarded.',
      this.describeConflicts(root, disk, state, merged.conflicts, input));
    return merged.manifest;
  }

  dependencyInput(root) {
    const read = name => fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name), 'utf8') : null;
    return { package: read('package.json'), lock: read('package-lock.json'), state: clone(this.states.get(root) || null) };
  }

  describeConflicts(root, disk, state, entries, input) {
    return this.conflicts.inspect(root, digest(JSON.stringify(input)), state, entries,
      { base: state.base, staged: state.manifest, disk, packageText: input.package, lockText: input.lock });
  }

  status(project) {
    const root = this.root(project);
    const input = this.dependencyInput(root), disk = JSON.parse(input.package), state = this.states.get(root), merged = mergeDependencies(disk, state);
    const dependencyConflict = merged.conflicts.length ? this.describeConflicts(root, disk, state, merged.conflicts, input) : undefined;
    return { dirty: this.states.has(root) || this.locals.dirty(root), busy: this.queues.has(root),
      manifest: dependencyConflict ? null : merged.manifest, ...(dependencyConflict ? { dependencyConflict } : {}),
      ...(state?.treeNeedsReconcile ? { treeNeedsReconcile: true,
        ...(state.reconcileFailure ? { reconcileFailure: clone(state.reconcileFailure) } : {}),
        ...(state.resolution?.archiveFile ? { recoveryArchive: state.resolution.archiveFile } : {}) } : {}) };
  }

  async recover(project, request) {
    const root = this.root(project);
    if (request?.version !== 1 || !['inspect', 'resolve', 'observe'].includes(request.action)
      || Object.keys(request).some(name => !['version', 'action', 'token', 'requestId', 'choices'].includes(name)))
      return Promise.reject(fault('LIBRARY_DEPENDENCY_RECOVERY_INVALID', 'Invalid dependency recovery request.'));
    if (request.action === 'inspect' && ['token', 'requestId', 'choices'].some(name => request[name] !== undefined)
      || request.action === 'observe' && request.choices !== undefined)
      return Promise.reject(fault('LIBRARY_DEPENDENCY_RECOVERY_INVALID', 'Inspection and observation cannot submit dependency choices.'));
    if (request.action === 'inspect') return Promise.resolve(this.status(root));
    if (request.action === 'observe') {
      const entry = this.conflicts.find(root, request.token, request.requestId);
      return Promise.resolve({ freshCompletion: false, dependencyRecovery: this.conflicts.describe(entry), ...this.status(root) });
    }
    const previous = this.conflicts.find(root, request.token, request.requestId);
    if (previous.status === 'completed') {
      this.conflicts.decide(root, request); // Validate exact original choices, without taking a new writer lease.
      return Promise.resolve({ freshCompletion: false, dependencyRecovery: this.conflicts.describe(previous), ...this.status(root) });
    }
    if (this.queues.has(root)) return Promise.reject(fault('LIBRARY_DEPENDENCY_RECOVERY_BUSY', 'A dependency operation is active. Observe it before resolving conflicts.'));
    return this.queue(root, current => this.locked(current, () => {
      const state = this.states.get(current), input = this.dependencyInput(current);
      const decision = this.conflicts.decide(current, request, digest(JSON.stringify(input)), state);
      if (!decision.completed) {
        const disk = JSON.parse(input.package), merged = mergeDependencies(disk, state).manifest;
        for (const choice of request.choices) {
          const entry = decision.entry.conflicts.find(item => item.field === choice.field && item.name === choice.name);
          const value = entry[choice.choice]; merged[entry.field] ||= {};
          if (value === null) delete merged[entry.field][entry.name]; else merged[entry.field][entry.name] = value;
        }
        this.states.set(current, { ...state, base: disk, manifest: merged, treeNeedsReconcile: true, reconcileFailure: undefined,
          resolution: { requestId: decision.entry.requestId, evidence: decision.entry.evidence, choices: clone(request.choices) } });
        this.conflicts.complete(decision.entry, decision.signature, request.choices);
      }
      return { freshCompletion: !decision.completed, dependencyRecovery: this.conflicts.describe(decision.entry), ...this.status(current) };
    }));
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
        if (!sameLibraryInput(original, fs.readFileSync(path.join(root, 'package.json'), 'utf8'))) throw conflict();
      } catch (error) {
        // npm may have partially altered node_modules; restore the last accepted
        // tree. Never restore package.json bytes over an external writer.
        if (sameLibraryInput(original, fs.readFileSync(path.join(root, 'package.json'), 'utf8'))) {
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

  async prepareSources(root, assertCurrent) {
    const before = this.dependencyInput(root);
    await this.run(root, { materializeSources: true, manifest: this.effective(root) });
    assertCurrent();
    const after = this.dependencyInput(root);
    if (!sameLibraryInput(before.package, after.package) || after.lock !== before.lock) throw conflict();
  }

  prepare(project) {
    // Opening/reloading can already own the renderer's project-file lease.
    // Source expansion writes only package-local src; serialize it with npm,
    // and verify inputs without nesting the manifest/mirror publication lock.
    return this.queue(project, async root => {
      const access = createProjectFileAccess(root, root);
      await this.prepareSources(root, access.checkRoot);
      return this.status(root);
    });
  }

  save(project, { prepareSources = false, onPublish = () => {} } = {}) {
    return this.queue(project, root => this.locked(root, async assertCurrent => {
      const state = this.states.get(root);
      if (!state) {
        if (prepareSources) await this.prepareSources(root, assertCurrent);
        this.locals.save(root); return this.status(root);
      }
      const disk = this.read(root), effective = this.effective(root);
      if (state.treeNeedsReconcile) {
        state.resolution.archiveFile = archiveDependencyResolution(root, state.resolution);
        const before = this.dependencyInput(root);
        try {
          await this.run(root, { ...this.plan(disk, effective), options: state.options });
          assertCurrent();
          const current = this.dependencyInput(root);
          if (this.states.get(root) !== state || current.package !== before.package || current.lock !== before.lock) throw conflict();
        } catch (error) {
          state.reconcileFailure = { code: error.code || 'LIBRARY_DEPENDENCY_RECONCILE_FAILED', phase: 'reconcile',
            message: error.message, outcome: 'not-saved', requiresInspection: true };
          throw Object.assign(error, { recoveryArchive: state.resolution.archiveFile, treeNeedsReconcile: true });
        }
      }
      // npm owns lockfile creation and resolution. Library transactions call
      // this after source preparation, independently of saving editor content.
      if (prepareSources) await this.prepareSources(root, assertCurrent);
      let publication;
      onPublish();
      try { publication = await this.run(root, { ...this.plan(disk, effective), options: state.options, save: true }); }
      catch (error) {
        if (state.treeNeedsReconcile) state.reconcileFailure = { code: error.code || 'LIBRARY_DEPENDENCY_SAVE_FAILED',
          phase: 'save', message: error.message, outcome: 'unverified', requiresInspection: true };
        throw error;
      }
      assertCurrent();
      const saved = this.read(root);
      if (state.treeNeedsReconcile && fields.some(field => !same(saved[field], publication.manifest?.[field]))) {
        state.reconcileFailure = { code: 'LIBRARY_DEPENDENCY_INPUT_CHANGED', phase: 'save',
          message: 'Saved dependencies changed during publication.', outcome: 'unverified', requiresInspection: true };
        throw conflict();
      }
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

  historyBegin(project, { packages }) {
    return this.queue(project, root => this.locked(root, () => {
      if (this.status(root).dirty) throw new Error('Save pending dependencies before a library checkpoint.');
      return this.history.begin(root, packages);
    }));
  }

  historyCommit(project, { token }) {
    return this.queue(project, root => this.locked(root, () => this.history.commit(root, token)));
  }

  historyDiscard(project, { token }) {
    return this.queue(project, root => this.history.discard(root, token));
  }

  historyRestore(project, { token, forward }) {
    return this.queue(project, root => this.locked(root, async assertCurrent => {
      if (this.status(root).dirty) throw new Error('Save pending dependencies before library undo.');
      const { target, expected } = await this.history.prepare(root, token, forward);
      const packageFile = path.join(root, 'package.json'), lockFile = path.join(root, 'package-lock.json');
      const apply = async snapshot => {
        assertCurrent();
        const manifest = this.history.patch(this.read(root), snapshot);
        fs.writeFileSync(packageFile, JSON.stringify(manifest, null, 2) + '\n');
        if (snapshot.lock === null) fs.rmSync(lockFile, { force: true });
        else fs.writeFileSync(lockFile, snapshot.lock);
        await this.history.restoreSources(root, snapshot, snapshot === target ? expected : target, false);
        assertCurrent();
        await this.run(root, { add: [], remove: [], options: { installLinks: false },
          // A pre-install checkpoint can have no root lockfile. In that case
          // npm's hidden lock must not resurrect the just-undone installation.
          reconcileOnly: snapshot.lock === null });
        assertCurrent();
        const current = await this.history.capture(root, []);
        assertCurrent();
        if (!same(current.dependencies, snapshot.dependencies) || current.lock !== snapshot.lock) throw conflict();
        await this.history.restoreSources(root, snapshot, snapshot === target ? expected : target, true);
        assertCurrent();
        await this.history.restoreLinks(root, snapshot);
        assertCurrent();
        await this.prepareSources(root, assertCurrent);
        // npm's no-save reify must leave the saved lock and dependency inputs exact.
        const actual = await this.history.capture(root, snapshot.sources.map(source => source.name));
        assertCurrent();
        if (!same(this.history.identity(actual), this.history.identity(snapshot))) {
          throw new Error('Library undo could not verify the restored dependency tree.');
        }
      };
      try { await apply(target); }
      catch (error) {
        if (['LIBRARY_DEPENDENCY_INPUT_CHANGED', 'LIBRARY_HISTORY_CONFLICT'].includes(error.code)) throw error;
        try { await apply(expected); }
        catch (rollback) { throw new AggregateError([error, rollback], '库撤销与恢复均未完成，请保留项目并检查依赖。'); }
        throw error;
      }
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
  const { childScriptPath } = require('./child-script-path');
  const preprocessPath = childScriptPath('preprocess.js');
  const childRoot = path.dirname(path.dirname(preprocessPath));
  const node = path.join(childRoot, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  const npmRoot = path.join(childRoot, 'node', process.platform === 'win32' ? 'node_modules/npm' : 'lib/node_modules/npm');
  const source = fs.readFileSync(path.join(__dirname, 'library-dependency-worker.js'), 'utf8');
  if (request.materializeSources) {
    request = { ...request, preprocessPath, extractor: process.env.AILY_7ZA_PATH
      || path.join(path.dirname(path.dirname(preprocessPath)), process.platform === 'win32' ? '7za.exe' : '7zz') };
  }
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
