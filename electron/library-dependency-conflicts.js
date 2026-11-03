'use strict';
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'ailyLocalLibrarySources'];
const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const fault = (code, message, dependencyConflict) => Object.assign(new Error(message), { code,
  ...(dependencyConflict ? { dependencyConflict } : {}) });

/** Merge independent edits; an unresolved item never becomes an effective manifest. */
function mergeDependencies(disk, state) {
  const manifest = clone(disk), conflicts = [];
  if (!state) return { manifest, conflicts };
  for (const field of dependencyFields) {
    const before = state.base[field] || {}, after = state.manifest[field] || {};
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (same(before[name], after[name])) continue;
      const current = disk[field]?.[name];
      if (!same(current, before[name]) && !same(current, after[name])) {
        conflicts.push({ field, name, base: before[name] ?? null, staged: after[name] ?? null, disk: current ?? null });
        continue;
      }
      manifest[field] ||= {};
      if (after[name] === undefined) delete manifest[field][name];
      else manifest[field][name] = clone(after[name]);
    }
  }
  return { manifest: { ...manifest, ...state.metadata }, conflicts };
}

/** Only decisions are cached here, not another npm execution or lock system. */
class LibraryDependencyConflicts {
  constructor() { this.records = new Map(); }
  inspect(project, input, state, conflicts, evidence) {
    if (!conflicts.length) return undefined;
    let entry = this.records.get(project);
    if (!entry || entry.input !== input || entry.state !== state || entry.status !== 'available') {
      const previous = entry?.status === 'completed' ? entry : entry?.previous;
      if (previous) previous.previous = undefined;
      const requestId = randomUUID();
      entry = { project, input, state, requestId, token: digest(requestId + '\0' + input),
        status: 'available', conflicts: clone(conflicts), evidence: clone(evidence), previous };
      if (!this.records.has(project) && this.records.size >= 64) this.records.delete(this.records.keys().next().value);
      this.records.set(project, entry);
    }
    return this.describe(entry);
  }
  describe(entry) {
    return { version: 1, project: entry.project, token: entry.token, requestId: entry.requestId,
      status: entry.status, entries: clone(entry.conflicts), sourceFilesChanged: false,
      ...(entry.result ? clone(entry.result) : {}) };
  }
  find(project, token, requestId) {
    const current = this.records.get(project);
    const entry = [current, current?.previous].find(value => value?.token === token && value.requestId === requestId);
    if (!entry) throw fault('LIBRARY_DEPENDENCY_RECOVERY_STALE', 'Inspect current dependency conflicts; the old decision cannot change newer inputs.');
    return entry;
  }
  decide(project, request, input, state) {
    if (request?.version !== 1 || !Array.isArray(request.choices)) throw fault('LIBRARY_DEPENDENCY_RECOVERY_INVALID', 'Supply one disk/staged choice for every inspected conflict.');
    const entry = this.find(project, request.token, request.requestId);
    const choices = request.choices;
    if (choices.length !== entry.conflicts.length || choices.some((choice, i) => !choice
      || Object.keys(choice).some(name => !['field', 'name', 'choice'].includes(name))
      || !entry.conflicts.some(item => item.field === choice.field && item.name === choice.name)
      || !['disk', 'staged'].includes(choice.choice)
      || choices.findIndex(item => item.field === choice.field && item.name === choice.name) !== i))
      throw fault('LIBRARY_DEPENDENCY_RECOVERY_INVALID', 'Choices must identify each exact offered conflict once.');
    const signature = JSON.stringify([...choices].sort((a, b) => `${a.field}/${a.name}`.localeCompare(`${b.field}/${b.name}`)));
    if (entry.status === 'completed') {
      if (entry.signature !== signature) throw fault('LIBRARY_DEPENDENCY_RECOVERY_INVALID', 'This request already completed with different choices. Observe its original result.');
      return { entry, completed: true };
    }
    if (entry.input !== input || entry.state !== state) throw fault('LIBRARY_DEPENDENCY_RECOVERY_STALE', 'Dependency inputs changed; inspect again without discarding any version.');
    return { entry, signature, completed: false };
  }
  complete(entry, signature, choices) {
    entry.signature = signature; entry.status = 'completed';
    entry.result = { choices: clone(choices), requiresSave: true, requiresRuntimeSync: true, dependencyTreeReady: false };
    return this.describe(entry);
  }
}

function archiveDependencyResolution(root, resolution) {
  let directory = root;
  for (const name of ['.aily', 'dependency-recovery']) {
    directory = path.join(directory, name);
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fault('LIBRARY_DEPENDENCY_ARCHIVE_INVALID', 'Dependency recovery archive must remain inside the project.');
  }
  const filename = path.join(directory, `${resolution.requestId}.json`);
  const text = JSON.stringify({ version: 1, project: root, recoveryId: resolution.requestId,
    ...resolution.evidence, choices: resolution.choices });
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw fault('LIBRARY_DEPENDENCY_ARCHIVE_INVALID', 'Dependency recovery metadata exceeds its bounded archive.');
  if (fs.existsSync(filename)) {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== Buffer.byteLength(text)
      || fs.readFileSync(filename, 'utf8') !== text) throw fault('LIBRARY_DEPENDENCY_ARCHIVE_INVALID', 'Existing dependency recovery evidence changed; no dependency files were overwritten.');
  } else fs.writeFileSync(filename, text, { flag: 'wx', mode: 0o600 });
  return filename;
}

module.exports = { dependencyFields, mergeDependencies, LibraryDependencyConflicts, archiveDependencyResolution, digest, fault };
