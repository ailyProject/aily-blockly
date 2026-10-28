const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_RECEIPT_BYTES = 256 * 1024;
const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const fault = (code, message) => Object.assign(new Error(message), { code });
const key = project => process.platform === 'win32' ? path.resolve(project).toLowerCase() : path.resolve(project);

/** Private host observations, never source-project locks or build artifacts.
 * A pending entry is append-once. A new renderer may observe it but cannot
 * restart its side effect or claim that a lost owner completed successfully. */
function createProjectRecoveryReceipts(appDataPath, files = fs) {
  const owner = randomUUID();
  const root = typeof appDataPath === 'string' && appDataPath.trim()
    ? path.resolve(appDataPath, 'agent-recovery-receipts') : null;
  const directory = () => {
    if (!root) throw fault('PROJECT_FORK_RECEIPT_UNAVAILABLE', 'Private recovery receipt storage is unavailable.');
    files.mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = files.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fault('PROJECT_FORK_RECEIPT_INVALID', 'Recovery receipt directory is not a private regular directory.');
  };
  const locate = (project, requestId) => {
    if (typeof project !== 'string' || !path.isAbsolute(project)
      || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,96}$/.test(requestId))
      throw fault('PROJECT_FORK_RECEIPT_INVALID', 'Invalid recovery receipt identity.');
    directory();
    return path.join(root, createHash('sha256').update(key(project) + '\0' + requestId).digest('hex') + '.json');
  };
  const read = filename => {
    let stat;
    try { stat = files.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_RECEIPT_BYTES)
      throw fault('PROJECT_FORK_RECEIPT_INVALID', 'Recovery receipt is not a bounded private regular file.');
    const bytes = files.readFileSync(filename);
    const after = files.lstatSync(filename);
    if (after.ino !== stat.ino || after.dev !== stat.dev || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw fault('PROJECT_FORK_RECEIPT_INVALID', 'Recovery receipt changed while reading.');
    const entry = JSON.parse(bytes.toString('utf8'));
    if (entry?.version !== 1 || typeof entry.project !== 'string' || typeof entry.requestId !== 'string'
      || typeof entry.owner !== 'string' || typeof entry.signature !== 'string'
      || !['running', 'completed'].includes(entry.state)
      || entry.sourceAbiHash !== null && !/^sha256:[a-f0-9]{64}$/.test(entry.sourceAbiHash ?? ''))
      throw fault('PROJECT_FORK_RECEIPT_INVALID', 'Recovery receipt has an unsupported format.');
    if (entry.state === 'completed' && (!entry.result || typeof entry.result !== 'object' || Array.isArray(entry.result)
      || entry.result.projectSaved === true && !/^sha256:[a-f0-9]{64}$/.test(entry.targetAbiHash ?? '')))
      throw fault('PROJECT_FORK_RECEIPT_INVALID', 'Recovery completion facts are incomplete.');
    return { entry, text: bytes.toString('utf8') };
  };
  const writeNew = (filename, value) => {
    const handle = files.openSync(filename, 'wx', 0o600);
    try { files.writeFileSync(handle, value); files.fsyncSync(handle); } finally { files.closeSync(handle); }
  };
  const inspect = (project, requestId, signature) => {
    const found = read(locate(project, requestId));
    if (found && (key(found.entry.project) !== key(project) || found.entry.requestId !== requestId
      || signature !== undefined && found.entry.signature !== signature))
      throw fault('PROJECT_FORK_RECEIPT_CONFLICT', 'Recovery request belongs to different source/options.');
    return found;
  };
  return {
    begin(project, requestId, signature, sourceAbiHash) {
      if (typeof signature !== 'string' || signature.length > 4096
        || sourceAbiHash !== null && !/^sha256:[a-f0-9]{64}$/.test(sourceAbiHash ?? ''))
        throw fault('PROJECT_FORK_RECEIPT_INVALID', 'A fork requires its exact source and options evidence.');
      const filename = locate(project, requestId);
      const existing = inspect(project, requestId, signature);
      if (existing) return { created: false, ...existing.entry };
      const entry = { version: 1, project, requestId, signature, sourceAbiHash, state: 'running', owner };
      try { writeNew(filename, JSON.stringify(entry)); return { created: true, ...entry }; }
      catch (error) { if (error.code !== 'EEXIST') throw error; return { created: false, ...inspect(project, requestId, signature).entry }; }
    },
    complete(project, requestId, signature, result, targetAbiHash) {
      const before = inspect(project, requestId, signature);
      if (!before || before.entry.owner !== owner || before.entry.state !== 'running')
        throw fault('PROJECT_FORK_RECEIPT_CONFLICT', 'Only the original live fork owner may record its completion.');
      if (result?.projectSaved === true && !/^sha256:[a-f0-9]{64}$/.test(targetAbiHash ?? ''))
        throw fault('PROJECT_FORK_RECEIPT_INVALID', 'Saved recovery target has no exact ABI evidence.');
      const text = JSON.stringify({ ...before.entry, state: 'completed', result, targetAbiHash: targetAbiHash ?? null });
      if (Buffer.byteLength(text) > MAX_RECEIPT_BYTES) throw fault('PROJECT_FORK_RECEIPT_INVALID', 'Recovery receipt exceeds its metadata limit.');
      const filename = locate(project, requestId), temporary = filename + '.' + randomUUID() + '.tmp';
      let owned = false;
      try {
        writeNew(temporary, text); owned = true;
        if (inspect(project, requestId, signature)?.text !== before.text)
          throw fault('PROJECT_FORK_RECEIPT_CONFLICT', 'Recovery receipt changed before completion.');
        files.renameSync(temporary, filename); owned = false;
        if (inspect(project, requestId, signature)?.text !== text)
          throw fault('PROJECT_FORK_RECEIPT_INVALID', 'Recovery receipt completion is uncertain.');
      } finally { if (owned) files.unlinkSync(temporary); }
      return JSON.parse(text);
    },
    status(project, requestId) { return inspect(project, requestId)?.entry ?? null; },
    abiHash(project) {
      const file = path.join(project, 'project.abi');
      let stat;
      try { stat = files.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128 * 1024 * 1024)
        throw fault('PROJECT_FORK_SOURCE_UNREADABLE', 'Fork ABI must be a bounded unlinked regular file.');
      const bytes = files.readFileSync(file), after = files.lstatSync(file);
      if (after.ino !== stat.ino || after.dev !== stat.dev || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size)
        throw fault('PROJECT_FORK_SOURCE_UNREADABLE', 'Fork ABI changed while capturing receipt evidence.');
      return digest(bytes);
    },
  };
}

module.exports = { createProjectRecoveryReceipts };
