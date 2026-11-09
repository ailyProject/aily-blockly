const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createProjectFileAccess, acquireProjectFileLock, assertNoPendingAbsGeneration } = require('./project-file-access');
const { readProjectMode } = require('./project-companion');
const { mergeDependencies, LibraryDependencyConflicts, archiveDependencyResolution, digest, fault } = require('./library-dependency-conflicts');
const { manifestInput, retainDerivedManifest } = require('./library-manifest-input');

const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const deps = manifest => Object.assign({}, ...fields.map(field => manifest[field]));
// Build fingerprints can be refreshed independently while npm is running.
// Keep all other project inputs guarded, and preserve the latest fingerprints.
const sameLibraryInput = (before, after) => {
  try { return require('node:util').isDeepStrictEqual(manifestInput(before), manifestInput(after)); } catch { return false; }
};
const conflict = () => fault('LIBRARY_DEPENDENCY_INPUT_CHANGED', 'Project dependencies changed outside this operation. Inspect dependency recovery; every version was retained.');
const workers = new Set();
let shuttingDown = false;

/** Process-owned memory survives a renderer refresh so reopen can restore the
 * saved dependency tree. package.json is authoritative outside this edit session. */
class LibraryDependencies {
  constructor({ run = runDependencyWorker, trashLocalDirectory } = {}) {
    this.environment = new (require('./library-environment-journal').LibraryEnvironmentJournal)();
    this.environmentGuards = new Map();
    this.run = (root, request) => run(root, { ...request, environmentRequestId: this.environment.owned.get(root)?.record.requestId }, this.environment.owned.has(root) || request.materializeSources ? {
      beforeReify: (locations, worker, writes) => {
        const guard = this.environmentGuards.get(root);
        if (!guard) throw fault('LIBRARY_ENVIRONMENT_UNCERTAIN', 'The original dependency writer is unavailable.');
        if (!this.environment.owned.has(root)) this.environment.begin(root, { operation: 'library-prepare' }, this.states.get(root), guard);
        this.environment.preserve(root, locations, guard, worker);
        if (writes) this.environment.preserveInputWrites(root, writes, guard);
      },
    } : undefined);
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
    const environment = this.environment.describe(root);
    return { dirty: this.states.has(root) || this.locals.dirty(root), busy: this.queues.has(root),
      ...(environment ? { environment: { status: environment.status, requestId: environment.requestId }, candidateApplied: false } : {}),
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

  async locked(root, operation, settle = true) {
    const access = createProjectFileAccess(root, root);
    const lock = await acquireProjectFileLock(access, () => {});
    try {
      access.readRegular(path.join(root, 'package.json'));
      access.readRegular(path.join(root, 'package-lock.json'));
      if (settle !== false) assertNoPendingAbsGeneration(access);
      const restored = settle ? this.environment.settle(root, lock.assertOwned, { read: settle === 'read' }) : undefined;
      if (restored !== undefined) {
        if (restored === null) this.states.delete(root); else this.states.set(root, restored);
      }
      this.environmentGuards.set(root, lock.assertOwned);
      return await operation(lock.assertOwned);
    }
    finally { this.environmentGuards.delete(root); lock.release(); }
  }

  settleEnvironment(project) {
    return this.queue(project, root => this.locked(root, () => this.status(root), 'read'));
  }

  beginEnvironmentAttempt(project, request) {
    return this.queue(project, root => this.locked(root, assertCurrent => {
      this.environment.begin(root, request ? { ...request, operation: 'library-change' } : { operation: 'library-edit-session' }, this.states.get(root), assertCurrent);
      return this.environment.beginAttempt(root, this.states.get(root), assertCurrent);
    }));
  }
  endEnvironmentAttempt(project, id) { this.environment.endAttempt(this.root(project), id); }

  async cancelEnvironmentWorkers(project, requestId) {
    const root = this.root(project), { killRegisteredProcessTree } = require('./process-tree');
    const targets = [...workers].filter(child => child.environmentRoot === root && child.environmentRequestId === requestId);
    await Promise.all(targets.map(child => killRegisteredProcessTree(child.pid, 'library-dependencies-original-request')));
  }

  settleCancelledEnvironment(project, requestId) {
    return this.queue(project, root => this.locked(root, assertCurrent => {
      const original = this.environment.find(root, requestId), owned = this.environment.owned.get(root);
      if (original && owned?.record.requestId === requestId && !owned.record.request.programRef
        && !fs.existsSync(path.join(original.folder, 'result.json'))) {
        const restored = this.environment.restore(root, owned, assertCurrent);
        if (restored.state === null) this.states.delete(root); else this.states.set(root, restored.state);
      }
      return { environment: this.environment.observe(root, requestId), candidateApplied: false };
    }, false));
  }

  finishAbortedEnvironmentAttempt(project, id) {
    return this.queue(project, root => this.locked(root, assertCurrent => {
      this.environment.endAttempt(root, id);
      if (!this.states.has(root) && !this.locals.dirty(root)) this.environment.complete(root, assertCurrent, 'restored');
    }));
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
        if (request.localSource && effective.ailyLocalLibrarySources) {
          delete effective.ailyLocalLibrarySources[request.localSource.packageName];
          if (!Object.keys(effective.ailyLocalLibrarySources).length) delete effective.ailyLocalLibrarySources;
        }
      } else throw new Error('Invalid library operation');
      this.environment.begin(root, { operation: 'library-change', requestId: request.requestId, action: request.action, packages: names,
        options: request.options, ...(request.localSource ? { localSource: request.localSource } : {}) }, this.states.get(root), assertCurrent);
      const attemptId = this.environment.beginAttempt(root, this.states.get(root), assertCurrent);
      const original = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
      let result;
      try {
        if (request.localSource) this.prepareLocalSource(root, request, assertCurrent);
        result = await this.run(root, { ...plan, options: request.options });
        assertCurrent();
        if (!sameLibraryInput(original, fs.readFileSync(path.join(root, 'package.json'), 'utf8'))) throw conflict();
      } catch (error) {
        // Reinstalling a local spec can read newer external bytes. Restore the
        // exact retained project-local trees, after the actual worker exited.
        const operation = this.environment.attempt(root, attemptId);
        if (operation) try {
          const restored = this.environment.restore(root, operation, assertCurrent);
          if (restored.state === null) this.states.delete(root); else this.states.set(root, restored.state);
        } catch (rollback) { throw new AggregateError([error, rollback], `库操作失败，依赖恢复也失败：${error.message}; ${rollback.message}`); }
        throw error;
      } finally { this.environment.endAttempt(root, attemptId); }
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

  prepareLocalSource(root, request, assertCurrent) {
    const input = request.localSource;
    if (!input || Object.keys(input).some(key => !['packageName', 'source', 'force'].includes(key))
      || !/^@aily-project\/lib-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.packageName || '')
      || typeof input.source !== 'string' || !path.isAbsolute(input.source) || input.force !== undefined && typeof input.force !== 'boolean') {
      throw fault('LIBRARY_LOCAL_SOURCE_INVALID', 'Invalid owned local-library source.');
    }
    const source = fs.realpathSync(input.source), relative = `local-libraries/${input.packageName}`, target = path.join(root, relative);
    const installSpec = `${input.packageName}@file:./${relative}`;
    if (!same(request.packages, [installSpec])) throw fault('LIBRARY_LOCAL_SOURCE_INVALID', 'The local installation spec does not match its canonical target.');
    if (JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).name !== input.packageName) throw fault('LIBRARY_LOCAL_SOURCE_INVALID', 'Local package identity changed.');
    const retained = new Set([relative, `node_modules/${input.packageName}`]);
    if (fs.existsSync(target)) {
      const physicalTarget = fs.realpathSync(target), modules = path.join(root, 'node_modules');
      const retainLink = logical => {
        if (!fs.lstatSync(logical).isSymbolicLink()) return;
        let referent;
        try { referent = fs.realpathSync(logical); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        const relation = path.relative(physicalTarget, referent);
        if (!relation || !path.isAbsolute(relation) && relation !== '..' && !relation.startsWith('..' + path.sep)) {
          retained.add(path.relative(root, logical).replace(/\\/g, '/'));
        }
      };
      if (fs.existsSync(modules)) for (const name of fs.readdirSync(modules)) {
        const logical = path.join(modules, name), stat = fs.lstatSync(logical);
        if ((name.startsWith('@') || name === '.bin') && stat.isDirectory() && !stat.isSymbolicLink()) {
          for (const child of fs.readdirSync(logical)) retainLink(path.join(logical, child));
        } else if (!name.startsWith('.')) retainLink(logical);
      }
    }
    // Replacing the canonical source changes every junction which refers to it
    // before Arborist can inspect the old installed tree. Preserve those exact
    // leaves now; later diff preservation must not replace their original bytes.
    this.environment.preserve(root, [...retained], assertCurrent);
    if (fs.existsSync(target) && fs.realpathSync(target) === source) return;
    if (fs.existsSync(target) && !input.force) throw fault('LIBRARY_LOCAL_SOURCE_EXISTS', 'The canonical local library already exists; explicit force is required.');
    const operation = this.environment.owned.get(root), candidate = path.join(operation.folder, `local-candidate-${require('node:crypto').randomUUID()}`);
    const { tree } = require('./library-environment-journal'), before = tree(source);
    fs.cpSync(source, candidate, { recursive: true, dereference: true,
      filter: file => !path.relative(source, file).split(path.sep).includes('.git') });
    if (!same(tree(candidate), before) || !same(tree(source), before)) throw fault('LIBRARY_LOCAL_SOURCE_CHANGED', 'Local source changed during its original import.');
    assertCurrent();
    const access = createProjectFileAccess(root, root), parents = [path.join(root, 'local-libraries'), path.dirname(target)];
    // Parent materialization belongs to this admitted import, never to the
    // readonly archive step. The complete source is staged before any mkdir.
    for (const [index, directory] of parents.entries()) {
      assertCurrent(); access.checkRoot();
      for (const parent of parents.slice(0, index)) access.checkDirectory(parent);
      try { fs.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      access.checkDirectory(directory);
    }
    assertCurrent(); access.checkRoot();
    for (const directory of parents) access.checkDirectory(directory);
    if (fs.lstatSync(target, { throwIfNoEntry: false })) fs.renameSync(target, path.join(operation.folder, `local-displaced-${require('node:crypto').randomUUID()}`));
    fs.renameSync(candidate, target);
  }

  removeLocal(project, { folderName }) {
    return this.queue(project, root => this.locked(root, async assertCurrent => {
      await this.locals.target(root, folderName); // Validate the exact owned logical leaf before checkpointing.
      this.environment.begin(root, { operation: 'local-library-remove', folderName }, this.states.get(root), assertCurrent);
      this.environment.preserve(root, [`sketch/libraries/${folderName}`], assertCurrent);
      await this.locals.remove(root, folderName);
      return this.status(root);
    }));
  }

  restore(project, snapshot) {
    return this.queue(project, root => this.locked(root, async assertCurrent => {
      const disk = this.read(root);
      const attempt = snapshot.environmentAttempt && this.environment.attempt(root, snapshot.environmentAttempt);
      if (attempt) {
        const restored = this.environment.restore(root, attempt, assertCurrent);
        if (restored.state === null) this.states.delete(root); else this.states.set(root, restored.state);
        await this.locals.restore(root, snapshot.locals);
        return this.status(root);
      }
      if (!same(this.states.get(root), snapshot.state)) {
        await this.run(root, { ...this.plan(disk, snapshot.manifest), options: snapshot.state?.options });
      }
      if (snapshot.state) this.states.set(root, clone(snapshot.state));
      else this.states.delete(root);
      await this.locals.restore(root, snapshot.locals);
      const operation = this.environment.owned.get(root);
      if (operation) this.environment.restore(root, operation, assertCurrent);
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
    return this.queue(project, root => this.locked(root, async assertCurrent => {
      const existing = this.environment.owned.has(root);
      try { await this.prepareSources(root, assertCurrent); }
      catch (error) {
        const operation = !existing && this.environment.owned.get(root);
        if (operation) this.environment.restore(root, operation, assertCurrent);
        throw error;
      }
      if (!existing) this.environment.complete(root, assertCurrent);
      return this.status(root);
    }, 'read'));
  }

  reconcile(project, request = {}) {
    const root = this.root(project), raw = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    return this.configure(root, { operation: 'environment-reconcile', options: request.options,
      files: { 'package.json': { expectedHash: digest(raw), content: raw } } });
  }

  save(project, options = {}) {
    const root = this.root(project);
    if (!this.states.has(root) && !this.locals.dirty(root) && !this.environment.owned.has(root)) {
      // The program publisher's post-effects may confirm an already completed
      // environment. This is a read, not another npm/manifest transaction.
      return this.queue(root, current => this.locked(current, () => this.status(current), 'read'));
    }
    return this.queue(project, root => this.locked(root, assertCurrent => this.saveInLock(root, options, assertCurrent)));
  }

  async saveInLock(root, { prepareSources = false, onPublish = () => {} } = {}, assertCurrent) {
      const state = this.states.get(root);
      if (!state) {
        if (prepareSources) await this.prepareSources(root, assertCurrent);
        this.locals.save(root); this.environment.complete(root, assertCurrent); return this.status(root);
      }
      this.environment.begin(root, { operation: 'library-save' }, this.states.get(root), assertCurrent);
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
      this.environment.preserveInputWrites(root, { 'package.json': JSON.stringify(saved, null, 2) + '\n' }, assertCurrent);
      const temp = path.join(root, `.package.json.${require('node:crypto').randomUUID()}.tmp`);
      try { fs.writeFileSync(temp, JSON.stringify(saved, null, 2) + '\n', { flag: 'wx' }); assertCurrent(); fs.renameSync(temp, path.join(root, 'package.json')); }
      finally { fs.rmSync(temp, { force: true }); }
      this.states.delete(root);
      this.locals.save(root);
      this.environment.complete(root, assertCurrent);
      return this.status(root);
  }

  configure(project, request) {
    return this.queue(project, root => this.locked(root, async assertCurrent => {
      if (request?.requestId) {
        const original = this.environment.find(root, request.requestId);
        if (original) {
          if (!same(original.record.request.files, request.files)
            || original.record.request.operation !== (request.operation || 'environment-configure')) throw fault('LIBRARY_ENVIRONMENT_INVALID', 'The original environment request arguments changed.');
          return { ...this.status(root), environment: this.environment.observe(root, request.requestId), candidateApplied: false };
        }
      }
      const originalFiles = request?.files;
      const files = originalFiles && JSON.parse(JSON.stringify(originalFiles));
      if (!files || !files['package.json'] || Object.keys(files).some(name => !['package.json', 'package-lock.json', '.npmrc', 'npm-shrinkwrap.json', 'yarn.lock'].includes(name))) {
        throw fault('LIBRARY_ENVIRONMENT_INVALID', 'Environment publication requires exact whitelisted target files.');
      }
      for (const [name, value] of Object.entries(files)) {
        if (!value || Object.keys(value).some(key => !['expectedHash', 'content'].includes(key))
          || value.content !== null && typeof value.content !== 'string'
          || value.expectedHash !== null && !/^sha256:[0-9a-f]{64}$/.test(value.expectedHash)) throw fault('LIBRARY_ENVIRONMENT_INVALID', 'Invalid environment file binding.');
        const file = path.join(root, name), actual = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        if ((actual === null ? null : digest(actual)) !== value.expectedHash) throw conflict();
      }
      const manifest = JSON.parse(files['package.json'].content);
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw fault('LIBRARY_ENVIRONMENT_INVALID', 'Invalid target manifest.');
      files['package.json'].content = retainDerivedManifest(files['package.json'].content, fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      this.environment.begin(root, { operation: request.operation || 'environment-configure', requestId: request.requestId,
        files: originalFiles, effectiveFiles: files, ...(request.programRef ? { programRef: request.programRef } : {}) }, this.states.get(root), assertCurrent);
      // The desired bytes are durable before the first manifest/lock write.
      for (const [name, value] of Object.entries(files)) {
        const file = path.join(root, name), temporary = `${file}.${require('node:crypto').randomUUID()}.tmp`;
        if (value.content === null) {
          if (fs.existsSync(file)) fs.renameSync(file, path.join(this.environment.owned.get(root).folder, `replaced-${name.replace(/\W/g, '-')}`));
        } else {
          const descriptor = fs.openSync(temporary, 'wx', 0o600);
          try { fs.writeFileSync(descriptor, value.content); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
          assertCurrent(); fs.renameSync(temporary, file);
        }
      }
      await this.run(root, { add: [], remove: [], options: { ...request.options, installLinks: false }, reconcileOnly: true });
      assertCurrent();
      if (!['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock'].some(name => Object.hasOwn(files, name))) {
        // A normal board/config change asks npm to produce its own matching
        // lock. History supplied an exact lock and must retain those bytes.
        await this.run(root, { add: [], remove: [], options: { ...request.options, installLinks: false }, save: true });
        assertCurrent();
        if (!sameLibraryInput(files['package.json'].content, fs.readFileSync(path.join(root, 'package.json'), 'utf8'))) throw conflict();
        const temporary = path.join(root, `.package.json.${require('node:crypto').randomUUID()}.tmp`);
        try {
          fs.writeFileSync(temporary, files['package.json'].content, { flag: 'wx' });
          assertCurrent(); fs.renameSync(temporary, path.join(root, 'package.json'));
        } finally { fs.rmSync(temporary, { force: true }); }
      }
      await this.prepareSources(root, assertCurrent);
      for (const [name, value] of Object.entries(files)) {
        const actual = fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name), 'utf8') : null;
        if (actual !== value.content) throw conflict();
      }
      this.states.delete(root);
      const completed = this.environment.complete(root, assertCurrent);
      return { ...this.status(root), environment: this.environment.observe(root, completed.requestId), candidateApplied: false };
    }));
  }

  observeEnvironment(project, { requestId }) {
    const root = this.root(project);
    return this.queue(root, () => this.locked(root, () => ({ environment: this.environment.observe(root, requestId), candidateApplied: false }), false));
  }

  pendingEnvironment(project) {
    const root = this.root(project);
    return this.queue(root, () => this.locked(root, () => this.environment.pendingReferences(root), false));
  }

  settleLinkedEnvironment(project, request) {
    const root = this.root(project);
    return this.queue(root, () => this.locked(root, assertCurrent => {
      assertNoPendingAbsGeneration(createProjectFileAccess(root, root));
      const environment = this.environment.settleLinked(root, request, assertCurrent);
      if (Object.hasOwn(environment, 'restoredState')) {
        if (environment.restoredState === null) this.states.delete(root); else this.states.set(root, environment.restoredState);
        delete environment.restoredState;
      }
      return { ...this.status(root), environment, candidateApplied: false };
    }, false));
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
      const packageFile = path.join(root, 'package.json');
      this.environment.begin(root, { operation: 'library-history', token, forward }, this.states.get(root), assertCurrent);
      const apply = async snapshot => {
        assertCurrent();
        const manifest = this.history.patch(this.read(root), snapshot);
        const resolution = { 'package-lock.json': snapshot.lock, 'npm-shrinkwrap.json': snapshot.shrinkwrap, 'yarn.lock': snapshot.yarn };
        this.environment.preserveInputWrites(root, { 'package.json': JSON.stringify(manifest, null, 2) + '\n',
          ...Object.fromEntries(Object.entries(resolution).filter(([, content]) => content !== null)) }, assertCurrent);
        fs.writeFileSync(packageFile, JSON.stringify(manifest, null, 2) + '\n');
        for (const [name, content] of Object.entries(resolution)) {
          const file = path.join(root, name);
          if (content === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, content);
        }
        await this.run(root, { add: [], remove: [], options: { installLinks: false },
          // A pre-install checkpoint can have no root lockfile. In that case
          // npm's hidden lock must not resurrect the just-undone installation.
          reconcileOnly: snapshot.lock === null && snapshot.shrinkwrap === null });
        assertCurrent();
        const current = await this.history.capture(root, []);
        assertCurrent();
        if (!same(current.dependencies, snapshot.dependencies)
          || ['lock', 'shrinkwrap', 'yarn'].some(key => current[key] !== snapshot[key])) throw conflict();
        await this.history.restoreLinks(root, snapshot, logical => fs.renameSync(logical,
          path.join(this.environment.owned.get(root).folder, `history-displaced-${require('node:crypto').randomUUID()}`)));
        assertCurrent();
        await this.prepareSources(root, assertCurrent);
        // npm's no-save reify must leave the saved lock and dependency inputs exact.
        const actual = await this.history.capture(root, this.history.get(root, token).names);
        assertCurrent();
        if (!same(this.history.identity(actual), this.history.identity(snapshot))) {
          throw new Error('Library undo could not verify the restored dependency tree.');
        }
      };
      try { await apply(target); }
      catch (error) {
        if (['LIBRARY_DEPENDENCY_INPUT_CHANGED', 'LIBRARY_HISTORY_CONFLICT'].includes(error.code)) throw error;
        try { this.environment.restore(root, this.environment.owned.get(root), assertCurrent); }
        catch (rollback) { throw new AggregateError([error, rollback], '库撤销与恢复均未完成，请保留项目并检查依赖。'); }
        throw error;
      }
      this.environment.complete(root, assertCurrent);
      return this.status(root);
    }));
  }

  historyPreview(project, { token, forward }) {
    return this.queue(project, root => this.locked(root, () => this.history.preview(root, token, forward)));
  }

  discard(project, { reconcile = false, historyRestored = false } = {}) {
    return this.queue(project, root => this.locked(root, async assertCurrent => {
      const state = this.states.get(root);
      const priorEnvironment = this.environment.owned.get(root);
      const pendingLocalChanges = this.locals.dirty(root);
      if (historyRestored) this.locals.save(root);
      if (!state && !reconcile) {
        await this.locals.restore(root);
        const operation = this.environment.owned.get(root);
        if (operation) this.environment.restore(root, operation, assertCurrent);
        return this.status(root);
      }
      // Read the CURRENT saved manifest: Chat restore/external edits are never
      // overwritten with an old in-memory baseline.
      this.environment.begin(root, { operation: 'library-reconcile' }, this.states.get(root), assertCurrent);
      await this.run(root, {
        add: [], remove: [], options: state?.options,
        // Only Coder's clean reopen uses the fast tree check. Blockly retains
        // its existing npm reconciliation, including Chat history reloads.
        reconcileOnly: reconcile && !state && !historyRestored && isCoderProject(root),
      });
      this.states.delete(root);
      await this.locals.restore(root);
      const operation = this.environment.owned.get(root);
      if (operation) {
        if (reconcile && !state && !pendingLocalChanges && !priorEnvironment
          || !sameLibraryInput(operation.record.before['package.json'], fs.readFileSync(path.join(root, 'package.json'), 'utf8'))) this.environment.complete(root, assertCurrent);
        else this.environment.restore(root, operation, assertCurrent);
      }
      return this.status(root);
    }));
  }
}

function isCoderProject(root) {
  try { return readProjectMode(root) === 'coder'; }
  catch { return false; }
}

function runDependencyWorker(root, request, hooks) {
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
    child.environmentRoot = root;
    child.environmentRequestId = request.environmentRequestId;
    let response, detail = '';
    child.on('message', value => {
      if (value?.type === 'environment-before-reify') {
        Promise.resolve().then(() => {
          if (typeof hooks?.beforeReify !== 'function') throw new Error('Environment checkpoint owner is unavailable');
          const { storageExecutor } = require('./project-file-lock-owner');
          const { processIdentity } = require(childScriptPath('build-process-identity.js'));
          const owner = storageExecutor();
          return hooks.beforeReify(value.locations, { version: 1, hostPid: owner.hostPid, storagePid: child.pid,
            instanceId: `library-worker-${child.pid}`, processIdentity: processIdentity(child.pid), bootId: owner.bootId }, value.writes);
        }).then(() => { if (child.connected) child.send({ type: 'environment-checkpoint-ack', token: value.token, ok: true }); },
          error => { if (child.connected) child.send({ type: 'environment-checkpoint-ack', token: value.token, ok: false, error: error.message }); });
      } else response = value;
    });
    child.stdout.on('data', value => { detail = (detail + value).slice(-8000); });
    child.stderr.on('data', value => { detail = (detail + value).slice(-8000); });
    child.on('error', error => { workers.delete(child); reject(error); });
    child.on('close', code => {
      workers.delete(child);
      response?.ok && code === 0 ? resolve(response) : reject(new Error(response?.error || detail || `npm dependency worker exited: ${code}`));
    });
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify({ ...request, ...(hooks ? { environmentCheckpoint: true } : {}), npmRoot }));
  });
}

async function stopLibraryDependencyWorkers() {
  shuttingDown = true;
  const { killRegisteredProcessTree } = require('./process-tree');
  return Promise.all([...workers].map(child => killRegisteredProcessTree(child.pid, 'library-dependencies')));
}

module.exports = { LibraryDependencies, runDependencyWorker, stopLibraryDependencyWorkers };
