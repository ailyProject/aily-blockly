const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const {
  projectFileHash: hash, projectFileFault: fault, projectFileGuard,
  createProjectFileAccess, acquireProjectFileLock,
} = require('./project-file-access');

const modePath = '.aily/workspace-mode.json';
const selectedMode = Buffer.from(JSON.stringify({ version: 1, mode: 'project-v1' }) + '\n');
const fail = message => fault('CODER_WORKSPACE_MIGRATION_CONFLICT', message);

async function coderWorkspaceHistory(projectPath, request, assertCurrent) {
  const root = fs.realpathSync.native(projectPath);
  const access = createProjectFileAccess(root, projectPath);
  const guard = projectFileGuard(assertCurrent);
  const read = relative => {
    guard();
    access.checkRoot();
    const parts = relative.split('/');
    for (let index = 1; index < parts.length; index++) {
      try { access.checkDirectory(path.join(root, ...parts.slice(0, index))); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
    return access.readRegular(path.join(root, relative));
  };
  const checkedMode = () => {
    const manifest = read('package.json');
    if (!manifest || JSON.parse(manifest.toString('utf8')).type !== 'coder')
      throw fail('The attached project is not a Coder project.');
    const bytes = read(modePath);
    const data = bytes === null ? { version: 1, mode: 'overlay-v1' } : JSON.parse(bytes.toString('utf8'));
    if (data?.version !== 1 || !['overlay-v1', 'project-v1'].includes(data.mode)
      || Object.keys(data).sort().join(',') !== 'mode,version')
      throw fail('The Coder project has invalid execution mode metadata.');
    return { bytes, mode: data.mode };
  };
  const protocol = mode => ({
    ok: true,
    project: root,
    protocol: {
      workspaceMode: mode,
      supportedWorkspaceModes: ['overlay-v1', 'project-v1'],
      workspaceModeBinding: { version: 1, product: 'coder', attachment: access.attachment },
    },
  });
  if (request?.operation === 'status') return protocol(checkedMode().mode);
  const recordHash = request?.recordHash;
  if (request?.operation !== 'select' || typeof recordHash !== 'string' || !/^[a-f0-9]{64}$/.test(recordHash))
    throw fail('Coder mode selection requires its exact prepared History record.');

  const lock = await acquireProjectFileLock(access, guard);
  let temporary;
  try {
    const verify = () => {
      lock.assertOwned();
      const state = checkedMode();
      const metadata = read('.workspace-history/workspace.json');
      const workspace = metadata && JSON.parse(metadata.toString('utf8'));
      const migration = workspace?.executionMigration;
      const persisted = read(`.workspace-history/objects/${recordHash.slice(0, 2)}/${recordHash}.blob`);
      if (!persisted || hash(persisted) !== `sha256:${recordHash}` || migration?.version !== 1
        || migration.product !== 'coder' || migration.phase !== 'prepared' || migration.recordHash !== recordHash
        || migration.from !== 'overlay-v1' || migration.to !== 'project-v1'
        || workspace.executionMode !== 'overlay-v1')
        throw fail('The original Coder History migration has changed.');
      const record = JSON.parse(persisted.toString('utf8'));
      if (record?.version !== 1 || record.product !== 'coder' || record.workspaceId !== workspace.workspaceId
        || !isDeepStrictEqual(record.attachment, access.attachment)
        || state.mode === 'overlay-v1' && record.modeBeforeHash !== hash(state.bytes))
        throw fail('The prepared migration does not match this physical Coder project.');
      return state.mode;
    };
    if (verify() === 'project-v1') return protocol('project-v1');
    temporary = path.join(root, '.aily', `.workspace-mode-${randomUUID()}.tmp`);
    const handle = await fs.promises.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(selectedMode); await handle.sync(); }
    finally { await handle.close(); }
    if (verify() !== 'overlay-v1') throw fail('The Coder mode changed during selection.');
    fs.renameSync(temporary, path.join(root, modePath));
    temporary = undefined;
    if (verify() !== 'project-v1') throw fail('The selected Coder mode could not be read back.');
    return protocol('project-v1');
  } finally {
    try {
      if (temporary) { access.checkRoot(); access.checkDirectory(path.dirname(temporary)); fs.unlinkSync(temporary); }
    } finally {
      const warnings = lock.release();
      if (warnings.length) throw fail(warnings.join(', '));
    }
  }
}

module.exports = { coderWorkspaceHistory };
