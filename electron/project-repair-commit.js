'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && key(a) === key(b);
const ID = /^[A-Za-z0-9_-]{8,96}$/;
const optionalMatch = (value, name, expected) => !Object.hasOwn(value, name) || value[name] === expected;
const fault = (message, details) => Object.assign(new Error(message), { code: 'PROJECT_REPAIR_COMMIT_UNCONFIRMED', details });
const METADATA_PHASES = new Set(['final-ack', 'adoption-current', 'final-ack-reconcile']);
function metadataCommitFailure(phase, error, details) {
  if (!METADATA_PHASES.has(phase)) throw new TypeError('Unsupported native metadata commit boundary.');
  return fault('Native repair metadata was not confirmed. Inspect the original request before taking another action.',
    { ...details, phase, cause: error?.code || 'PROJECT_REPAIR_METADATA_WRITE_FAILED' });
}
const isMetadataCommitFailure = error => error?.code === 'PROJECT_REPAIR_COMMIT_UNCONFIRMED' && METADATA_PHASES.has(error.details?.phase);
const ownerFacts = value => ({ version: value.version, lineageId: value.lineageId, epoch: value.epoch,
  ownerHostPid: value.ownerHostPid, environmentId: value.environmentId, recordFile: value.recordFile, hostPid: value.hostPid });
function sameOwner(a, b) {
  return ['version', 'lineageId', 'epoch', 'ownerHostPid', 'environmentId', 'hostPid'].every(name => a?.[name] === b?.[name])
    && samePath(a?.recordFile, b?.recordFile);
}

/** Private ledger operations only. The caller retains the lineage guard and,
 * for a new epoch, the existing file/build/runtime-idle guards. No child is
 * discovered, started, killed or admitted by this module. */
function createRepairCommitStore({ readJson, writeNew, writeRecord, processState }) {
  function directory(root, candidate) {
    const relative = path.relative(root, candidate);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw fault('Repair ledger path escapes its native lineage.');
    for (let current = root, parts = relative.split(path.sep).filter(Boolean), i = 0; ; i++) {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fault('Repair ledger directory is linked or replaced.');
      if (i === parts.length) break;
      current = path.join(current, parts[i]);
    }
  }
  function read(facts, filename) {
    directory(facts.directory, path.dirname(filename));
    return readJson(filename);
  }
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const unchanged = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.nlink === b.nlink;
  function bytesAt(filename, links) {
    const before = fs.lstatSync(filename);
    if (!before.isFile() || before.isSymbolicLink() || !links.includes(before.nlink) || before.size > 256 * 1024)
      throw fault('An owner publication is not a bounded private regular file.');
    const bytes = fs.readFileSync(filename), after = fs.lstatSync(filename);
    if (!unchanged(before, after)) throw fault('An owner publication changed while it was being observed.');
    return { bytes, stat: after };
  }
  function readClaim(root, filename, expected) {
    directory(root, path.dirname(filename));
    if (fs.lstatSync(filename).nlink === 1) return readJson(filename);
    // A link may be installed before unlinking our staging name is acknowledged.
    // Only this exact complete two-link publication can finish its own cleanup;
    // unknown links, partial claims and all final owner records remain untouched.
    const installed = bytesAt(filename, [2]), value = JSON.parse(installed.bytes.toString('utf8'));
    if (value.version !== 1 || !ID.test(value.lineageId || '') || !ID.test(value.environmentId || '')
      || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || path.basename(filename) !== `${value.epoch}.json`
      || !Number.isSafeInteger(value.ownerHostPid) || value.ownerHostPid < 1
      || value.hostPid !== undefined && (!Number.isSafeInteger(value.hostPid) || value.hostPid < 1)
      || typeof value.recordFile !== 'string' || !path.isAbsolute(value.recordFile)
      || Object.keys(value).some(name => !['version', 'lineageId', 'epoch', 'ownerHostPid', 'environmentId', 'recordFile', 'hostPid'].includes(name))
      || expected && !sameOwner(value, expected)) throw fault('A linked owner claim has no exact native publication proof.');
    const hash = digest(installed.bytes), matches = [];
    for (const name of fs.readdirSync(path.dirname(filename))) {
      const match = /^\.(0|[1-9]\d*)\.json\.([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.([a-f0-9]{64})\.tmp$/.exec(name);
      if (!match || match[1] !== String(value.epoch) || match[3] !== hash) continue;
      const stage = path.join(path.dirname(filename), name), stat = fs.lstatSync(stage);
      // Prior interrupted writes with the same content hash are inert and may
      // coexist. Only the actual second link can prove this installation.
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 2 || stat.ino !== installed.stat.ino || stat.dev !== installed.stat.dev) continue;
      const candidate = bytesAt(stage, [2]);
      if (candidate.stat.ino === installed.stat.ino && candidate.stat.dev === installed.stat.dev && candidate.bytes.equals(installed.bytes)) matches.push(stage);
    }
    if (matches.length !== 1) throw fault('An unknown owner hard link was retained; no publication stage was inferred.');
    directory(root, path.dirname(filename));
    if (!unchanged(installed.stat, fs.lstatSync(filename))) throw fault('The linked owner changed before staging cleanup.');
    const candidate = bytesAt(matches[0], [2]);
    if (candidate.stat.ino !== installed.stat.ino || candidate.stat.dev !== installed.stat.dev || !candidate.bytes.equals(installed.bytes))
      throw fault('The owner staging proof changed before cleanup.');
    fs.unlinkSync(matches[0]);
    return readJson(filename);
  }
  function recordEpoch(root, current) {
    const target = path.join(root, 'owners'); fs.mkdirSync(target, { recursive: true, mode: 0o700 }); directory(root, target);
    const filename = path.join(target, `${current.epoch}.json`), value = ownerFacts(current);
    if (fs.existsSync(filename)) {
      if (!sameOwner(readClaim(root, filename, value), value)) throw fault('An immutable owner claim already belongs to another epoch identity.');
      return;
    }
    const bytes = Buffer.from(JSON.stringify(value)), stage = path.join(target, `.${current.epoch}.json.${randomUUID()}.${digest(bytes)}.tmp`);
    // Never write into the final append-only namespace. Partial writes and sync
    // failures leave inert unique staging evidence, not an occupied epoch.
    writeNew(stage, value);
    const before = bytesAt(stage, [1]);
    if (!before.bytes.equals(bytes)) throw fault('The staged owner bytes did not match their complete native claim.');
    const descriptor = fs.openSync(stage, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(descriptor);
      if (opened.ino !== before.stat.ino || opened.size !== before.stat.size) throw fault('The owner staging file was replaced before sync.');
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    directory(root, target);
    const synced = bytesAt(stage, [1]);
    if (!unchanged(before.stat, synced.stat) || !synced.bytes.equals(bytes)) throw fault('The owner staging file changed before installation.');
    try { fs.linkSync(stage, filename); }
    catch (error) { if (error.code !== 'EEXIST' || !sameOwner(readClaim(root, filename, value), value)) throw error; }
    finally {
      // Only our fully written, exact-inode stage is eligible for removal.
      const remaining = bytesAt(stage, [1, 2]);
      if (remaining.stat.ino !== before.stat.ino || remaining.stat.dev !== before.stat.dev || !remaining.bytes.equals(bytes))
        throw fault('The exact owner stage changed and was retained.');
      fs.unlinkSync(stage);
    }
    if (!sameOwner(readJson(filename), value)) throw fault('Installed owner readback differs from its complete native claim.');
  }
  function authenticatedCurrent(facts, actual) {
    const { origin, current, record } = facts;
    return actual?.version === 2 && processState(current.hostPid) === true
      && samePath(actual.project, origin.project) && samePath(actual.sourceProject, origin.sourceProject)
      && actual.requestId === origin.requestId && actual.lineageId === origin.lineageId
      && actual.environmentId === current.environmentId && actual.epoch === current.epoch
      && actual.hostPid === current.hostPid && actual.parentHostPid === current.ownerHostPid
      && actual.hostCodeIdentity === record.hostCodeIdentity
      && ['starting', 'ready', 'load-failed', 'failed'].includes(actual.state);
  }
  function reconcile(facts, actual) {
    if (!authenticatedCurrent(facts, actual)) return;
    const requests = path.join(facts.directory, 'requests');
    if (!fs.existsSync(requests)) return;
    directory(facts.directory, requests);
    for (const filename of fs.readdirSync(requests)) {
      if (!filename.endsWith('.json')) continue;
      const target = path.join(requests, filename), request = read(facts, target), current = facts.current;
      if (request.state !== 'pending') continue;
      if (!ID.test(request.resumeRequestId || '') || filename !== request.resumeRequestId + '.json'
        || request.requestId !== facts.origin.requestId || request.epoch !== current.epoch
        || request.attemptId !== current.environmentId || !samePath(request.recordFile, current.recordFile)) continue;
      const attempt = read(facts, request.recordFile);
      if (!optionalMatch(attempt, 'resumeRequestId', request.resumeRequestId) || attempt.epoch !== current.epoch
        || attempt.requestId !== request.requestId || attempt.environmentId !== current.environmentId
        || attempt.hostPid !== current.hostPid || attempt.parentHostPid !== current.ownerHostPid
        || !samePath(attempt.project, facts.origin.project) || !samePath(attempt.sourceProject, facts.origin.sourceProject)
        || attempt.hostCodeIdentity !== facts.record.hostCodeIdentity) continue;
      const spawn = read(facts, path.join(path.dirname(request.recordFile), request.attemptId, 'spawn.json'));
      if (spawn.pid !== current.hostPid || spawn.environmentId !== current.environmentId
        || !optionalMatch(spawn, 'resumeRequestId', request.resumeRequestId)
        || !optionalMatch(spawn, 'requestId', request.requestId) || !optionalMatch(spawn, 'epoch', current.epoch)) continue;
      const owner = read(facts, path.join(facts.directory, 'owners', `${current.epoch}.json`));
      if (!sameOwner(owner, current) || !sameOwner(read(facts, path.join(facts.directory, 'current.json')), current)) continue;
      try {
        writeRecord(target, { ...request, state: 'completed', completion: { version: 1, kind: 'observed-active-epoch',
          environmentId: current.environmentId, epoch: current.epoch, hostPid: current.hostPid, ownerHostPid: current.ownerHostPid } });
      } catch (error) {
        throw metadataCommitFailure('final-ack-reconcile', error,
          { requestId: request.requestId, resumeRequestId: request.resumeRequestId, epoch: current.epoch });
      }
    }
  }
  function nextEpoch(facts, callerPid) {
    const owners = path.join(facts.directory, 'owners');
    let maximum = facts.current.epoch;
    if (!fs.existsSync(owners)) return maximum + 1;
    directory(facts.directory, owners);
    for (const filename of fs.readdirSync(owners)) {
      if (!/^(0|[1-9]\d*)\.json$/.test(filename)) continue;
      const epoch = Number(filename.slice(0, -5));
      if (!Number.isSafeInteger(epoch)) throw fault('Repair epoch reservation is not a safe integer.');
      maximum = Math.max(maximum, epoch);
      if (epoch <= facts.current.epoch) continue;
      const claim = readClaim(facts.directory, path.join(owners, filename));
      if (claim.version !== 1 || claim.lineageId !== facts.origin.lineageId || claim.epoch !== epoch
        || !Number.isSafeInteger(claim.ownerHostPid) || claim.ownerHostPid < 1 || !Number.isSafeInteger(claim.hostPid) || claim.hostPid < 1)
        throw fault('An uncommitted repair epoch has incomplete native evidence.', { resource: 'repair-epoch', epoch });
      if (claim.ownerHostPid !== callerPid && processState(claim.ownerHostPid) !== false)
        throw Object.assign(fault('An uncommitted repair epoch still has an alive or unknown native owner.',
          { resource: 'repair-epoch', epoch, owner: { pid: claim.ownerHostPid } }), { code: 'PROJECT_REPAIR_OWNER_STILL_ACTIVE' });
      const sameChild = claim.hostPid === facts.current.hostPid && claim.environmentId === facts.current.environmentId
        && samePath(claim.recordFile, facts.current.recordFile);
      if (!sameChild && processState(claim.hostPid) !== false)
        throw fault('An uncommitted epoch may still own another child; no epoch was skipped.',
          { resource: 'repair-epoch-child', epoch, owner: { pid: claim.hostPid } });
      // Even a conclusively exited candidate must point to its own native file,
      // not a path alias or an unrelated process record.
      if (!sameChild) {
        const expected = path.join(facts.directory, 'epochs', `${epoch}-${claim.environmentId}.json`);
        if (!samePath(claim.recordFile, expected)) throw fault('An uncommitted epoch points outside its native attempt.');
        const attempt = read(facts, expected);
        if (attempt.environmentId !== claim.environmentId || attempt.hostPid !== claim.hostPid || attempt.epoch !== epoch
          || attempt.parentHostPid !== claim.ownerHostPid || attempt.requestId !== facts.origin.requestId
          || !samePath(attempt.project, facts.origin.project) || !samePath(attempt.sourceProject, facts.origin.sourceProject)
          || attempt.hostCodeIdentity !== facts.record.hostCodeIdentity) throw fault('An exited epoch differs from its native attempt.');
      }
    }
    if (!Number.isSafeInteger(maximum + 1)) throw fault('No safe monotonic repair epoch remains.');
    return maximum + 1;
  }
  return { recordEpoch, reconcile, nextEpoch };
}
module.exports = { createRepairCommitStore, metadataCommitFailure, isMetadataCommitFailure };
