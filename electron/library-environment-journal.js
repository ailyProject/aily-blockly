'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { rootAttachment, storageExecutor, observeStorageExecutor } = require('./project-file-lock-owner');
const { createProjectFileAccess } = require('./project-file-access');
const { environmentManifest, restoreEnvironmentManifest } = require('./library-manifest-input');

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const same = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));
const fail = message => Object.assign(new Error(message), { code: 'LIBRARY_ENVIRONMENT_UNCERTAIN' });
const raw = file => { try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const inputNames = ['package.json', 'package-lock.json', '.npmrc', 'npm-shrinkwrap.json', 'yarn.lock', 'node_modules/.package-lock.json'];
const inputs = root => Object.fromEntries(inputNames.map(name => {
  const file = path.join(root, name), stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw fail('Dependency input must remain a regular unlinked file.');
  if (name.startsWith('node_modules/') && stat && fs.lstatSync(path.join(root, 'node_modules')).isSymbolicLink()) throw fail('Dependency input parent became linked.');
  return [name, stat ? raw(file) : null];
}));
const relevantPackage = environmentManifest;
function programSource(root) {
  const access = createProjectFileAccess(root, root);
  for (const directory of ['.aily', '.aily/abs-sync']) access.checkDirectory(path.join(root, directory));
  return Object.fromEntries(['project.abi', 'project.abs', 'project.abs.map.json', '.aily/abs-sync/committed.json', '.aily/abs-sync/operation.json']
    .map(name => { const bytes = access.readRegular(path.join(root, name)); return [name, bytes === null ? null : digest(bytes)]; }));
}
function programPointer(root) {
  const access = createProjectFileAccess(root, root);
  const text = access.readRegular(path.join(root, '.aily/abs-sync/operation.json'));
  return text === null ? null : JSON.parse(text.toString('utf8'));
}

function directory(root, relative) {
  let current = root;
  for (const part of relative.split('/').filter(Boolean)) {
    current = path.join(current, part);
    try { fs.mkdirSync(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(fail('Dependency recovery storage must remain a physical project directory.'),
      { code: 'LIBRARY_DEPENDENCY_ARCHIVE_INVALID' });
  }
  return current;
}

function immutable(file, value) {
  const payload = JSON.stringify(value), text = JSON.stringify({ version: 1, hash: digest(payload), payload: value });
  const temporary = `${file}.${randomUUID()}.tmp`;
  if (fs.existsSync(file)) {
    if (raw(file) !== text) throw fail('An immutable environment checkpoint changed.');
    return;
  }
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, text); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  try { fs.renameSync(temporary, file); } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function readRecord(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail('Dependency checkpoint must remain an unlinked file.');
  const record = JSON.parse(raw(file));
  if (record.version !== 1 || record.hash !== digest(JSON.stringify(record.payload))) throw fail('Dependency checkpoint checksum changed.');
  return record.payload;
}

/** Promote nested npm changes to their owned top-level package. A linked leaf
 * is read through its real source, but no restoration ever writes that source. */
function logicalRoot(relative) {
  const parts = relative.replace(/\\/g, '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw fail('Unsafe npm environment path.');
  if (parts[0] === 'node_modules' && parts.length >= 2) {
    if (parts[1] === '.bin' && parts.length === 3 && /^[\w@.-]+$/.test(parts[2])) return parts.join('/');
    if (parts[1].startsWith('.')) throw fail('Npm package changes cannot replace project metadata.');
    const count = parts[1].startsWith('@') ? 3 : 2;
    if (parts.length < count) throw fail('Incomplete scoped package path.');
    return parts.slice(0, count).join('/');
  }
  if (parts[0] === 'sketch' && parts[1] === 'libraries' && parts.length >= 3) return parts.slice(0, 3).join('/');
  if (parts.length === 3 && parts[0] === 'local-libraries' && parts[1] === '@aily-project' && /^lib-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parts[2])) return parts.join('/');
  throw fail('An npm environment change escaped its project-owned package paths.');
}

function parentIsPhysical(root, relative, create = true) {
  let current = root;
  for (const segment of relative.split('/').slice(0, -1)) {
    current = path.join(current, segment);
    if (create) try { fs.mkdirSync(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat && !create) return false;
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw fail('A package parent became a link or another directory.');
  }
}

function tree(source, target, ancestors = new Set(), allowLinks = true) {
  const realpath = fs.realpathSync.native || fs.realpathSync;
  const physical = realpath(source), stat = fs.statSync(physical), entries = [];
  if (ancestors.has(physical)) throw fail('A linked library contains a directory cycle.');
  if (!stat.isDirectory() && !stat.isFile()) throw fail('A managed environment leaf must be a directory or regular file.');
  const visit = (from, relative, parents) => {
    if (!allowLinks && fs.lstatSync(from).isSymbolicLink()) throw fail('A retained library archive became linked.');
    const real = realpath(from), value = fs.statSync(real);
    if (value.isDirectory()) {
      if (parents.has(real)) throw fail('A linked library contains a directory cycle.');
      const next = new Set(parents).add(real);
      entries.push({ relative, directory: true, mode: value.mode & 0o777 });
      if (target) {
        fs.mkdirSync(path.join(target, relative), { recursive: true, mode: value.mode & 0o777 });
        fs.chmodSync(path.join(target, relative), value.mode & 0o777);
      }
      for (const name of fs.readdirSync(real).sort()) {
        if (name === '.git') continue; // npm does not mutate the source repository metadata.
        visit(path.join(real, name), relative ? `${relative}/${name}` : name, next);
      }
    } else if (value.isFile()) {
      const bytes = fs.readFileSync(real);
      entries.push({ relative, bytes: bytes.length, hash: digest(bytes), mode: value.mode & 0o777 });
      if (target) {
        const destination = path.join(target, relative), descriptor = fs.openSync(destination, 'wx', value.mode & 0o777);
        try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
        fs.chmodSync(destination, value.mode & 0o777);
      }
    } else throw fail('A managed library contains a special file.');
  };
  visit(physical, '', ancestors);
  return { hash: digest(JSON.stringify(entries)), entries };
}

/** The existing dependency manager owns this journal and its one npm executor.
 * It stores no Blockly state and grants no ABS apply/publication authority. */
class LibraryEnvironmentJournal {
  constructor() { this.owned = new Map(); this.latest = new Map(); this.attempts = new Map(); }
  base(root) { return directory(root, '.aily/dependency-recovery'); }
  assertAttachment(root, record) {
    if (!same(rootAttachment(root), record.attachment)) throw fail('The environment checkpoint belongs to another physical project.');
  }
  assertOriginal(operation) {
    if (!same(readRecord(path.join(operation.folder, 'checkpoint.json')), operation.record)) throw fail('The original environment checkpoint changed.');
  }
  pending(root) {
    const base = path.join(root, '.aily/dependency-recovery');
    if (!fs.existsSync(base)) return [];
    directory(root, '.aily/dependency-recovery');
    return fs.readdirSync(base).filter(name => /^environment-[0-9a-f]{64}$/.test(name)).map(name => {
      const folder = path.join(base, name), stat = fs.lstatSync(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('Dependency operation directory changed.');
      const checkpoint = path.join(folder, 'checkpoint.json');
      if (!fs.existsSync(checkpoint)) return null;
      const record = readRecord(checkpoint);
      if (name !== `environment-${digest(record.requestId).slice(7)}`) throw fail('Dependency request index changed.');
      if (fs.existsSync(path.join(folder, 'result.json'))) {
        const result = readRecord(path.join(folder, 'result.json'));
        if (result.version !== 1 || result.requestId !== record.requestId || !['completed', 'restored'].includes(result.status)) throw fail('The original environment terminal changed.');
        if (!record.request.programRef) return null;
        if (fs.existsSync(path.join(folder, 'program-resolution.json'))) {
          const resolved = readRecord(path.join(folder, 'program-resolution.json'));
          if (resolved.version !== 1 || resolved.requestId !== record.requestId || !same(resolved.programRef, record.request.programRef)
            || !['retained', 'restored', 'superseded'].includes(resolved.status)) throw fail('The linked environment resolution changed.');
          return null;
        }
      }
      return { folder, record };
    }).filter(Boolean);
  }
  begin(root, request, state, assertCurrent) {
    if (this.owned.has(root)) {
      const owned = this.owned.get(root);
      if (request.requestId && request.requestId !== owned.record.requestId) throw fail('Another original environment request is still pending.');
      return owned;
    }
    assertCurrent();
    const requestId = request.requestId ?? randomUUID();
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) throw fail('Invalid original dependency request.');
    const folder = directory(root, `.aily/dependency-recovery/environment-${digest(requestId).slice(7)}`);
    if (fs.existsSync(path.join(folder, 'checkpoint.json'))) throw fail('An original dependency request must be observed, never executed again.');
    const record = JSON.parse(JSON.stringify({ version: 1, requestId, project: root, attachment: rootAttachment(root), executor: storageExecutor(),
      request, before: inputs(root), state: state ?? null, createdAt: Date.now(),
      ...(request.programRef ? { programSource: programSource(root), programPointer: programPointer(root) } : {}) }));
    if (request.programRef && (!same(request.programRef.attachment, record.attachment)
      || record.programPointer?.id !== request.programRef.operationId || record.programPointer?.state !== 'pending')) {
      throw fail('The environment must attach to its currently admitted native Working checkpoint.');
    }
    immutable(path.join(folder, 'checkpoint.json'), record); assertCurrent();
    const operation = { folder, record }; this.owned.set(root, operation); return operation;
  }
  beginAttempt(root, state, assertCurrent) {
    const original = this.owned.get(root); if (!original) throw fail('An environment attempt needs its original operation.');
    assertCurrent(); this.assertOriginal(original); this.assertAttachment(root, original.record);
    const id = randomUUID(), folder = directory(root, path.relative(root, original.folder).replace(/\\/g, '/') + `/attempts/${id}`);
    const record = JSON.parse(JSON.stringify({ ...original.record, requestId: id, request: { operation: 'dependency-attempt' },
      before: inputs(root), state: state ?? null }));
    immutable(path.join(folder, 'checkpoint.json'), record);
    const attempt = { folder, record }; this.attempts.set(root, [...(this.attempts.get(root) || []), attempt]); return id;
  }
  endAttempt(root, id) { this.attempts.set(root, (this.attempts.get(root) || []).filter(value => value.record.requestId !== id)); }
  attempt(root, id) { return this.attempts.get(root)?.find(value => value.record.requestId === id); }
  preserve(root, locations, assertCurrent, worker, retained) {
    const operation = retained ?? this.owned.get(root);
    if (!operation) throw fail('Npm cannot mutate an environment without its original checkpoint.');
    this.assertAttachment(root, operation.record); this.assertOriginal(operation); assertCurrent();
    if (worker) immutable(path.join(operation.folder, `worker-${worker.storagePid}.json`), worker);
    const roots = [...new Set(locations.map(logicalRoot))].sort();
    const base = directory(root, path.relative(root, operation.folder).replace(/\\/g, '/') + '/trees');
    for (const relative of roots) {
      assertCurrent(); parentIsPhysical(root, relative, false);
      const key = digest(relative).slice(7), metadata = path.join(base, `${key}.json`);
      if (fs.existsSync(metadata)) { readRecord(metadata); continue; }
      const logical = path.join(root, relative), stat = fs.lstatSync(logical, { throwIfNoEntry: false });
      const record = { version: 1, relative, exists: !!stat };
      if (stat) {
        const source = fs.realpathSync(logical), relation = path.relative(source, operation.folder);
        if (!relation || (!path.isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${path.sep}`))) throw fail('A linked package overlaps its recovery archive.');
        const destination = path.join(base, key);
        if (fs.statSync(logical).isDirectory()) fs.mkdirSync(destination);
        Object.assign(record, { source, linked: stat.isSymbolicLink(), ...tree(logical, destination) });
        if (relative.startsWith('node_modules/.bin/') && stat.isSymbolicLink()) record.linkTarget = fs.readlinkSync(logical);
        if (stat.isSymbolicLink() && relative.startsWith('node_modules/') && !relative.startsWith('node_modules/.bin/')) {
          const internal = path.relative(root, source).replace(/\\/g, '/');
          if (/^local-libraries\/@aily-project\/lib-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(internal)) {
            const canonicalFile = path.join(base, `${digest(internal).slice(7)}.json`);
            if (fs.existsSync(canonicalFile)) {
              const canonical = readRecord(canonicalFile);
              if (canonical.relative === internal && canonical.exists && canonical.hash === record.hash
                && same(canonical.entries, record.entries)) record.internalTarget = internal;
            }
          }
        }
        if (!same(tree(logical), { hash: record.hash, entries: record.entries })) throw fail('Library source changed while it was being preserved.');
      }
      immutable(metadata, record); assertCurrent();
    }
    if (!retained) for (const attempt of this.attempts.get(root) || []) this.preserve(root, locations, assertCurrent, worker, attempt);
  }
  complete(root, assertCurrent, status = 'completed') {
    const operation = this.owned.get(root); if (!operation) return undefined;
    assertCurrent(); this.assertAttachment(root, operation.record); this.assertOriginal(operation);
    const treeDirectory = path.join(operation.folder, 'trees');
    const trees = [];
    for (const name of fs.existsSync(treeDirectory) ? fs.readdirSync(treeDirectory).filter(name => name.endsWith('.json')) : []) {
      const before = readRecord(path.join(treeDirectory, name)), logical = path.join(root, before.relative);
      const exists = !!fs.lstatSync(logical, { throwIfNoEntry: false });
      const after = { relative: before.relative, exists };
      if (exists) Object.assign(after, tree(logical));
      trees.push(after); assertCurrent();
    }
    const result = { version: 1, requestId: operation.record.requestId, status, after: inputs(root), trees, candidateApplied: false };
    immutable(path.join(operation.folder, 'result.json'), result); this.owned.delete(root); this.latest.set(root, result);
    return result;
  }
  preserveInputWrites(root, writes, assertCurrent, retained) {
    const operation = retained ?? this.owned.get(root); if (!operation) throw fail('Dependency input write has no original owner.');
    assertCurrent(); this.assertAttachment(root, operation.record); this.assertOriginal(operation);
    const folder = directory(root, path.relative(root, operation.folder).replace(/\\/g, '/') + '/input-writes');
    for (const [name, content] of Object.entries(writes)) {
      if (!inputNames.includes(name) || name === '.npmrc' || typeof content !== 'string') throw fail('Unexpected dependency input writer.');
      const record = { version: 1, name, content }, key = digest(JSON.stringify(record));
      immutable(path.join(folder, `${key.slice(7)}.json`), record); assertCurrent();
    }
    if (!retained) for (const attempt of this.attempts.get(root) || []) this.preserveInputWrites(root, writes, assertCurrent, attempt);
  }
  restore(root, operation, assertCurrent) {
    assertCurrent(); this.assertAttachment(root, operation.record); this.assertOriginal(operation);
    for (const name of fs.readdirSync(operation.folder).filter(name => /^worker-\d+\.json$/.test(name))) {
      if (observeStorageExecutor(readRecord(path.join(operation.folder, name))).state !== 'exited') throw fail('An original dependency worker is still active or unknown.');
    }
    const current = inputs(root), before = operation.record.before;
    // Do not overwrite a competing manifest/lock. Build fingerprints may change
    // independently; restoring dependency metadata preserves their latest values.
    const desired = operation.record.request.effectiveFiles ?? operation.record.request.files;
    const planned = [], inputFolder = path.join(operation.folder, 'input-writes');
    for (const file of fs.existsSync(inputFolder) ? fs.readdirSync(inputFolder) : []) {
      const record = readRecord(path.join(inputFolder, file));
      if (!inputNames.includes(record.name) || typeof record.content !== 'string'
        || file !== `${digest(JSON.stringify(record)).slice(7)}.json`) throw fail('A dependency input write proof changed.');
      planned.push(record);
    }
    const packageIntent = desired?.['package.json']?.content ?? planned.find(value => value.name === 'package.json'
      && same(relevantPackage(value.content), relevantPackage(current['package.json'])))?.content;
    const restoredPackage = restoreEnvironmentManifest(before['package.json'], packageIntent, current['package.json']);
    const completed = fs.existsSync(path.join(operation.folder, 'result.json')) ? readRecord(path.join(operation.folder, 'result.json')) : undefined;
    for (const name of inputNames.filter(name => name !== 'package.json' && name !== 'node_modules/.package-lock.json')) {
      const actual = name === 'package.json' ? relevantPackage(current[name]) : current[name];
      const original = name === 'package.json' ? relevantPackage(before[name]) : before[name];
      const target = desired?.[name]?.content;
      const targetValue = name === 'package.json' && target !== undefined ? relevantPackage(target) : target;
      const ownWrite = planned.some(value => value.name === name && (actual === value.content
        || typeof actual === 'string' && value.content.startsWith(actual)));
      if (!same(actual, original) && (target === undefined || !same(actual, targetValue))
        && actual !== completed?.after?.[name] && !ownWrite) throw fail('Dependency inputs changed after the checkpoint; both versions were retained.');
    }
    const trees = path.join(operation.folder, 'trees');
    const records = fs.existsSync(trees) ? fs.readdirSync(trees).filter(name => name.endsWith('.json')).map(name => ({
      file: name, data: readRecord(path.join(trees, name)),
    })) : [];
    for (const { file, data } of records) {
      if (logicalRoot(data.relative) !== data.relative) throw fail('A retained package path changed.');
      assertCurrent(); parentIsPhysical(root, data.relative, data.exists);
      const target = path.join(root, data.relative), backup = path.join(trees, file.slice(0, -5));
      if (data.exists && !same(tree(backup, undefined, new Set(), false), { hash: data.hash, entries: data.entries })) throw fail('Retained library bytes changed.');
      if (fs.lstatSync(target, { throwIfNoEntry: false })) {
        // Never delete an unknown newer library or write through a junction.
        // Its original logical directory/link stays inside this same record.
        fs.renameSync(target, path.join(operation.folder, `displaced-${randomUUID()}`));
      }
      if (data.exists) {
        if (data.entries[0]?.directory === true) fs.mkdirSync(target);
        tree(backup, target, new Set(), false);
      }
    }
    for (const { data } of records.filter(value => value.data.internalTarget !== undefined)) {
      const canonical = records.find(value => value.data.relative === data.internalTarget)?.data;
      if (!data.linked || !data.relative.startsWith('node_modules/') || data.relative.startsWith('node_modules/.bin/')
        || !/^local-libraries\/@aily-project\/lib-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(data.internalTarget)
        || !canonical?.exists || canonical.entries[0]?.directory !== true || canonical.hash !== data.hash
        || !same(canonical.entries, data.entries)) throw fail('The retained internal library link has no exact canonical archive.');
      assertCurrent();
      const target = path.join(root, data.relative), referent = path.join(root, data.internalTarget);
      const referentStat = fs.lstatSync(referent);
      if (!referentStat.isDirectory() || referentStat.isSymbolicLink()
        || !same(tree(referent, undefined, new Set(), false), { hash: canonical.hash, entries: canonical.entries })
        || !same(tree(target, undefined, new Set(), false), { hash: data.hash, entries: data.entries })) {
        throw fail('The restored internal library referent changed; both versions remain retained.');
      }
      fs.renameSync(target, path.join(operation.folder, `restored-link-copy-${randomUUID()}`));
      fs.symlinkSync(process.platform === 'win32' ? referent : path.relative(path.dirname(target), referent), target,
        process.platform === 'win32' ? 'junction' : 'dir');
      if (!same(tree(target), { hash: data.hash, entries: data.entries })) throw fail('The restored internal library link changed.');
      assertCurrent();
    }
    for (const { data } of records.filter(value => value.data.linkTarget !== undefined)) {
      if (!data.relative.startsWith('node_modules/.bin/') || typeof data.linkTarget !== 'string'
        || data.entries[0]?.directory !== undefined) throw fail('Invalid retained executable link.');
      const target = path.join(root, data.relative), referent = path.resolve(path.dirname(target), data.linkTarget);
      const stat = fs.statSync(referent);
      if (!stat.isFile() || digest(fs.readFileSync(referent)) !== data.entries[0].hash) throw fail('The original executable referent changed; both versions remain retained.');
      fs.unlinkSync(target); // Only the verified regular archive copy just created above.
      fs.symlinkSync(data.linkTarget, target, 'file');
    }
    for (const name of inputNames) {
      const file = path.join(root, name), text = name === 'package.json'
        ? restoredPackage : before[name];
      if (fs.lstatSync(file, { throwIfNoEntry: false })) fs.renameSync(file, path.join(operation.folder, `displaced-lock-${randomUUID()}`));
      if (text !== null) { parentIsPhysical(root, name); fs.writeFileSync(file, text, { flag: 'wx' }); }
    }
    const result = { version: 1, requestId: operation.record.requestId, status: 'restored',
      trees: records.map(({ data }) => ({ relative: data.relative, exists: data.exists, hash: data.hash })), candidateApplied: false };
    const resultName = fs.existsSync(path.join(operation.folder, 'result.json')) ? 'restoration.json' : 'result.json';
    immutable(path.join(operation.folder, resultName), result);
    if (this.owned.get(root) === operation) this.owned.delete(root);
    this.latest.set(root, result);
    return { result, state: operation.record.state };
  }
  settle(root, assertCurrent, { read = false } = {}) {
    if (this.owned.has(root)) return undefined;
    let state;
    for (const operation of this.pending(root)) {
      this.assertAttachment(root, operation.record);
      if (operation.record.request.programRef) {
        const result = path.join(operation.folder, 'result.json');
        if (read && fs.existsSync(result)
          && observeStorageExecutor(operation.record.request.programRef.executor).state === 'active') {
          this.latest.set(root, readRecord(result));
          continue; // The active publisher may read its completed environment.
        }
        throw Object.assign(fail('The original program publication must be observed before choosing its environment.'),
          { code: 'LIBRARY_ENVIRONMENT_PROGRAM_PENDING', environmentRequestId: operation.record.requestId, programRef: operation.record.request.programRef });
      }
      if (observeStorageExecutor(operation.record.executor).state !== 'exited') throw fail('The original environment executor is still active or unknown.');
      state = this.restore(root, operation, assertCurrent).state;
    }
    return state;
  }
  describe(root) {
    const owned = this.owned.get(root);
    return owned ? { status: 'running', requestId: owned.record.requestId, candidateApplied: false }
      : this.latest.get(root);
  }
  pendingReferences(root) {
    return this.pending(root).filter(value => value.record.request.programRef).map(value => ({
      requestId: value.record.requestId, programRef: value.record.request.programRef,
    }));
  }
  settleLinked(root, request, assertCurrent) {
    const operation = this.find(root, request?.requestId);
    if (!operation || !same(operation.record.request.programRef, request.programRef)) throw fail('The linked original environment request changed.');
    this.assertOriginal(operation); this.assertAttachment(root, operation.record); assertCurrent();
    const resolution = path.join(operation.folder, 'program-resolution.json');
    if (fs.existsSync(resolution)) return this.observe(root, request.requestId);
    const ref = operation.record.request.programRef, observation = request.observation;
    if (observation?.state === 'completed' && same(observation.ref, ref) && observation.result?.publication?.status === 'COMMITTED') {
      const binding = observation.result.evidence?.binding, actual = programSource(root);
      if (observation.current === true && (!binding || binding.abiHash !== actual['project.abi']
        || binding.absHash !== actual['project.abs'] || binding.mapHash !== actual['project.abs.map.json'])) throw fail('The committed program/environment attachment is no longer current.');
      if (!fs.existsSync(path.join(operation.folder, 'result.json'))) throw fail('Program commit did not complete the original environment.');
      immutable(resolution, { version: 1, requestId: request.requestId, status: 'retained', programRef: ref, current: observation.current === true });
      const result = this.observe(root, request.requestId); this.latest.set(root, result); return result;
    }
    if (observation?.state === 'completed' && same(observation.ref, ref) && observation.result?.publication?.status === 'NOT_COMMITTED') {
      const actual = programSource(root), pointer = programPointer(root), original = operation.record.programPointer;
      if (pointer?.version === 1 && /^[0-9a-f-]{36}$/.test(pointer.id || '') && /^sha256:[0-9a-f]{64}$/.test(pointer.hash || '')
        && pointer.id !== ref.operationId && this.observe(root, request.requestId).current === true) {
        const successor = request.successor, saved = successor?.saved;
        const stamped = { 'project.abi': saved?.abiHash, 'project.abs': saved?.absHash, 'project.abs.map.json': saved?.mapHash,
          '.aily/abs-sync/committed.json': saved?.committedHash, '.aily/abs-sync/operation.json': saved?.operationPointerHash };
        const native = successor?.kind === 'native-admission' && successor.ref?.request?.version === 2
          && successor.ref.operationId === pointer.id && successor.snapshotHash === pointer.hash
          && same(successor.ref.attachment, ref.attachment);
        const published = successor?.kind === 'complete-published-successor' && /^sha256:[0-9a-f]{64}$/.test(saved?.committedHash || '')
          && saved.committedHash !== operation.record.programSource['.aily/abs-sync/committed.json'];
        if (successor?.version === 1 && same(successor.attachment, ref.attachment) && same(actual, stamped) && (native || published)) {
          immutable(resolution, { version: 1, requestId: request.requestId, status: 'superseded', programRef: ref,
            successor, candidateApplied: false });
          return { ...this.observe(root, request.requestId), current: false, superseded: true };
        }
      }
      if (!original || pointer?.version !== 1 || pointer.id !== ref.operationId || pointer.id !== original.id
        || pointer.hash !== original.hash || !['pending', 'restored'].includes(pointer.state)
        || Object.keys(operation.record.programSource).filter(name => name !== '.aily/abs-sync/operation.json')
          .some(name => operation.record.programSource[name] !== actual[name])) throw fail('A newer source owner superseded the failed original environment operation.');
      const restored = this.restore(root, operation, assertCurrent);
      if (!same(programSource(root), actual)) throw fail('The failed original source changed during environment restoration.');
      immutable(resolution, { version: 1, requestId: request.requestId, status: 'restored', programRef: ref, publication: 'NOT_COMMITTED' });
      return { ...this.observe(root, request.requestId), restoredState: restored.state };
    }
    const fact = request.unpublishedSource, source = operation.record.programSource;
    if (!['pending', 'unknown'].includes(observation?.state) || fact?.version !== 1 || fact.kind !== 'source-not-published'
      || fact.requestId !== ref.request.requestId || fact.operationId !== ref.operationId || !same(fact.attachment, ref.attachment)
      || !same(fact.originalExecutor, ref.executor) || fact.oldWriter?.state !== 'exited'
      || !/^sha256:[0-9a-f]{64}$/.test(fact.snapshotHash || '') || !source
      || observeStorageExecutor(ref.executor).state !== 'exited' || observeStorageExecutor(operation.record.executor).state !== 'exited') {
      throw fail('The original source publication is still uncertain; its environment was retained.');
    }
    const expected = { 'project.abi': fact.saved?.abiHash, 'project.abs': fact.saved?.absHash,
      'project.abs.map.json': fact.saved?.mapHash, '.aily/abs-sync/committed.json': fact.saved?.committedHash,
      '.aily/abs-sync/operation.json': fact.saved?.operationPointerHash };
    const actual = programSource(root);
    if (!same(actual, expected) || Object.keys(source).filter(name => name !== '.aily/abs-sync/operation.json').some(name => source[name] !== actual[name])) {
      throw fail('The unpublished source or recovery pointer changed after native observation.');
    }
    const restored = this.restore(root, operation, assertCurrent);
    assertCurrent();
    if (!same(programSource(root), expected)) throw fail('The source changed while its environment was restored.');
    immutable(resolution, { version: 1, requestId: request.requestId, status: 'restored', programRef: ref,
      snapshotHash: fact.snapshotHash, saved: fact.saved });
    return { ...this.observe(root, request.requestId), restoredState: restored.state };
  }
  find(root, requestId) {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) throw fail('Invalid original dependency request.');
    const folder = path.join(root, '.aily/dependency-recovery', `environment-${digest(requestId).slice(7)}`);
    const checkpoint = path.join(folder, 'checkpoint.json');
    if (!fs.existsSync(checkpoint)) return null;
    directory(root, path.relative(root, folder).replace(/\\/g, '/'));
    const record = readRecord(checkpoint); this.assertAttachment(root, record);
    if (record.requestId !== requestId) throw fail('Dependency request binding changed.');
    return { folder, record };
  }
  observe(root, requestId) {
    const original = this.find(root, requestId);
    if (!original) return { status: 'unknown', requestId, current: false, candidateApplied: false };
    const { folder, record } = original;
    const identity = { version: 1, project: root, attachment: record.attachment, executor: record.executor, observer: storageExecutor() };
    if (!fs.existsSync(path.join(folder, 'result.json'))) return { ...identity, status: 'unknown', requestId, current: false, candidateApplied: false };
    const result = readRecord(path.join(folder, fs.existsSync(path.join(folder, 'restoration.json')) ? 'restoration.json' : 'result.json'));
    const actual = inputs(root), expected = result.after ?? record.before;
    let current = ['package.json', 'package-lock.json', '.npmrc', 'npm-shrinkwrap.json', 'yarn.lock'].every(name => name === 'package.json'
      ? same(relevantPackage(actual[name]), relevantPackage(expected[name])) : actual[name] === expected[name]);
    for (const value of result.trees ?? []) {
      if (logicalRoot(value.relative) !== value.relative) throw fail('Environment result path changed.');
      const logical = path.join(root, value.relative), exists = !!fs.lstatSync(logical, { throwIfNoEntry: false });
      if (exists !== value.exists || exists && tree(logical).hash !== value.hash) current = false;
    }
    return { ...identity, status: result.status, requestId, current, candidateApplied: false,
      ...(record.request.operation === 'library-change' && ['install', 'remove'].includes(record.request.action)
        ? { mutation: { action: record.request.action, packages: (record.request.packages ?? []).map(spec => {
          const separator = spec.indexOf('@', 1); return separator < 0 ? spec : spec.slice(0, separator);
        }) } } : {}),
      ...(record.request.localSource ? { ownedPaths: (result.trees ?? []).filter(value => value.relative === `local-libraries/${record.request.localSource.packageName}`)
        .map(value => ({ path: value.relative, exists: value.exists, ...(value.exists ? { hash: value.hash } : {}) })) } : {}),
      hashes: { package: actual['package.json'] === null ? null : digest(actual['package.json']),
        lock: actual['package-lock.json'] === null ? null : digest(actual['package-lock.json']),
        npmrc: actual['.npmrc'] === null ? null : digest(actual['.npmrc']),
        shrinkwrap: actual['npm-shrinkwrap.json'] === null ? null : digest(actual['npm-shrinkwrap.json']),
        yarn: actual['yarn.lock'] === null ? null : digest(actual['yarn.lock']) } };
  }
}

module.exports = { LibraryEnvironmentJournal, logicalRoot, tree };
