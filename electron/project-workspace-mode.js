const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { projectFileHash: hash, projectFileFault: fault, projectFileGuard,
  createProjectFileAccess, acquireProjectFileLock } = require('./project-file-access');

const bareHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const same = isDeepStrictEqual;
const fail = message => fault('ABS_WORKSPACE_MIGRATION_CONFLICT', message);
const migrationOperation = 'abs_workspace_migration_status';
const replaceOperation = 'abs_workspace_migration_replace';
const modePath = '.aily/workspace-mode.json';
const selected = Buffer.from(JSON.stringify({ version: 1, mode: 'project-v1' }) + '\n');

function workspaceMode(bytes) {
  try {
    const value = JSON.parse(bytes?.toString('utf8'));
    if (value?.version === 1 && Object.keys(value).sort().join(',') === 'mode,version') return value.mode;
  } catch { /* Ambiguous metadata does not confirm a mode. */ }
}

/** Both entry points use the same verified original records and file fence. */
function readWorkspaceMigration(access, recordHash, guard) {
  const { root } = access;
  const read = relative => {
    guard(); access.checkRoot();
    const segments = relative.split('/');
    for (let i = 1; i < segments.length; i++) {
      try { access.checkDirectory(path.join(root, ...segments.slice(0, i))); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
    return access.readRegular(path.join(root, ...segments));
  };
  const workspacePath = '.workspace-history/workspace.json';
  const archivePath = value => `.workspace-history/objects/${value.slice(0, 2)}/${value}.blob`;
  const objectPath = archivePath(recordHash);
  const originalWorkspace = read(workspacePath), object = read(objectPath);
  if (originalWorkspace === null || hash(object) !== `sha256:${recordHash}`) throw fail('The prepared migration metadata or immutable record is missing.');
  let workspace, record;
  try { workspace = JSON.parse(originalWorkspace.toString('utf8')); record = JSON.parse(object.toString('utf8')); }
  catch { throw fail('The prepared migration metadata is not valid JSON.'); }
  const migration = workspace.executionMigration;
  // Pre-mode History metadata omitted this field. Only absence retains that
  // legacy default; explicit null or another engine never selects it.
  const executionMode = workspace.executionMode === undefined ? 'overlay-v1' : workspace.executionMode;
  if (record?.version !== 1 || record.from !== 'overlay-v1' || record.to !== 'project-v1'
    || migration?.version !== 1 || migration.from !== record.from || migration.to !== record.to
    || !['prepared', 'committed'].includes(migration.phase) || migration.recordHash !== recordHash
    || !['overlay-v1', 'project-v1'].includes(executionMode)
    || !same(record.attachment, access.attachment) || record.accepted?.version !== 1
    || !same(record.accepted.attachment, access.attachment) || !digest(record.accepted.committedHash)
    || !record.host
    || !record.modeBefore || !(record.modeBefore.text === null || typeof record.modeBefore.text === 'string')
    || hash(record.modeBefore.text === null ? null : Buffer.from(record.modeBefore.text, 'utf8')) !== record.modeBefore.hash)
    throw fail('The original migration record does not match this physical project and Working witness.');
  const expected = record.host.expected;
  if (!expected || Object.keys(expected).sort().join(',') !== 'abiHash,absHash,committedHash,mapHash,preparedHash'
    || !Object.values(expected).every(value => value === null || digest(value)) || expected.preparedHash !== null
    || expected.committedHash !== record.accepted.committedHash)
    throw fail('Mode selection requires exact accepted program inputs and no prepared generation.');
  const checks = [
    ['project.abi', 'abiHash'], ['project.abs', 'absHash'], ['project.abs.map.json', 'mapHash'],
    ['.aily/abs-sync/committed.json', 'committedHash'], ['.aily/abs-sync/prepared.json', 'preparedHash'],
  ];
  const mode = read(modePath), reused = hash(mode) !== record.modeBefore.hash;
  if (reused && workspaceMode(mode) !== 'project-v1') throw fail('The project mode changed independently of this prepared migration.');
  // The author plan may already have changed author bytes. Its accepted
  // ABI, map and committed head must still be exact.
  const verifyIntent = () => {
    guard(); access.checkRoot();
    if (!same(read(workspacePath), originalWorkspace) || hash(read(objectPath)) !== `sha256:${recordHash}`)
      throw fail('Migration metadata changed during settlement.');
    if (hash(read(modePath)) !== hash(mode)) throw fail('The selected mode changed during settlement.');
  };
  const verify = () => {
    guard(); access.checkRoot();
    for (const [file, name] of checks) {
      if (reused && file === 'project.abs') continue;
      if (hash(read(file)) !== expected[name]) throw fail('A project file changed during migration settlement.');
    }
    const operation = read('.aily/abs-sync/operation.json');
    if (operation !== null) {
      let pointer;
      try { pointer = JSON.parse(operation.toString('utf8')); } catch {}
      if (pointer?.version !== 1 || pointer.state !== 'completed') throw fail('An original native operation must settle before migration.');
    }
    verifyIntent();
  };
  return { record, expected, workspace, executionMode, reused, workspacePath, archivePath, read, verify, verifyIntent };
}

function migrationReceipt(recordHash, reused) {
  return { version: 1, recordHash, from: 'overlay-v1', to: 'project-v1', selected: true, reused };
}

/** An observation can prove a previous selection without any canvas or writer. */
async function observeProjectWorkspaceMigration(projectPath, input) {
  try {
    if (!path.isAbsolute(projectPath ?? '') || input?.version !== 1 || !bareHash(input.recordHash)
      || Object.keys(input).some(key => !['version', 'recordHash'].includes(key)))
      throw fault('ABS_REQUEST_INVALID', 'Migration observation requires the original absolute project and prepared record.');
    const root = await fs.promises.realpath(projectPath), access = createProjectFileAccess(root, projectPath);
    const { record, expected, reused, verify } = readWorkspaceMigration(access, input.recordHash, () => {});
    if (!reused) throw fail('The original native mode has not been selected.');
    if (record.modeBefore.text !== null && workspaceMode(Buffer.from(record.modeBefore.text)) !== 'overlay-v1')
      throw fail('The originally prepared mode does not authorize this observation.');
    const binding = record.accepted.accepted;
    const normal = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (!binding || !digest(binding.absHash) || binding.abiHash !== expected.abiHash || !digest(binding.abiHash)
      || binding.mapHash !== expected.mapHash || !digest(binding.mapHash)
      || typeof binding.generation !== 'string' || !binding.generation || typeof binding.scope?.pageId !== 'string'
      || !binding.scope.pageId || typeof binding.scope.projectKey !== 'string'
      || normal(binding.scope.projectKey) !== normal(root)) throw fail('The original accepted scope or source digest is not verified.');
    verify();
    return { ok: true, operation: migrationOperation, project: root,
      migrationReceipt: migrationReceipt(input.recordHash, true),
      protocol: { version: 1, workspaceMode: 'project-v1', supportedWorkspaceModes: ['overlay-v1', 'project-v1'],
        workspaceModeBinding: { version: 1, attachment: access.attachment, committedHash: expected.committedHash,
          accepted: { generation: binding.generation, scope: { projectKey: binding.scope.projectKey, pageId: binding.scope.pageId },
            abiHash: binding.abiHash, absHash: binding.absHash, mapHash: binding.mapHash } } } };
  } catch (error) {
    return { ok: false, operation: migrationOperation, code: error.code ?? 'ABS_WORKSPACE_MIGRATION_CONFLICT',
      message: 'The original native migration could not be verified.' };
  }
}

/** Take the same History directory lock used by the agent before native lock. */
function acquireMigrationHistoryLock(access, guard) {
  const history = path.join(access.root, '.workspace-history');
  const directory = path.join(history, 'workspace.lock'), file = path.join(directory, 'owner.json');
  const owner = Buffer.from(JSON.stringify({ pid: process.pid, token: `${process.pid}-${randomBytes(8).toString('hex')}`, createdAt: Date.now() }));
  guard(); access.checkRoot(); access.checkDirectory(history);
  try { fs.mkdirSync(directory); }
  catch (error) {
    if (error.code === 'EEXIST') throw fault('PROJECT_FILE_BUSY', 'The original History writer still owns this migration.');
    throw error;
  }
  try { fs.writeFileSync(file, owner, { flag: 'wx', mode: 0o600 }); }
  catch (error) { fs.rmdirSync(directory); throw error; }
  access.checkDirectory(directory);
  const assertOwned = () => {
    access.checkRoot(); access.checkDirectory(history); access.checkDirectory(directory);
    if (!same(access.readRegular(file), owner)) throw fail('The original History writer no longer owns this migration.');
  };
  return { assertOwned, release() { assertOwned(); fs.unlinkSync(file); fs.rmdirSync(directory); } };
}

/** Revoke an unselected writer under both History and native locks. No source
 * or mode is changed, including when the previous selector wins the race. */
async function replacePreparedWorkspaceMigration(projectPath, input, assertCurrent) {
  try {
    if (!path.isAbsolute(projectPath ?? '') || input?.version !== 1 || !bareHash(input.recordHash)
      || !bareHash(input.replacementHash) || input.recordHash === input.replacementHash
      || Object.keys(input).some(key => !['version', 'recordHash', 'replacementHash'].includes(key)))
      throw fault('ABS_REQUEST_INVALID', 'Migration replacement requires exact original and successor records.');
    const guard = projectFileGuard(assertCurrent), root = await fs.promises.realpath(projectPath);
    const access = createProjectFileAccess(root, projectPath);
    const history = acquireMigrationHistoryLock(access, guard);
    let lock, temporary;
    try {
      lock = await acquireProjectFileLock(access, guard);
      const { record, workspace, executionMode, reused, workspacePath, archivePath, read, verifyIntent } =
        readWorkspaceMigration(access, input.recordHash, guard);
      const verifyOwner = () => {
        history.assertOwned(); lock.assertOwned(); verifyIntent();
      };
      verifyOwner();
      if (!reused) {
        if (workspace.executionMigration.phase !== 'prepared' || executionMode !== 'overlay-v1'
          || record.modeBefore.text !== null && workspaceMode(Buffer.from(record.modeBefore.text)) !== 'overlay-v1')
          throw fail('The original workspace is not an unselected prepared migration.');
        const nextPath = archivePath(input.replacementHash), next = read(nextPath);
        if (hash(next) !== `sha256:${input.replacementHash}`) throw fail('The replacement archive is missing.');
        const successor = JSON.parse(next.toString('utf8'));
        if (successor?.version !== record.version || successor.from !== record.from || successor.to !== record.to
          || successor.previousRecordHash !== input.recordHash || !same(successor.attachment, access.attachment)
          || !same(successor.accepted?.attachment, access.attachment) || !same(successor.modeBefore, record.modeBefore))
          throw fail('The replacement archive is not bound to this original preparation.');
        const target = path.join(root, workspacePath);
        temporary = path.join(path.dirname(target), `.workspace-migration-${randomUUID()}.tmp`);
        workspace.executionMigration.recordHash = input.replacementHash;
        const handle = await fs.promises.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(workspace)); await handle.sync(); }
        finally { await handle.close(); }
        if (hash(read(nextPath)) !== `sha256:${input.replacementHash}`) throw fail('The replacement archive changed.');
        verifyOwner();
        fs.renameSync(temporary, target); temporary = undefined;
      }
      return { ok: true, operation: replaceOperation, project: root, replacement: { version: 1,
        recordHash: input.recordHash, replacementHash: input.replacementHash, state: reused ? 'selected' : 'replaced' } };
    } finally {
      try {
        if (temporary) { access.checkRoot(); access.checkDirectory(path.dirname(temporary)); fs.unlinkSync(temporary); }
      } finally {
        try {
          const warnings = lock?.release();
          if (warnings?.length) throw fail(warnings.join('; '));
        } finally { history.release(); }
      }
    }
  } catch (error) {
    return { ok: false, operation: replaceOperation, code: error.code ?? 'ABS_WORKSPACE_MIGRATION_CONFLICT',
      message: 'The original prepared migration could not be replaced.' };
  }
}

function assertNoPreparedWorkspaceMigration(access) {
  const directory = path.join(access.root, '.workspace-history');
  try { access.checkDirectory(directory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const bytes = access.readRegular(path.join(directory, 'workspace.json'));
  if (bytes === null) return;
  let state;
  try { state = JSON.parse(bytes.toString('utf8')); }
  catch { throw fail('History metadata is invalid; no program writer was admitted.'); }
  if (state.executionMigration?.phase === 'prepared')
    throw fault('ABS_WORKSPACE_MIGRATION_PENDING', 'The original workspace migration must settle before another program writer.');
}

/** Select one persisted author engine. The prepared immutable History archive
 * is the intent; this adapter never executes its author plan or edits History. */
async function selectProjectWorkspaceMode(projectPath, input, assertCurrent, options = {}) {
  const files = options.files || fs, guard = projectFileGuard(assertCurrent);
  if (input?.version !== 1 || !bareHash(input.recordHash) || !Number.isSafeInteger(input.workingRevision)
    || input.workingRevision < 0 || !digest(input.workingDocumentHash)
    || Object.keys(input).some(key => !['version', 'recordHash', 'workingRevision', 'workingDocumentHash'].includes(key)))
    throw fail('A mode selection requires its exact prepared record and current Working witness.');
  guard();
  const root = await files.promises.realpath(projectPath); guard();
  const access = createProjectFileAccess(root, projectPath, files);
  const lock = await acquireProjectFileLock(access, guard, options.timeoutMs);
  let temporary;
  try {
    const { record, executionMode, reused, read, verify } = readWorkspaceMigration(access, input.recordHash, guard);
    if (!reused && executionMode !== 'overlay-v1') throw fail('History selected a different engine before the mode was committed.');
    if (!reused) {
      if (record.modeBefore.text !== null && workspaceMode(Buffer.from(record.modeBefore.text)) !== 'overlay-v1'
        || (record.host.workingDocumentHash !== undefined
          ? record.host.workingDocumentHash !== input.workingDocumentHash : record.host.workingRevision !== input.workingRevision))
        throw fault('ABS_WORKSPACE_MIGRATION_OBSERVATION_STALE', 'The original mode or Working document changed before its first selection.');
    }
    lock.assertOwned();
    verify();
    if (!reused) {
      const directory = path.join(root, '.aily');
      try { files.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      access.checkDirectory(directory);
      temporary = path.join(directory, `.workspace-mode-${randomUUID()}.tmp`);
      const handle = await files.promises.open(temporary, 'wx', 0o600);
      try { guard(); await handle.writeFile(selected); await handle.sync(); }
      finally { await handle.close(); }
      lock.assertOwned();
      verify();
      files.renameSync(temporary, path.join(root, modePath)); temporary = undefined;
      guard(); access.checkRoot();
      if (hash(read(modePath)) !== hash(selected)) throw fail('Mode publication has an uncertain outcome; retain the original prepared record.');
    }
    return migrationReceipt(input.recordHash, reused);
  } finally {
    try {
      if (temporary) { access.checkRoot(); access.checkDirectory(path.dirname(temporary)); files.unlinkSync(temporary); }
    } finally {
      const warnings = lock.release();
      if (warnings.length) throw fail(warnings.join('; '));
    }
  }
}

async function selectProjectWorkspaceModeBridge(...args) {
  try { return { ok: true, value: await selectProjectWorkspaceMode(...args) }; }
  catch (error) { return { ok: false, error: { code: error.code, message: error.message } }; }
}
module.exports = { observeProjectWorkspaceMigration, replacePreparedWorkspaceMigration, selectProjectWorkspaceMode, selectProjectWorkspaceModeBridge, assertNoPreparedWorkspaceMigration };
