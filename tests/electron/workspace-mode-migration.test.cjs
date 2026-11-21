const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { projectFileHash: hash } = require('../../electron/project-file-access');
const { openProjectSyncStorage } = require('../../electron/project-sync-storage');
const { observeProjectWorkspaceMigration, replacePreparedWorkspaceMigration, selectProjectWorkspaceMode, selectProjectWorkspaceModeBridge } = require('../../electron/project-workspace-mode');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-mode-migration-'));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^aily-mode-migration-/);
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (file, data) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), data); };
  write('project.abi', '{"accepted":true}'); write('project.abs', '# dirty author\n'); write('project.abs.map.json', '{"generation":"accepted"}');
  write('.aily/abs-sync/committed.json', '{"generation":"accepted"}');
  const old = await openProjectSyncStorage(root, () => {});
  const expected = { abiHash: hash(fs.readFileSync(path.join(root, 'project.abi'))), absHash: hash(fs.readFileSync(path.join(root, 'project.abs'))),
    mapHash: hash(fs.readFileSync(path.join(root, 'project.abs.map.json'))), committedHash: hash(fs.readFileSync(path.join(root, '.aily/abs-sync/committed.json'))), preparedHash: null };
  const documentHash = hash('actual Working document');
  const record = { version: 1, from: 'overlay-v1', to: 'project-v1', attachment: old.attachment,
    modeBefore: { text: null, hash: null }, authorSnapshotId: 'a'.repeat(64), overlaySnapshots: [], candidateRefs: {}, draftObjects: [],
    accepted: { version: 1, attachment: old.attachment, accepted: { generation: 'accepted', scope: { projectKey: old.attachment.root, pageId: 'main' },
      abiHash: expected.abiHash, mapHash: expected.mapHash, absHash: hash('# accepted author\n') }, committedHash: expected.committedHash },
    host: { expected, workingRevision: 4, workingDocumentHash: documentHash, author: { hash: expected.absHash, bytes: 15 } },
    authorPlan: [], retiredTurns: [] };
  const archive = value => {
    const bytes = Buffer.from(JSON.stringify(value)), recordHash = hash(bytes).slice(7);
    write(`.workspace-history/objects/${recordHash.slice(0, 2)}/${recordHash}.blob`, bytes);
    return recordHash;
  };
  const prepare = value => {
    const recordHash = archive(value);
    write('.workspace-history/workspace.json', JSON.stringify({ executionMode: 'overlay-v1',
      executionMigration: { version: 1, from: 'overlay-v1', to: 'project-v1', phase: 'prepared', recordHash } }));
    return { version: 1, recordHash, workingRevision: value.host.workingRevision, workingDocumentHash: value.host.workingDocumentHash ?? documentHash };
  };
  return { root, old, expected, record, write, archive, prepare, input: prepare(record) };
}

test('a fresh prepared record fences a delayed original selector, retains its archive and leaves program bytes alone', async t => {
  const f = await fixture(t), historyLock = path.join(f.root, '.workspace-history/workspace.lock');
  const originalHash = f.input.recordHash;
  const replacementHash = f.archive({ ...f.record, previousRecordHash: originalHash, selectionAttempt: '4aef75dc-ab44-4422-adb2-d88e16d69b25' });
  const params = { version: 1, recordHash: originalHash, replacementHash };
  const workspace = () => JSON.parse(fs.readFileSync(path.join(f.root, '.workspace-history/workspace.json'), 'utf8'));
  const author = fs.readFileSync(path.join(f.root, 'project.abs'));
  fs.mkdirSync(historyLock);
  assert.equal((await replacePreparedWorkspaceMigration(f.root, params, () => {})).code, 'PROJECT_FILE_BUSY');
  assert.equal(workspace().executionMigration.recordHash, originalHash);
  fs.rmdirSync(historyLock);
  const reply = await replacePreparedWorkspaceMigration(f.root, params, () => {});
  assert.deepEqual(reply.replacement, { version: 1, recordHash: originalHash, replacementHash, state: 'replaced' });
  assert.equal(workspace().executionMigration.recordHash, replacementHash);
  assert.equal(fs.existsSync(path.join(f.root, '.aily/workspace-mode.json')), false);
  await assert.rejects(selectProjectWorkspaceMode(f.root, f.input, () => {}), { code: 'ABS_WORKSPACE_MIGRATION_CONFLICT' });
  assert.equal((await replacePreparedWorkspaceMigration(f.root, params, () => {})).ok, false);
  assert.equal((await selectProjectWorkspaceMode(f.root, { ...f.input, recordHash: replacementHash }, () => {})).selected, true);
  assert.equal((await observeProjectWorkspaceMigration(f.root, { version: 1, recordHash: replacementHash })).ok, true);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'project.abs')), author);
});

test('a selector that wins the native lock keeps its original receipt when the replacement arrives', async t => {
  const f = await fixture(t);
  const originalHash = f.input.recordHash;
  const replacementHash = f.archive({ ...f.record, previousRecordHash: originalHash, selectionAttempt: '4aef75dc-ab44-4422-adb2-d88e16d69b25' });
  await selectProjectWorkspaceMode(f.root, f.input, () => {});
  const result = await replacePreparedWorkspaceMigration(f.root, { version: 1, recordHash: originalHash, replacementHash }, () => {});
  assert.deepEqual(result.replacement, { version: 1, recordHash: originalHash, replacementHash, state: 'selected' });
  assert.equal((await observeProjectWorkspaceMigration(f.root, { version: 1, recordHash: originalHash })).ok, true);
  assert.equal((await observeProjectWorkspaceMigration(f.root, { version: 1, recordHash: replacementHash })).ok, false);
});

test('detached migration status proves only the selected original without writing a lock, mode or project file', async t => {
  const f = await fixture(t), input = { version: 1, recordHash: f.input.recordHash };
  const mode = path.join(f.root, '.aily/workspace-mode.json');
  assert.equal((await observeProjectWorkspaceMigration(f.root, input)).ok, false);
  assert.equal(fs.existsSync(mode), false);
  assert.equal(fs.existsSync(path.join(f.root, '.aily/project-files.guard')), false);
  await selectProjectWorkspaceMode(f.root, f.input, () => {});
  f.write('project.abs', '# authorPlan already changed draft bytes before disconnect');
  const before = new Map(['project.abi', 'project.abs', 'project.abs.map.json', '.aily/workspace-mode.json',
    '.aily/abs-sync/committed.json', '.workspace-history/workspace.json'].map(file => [file, fs.readFileSync(path.join(f.root, file))]));
  const observation = await observeProjectWorkspaceMigration(f.root, input);
  assert.equal(observation.ok, true);
  assert.equal(observation.operation, 'abs_workspace_migration_status');
  assert.equal(observation.project, f.old.attachment.root);
  assert.deepEqual(observation.migrationReceipt, { version: 1, recordHash: input.recordHash, from: 'overlay-v1', to: 'project-v1', selected: true, reused: true });
  assert.deepEqual(observation.protocol.workspaceModeBinding, f.record.accepted);
  for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(f.root, file)), bytes);
  assert.equal((await observeProjectWorkspaceMigration(f.root, { ...input, recordHash: 'f'.repeat(64) })).ok, false);
  assert.equal((await observeProjectWorkspaceMigration(f.root, { ...input, workingRevision: 0 })).ok, false);
  f.write('project.abi', '{"changed":true}');
  assert.equal((await observeProjectWorkspaceMigration(f.root, input)).ok, false);
});

test('native migration selects only the prepared physical project, keeps all author files, revokes old storage and observes a restart', async t => {
  const f = await fixture(t), original = ['project.abi', 'project.abs', 'project.abs.map.json'].map(file => [file, fs.readFileSync(path.join(f.root, file))]);
  const result = await selectProjectWorkspaceMode(f.root, f.input, () => {});
  assert.equal(result.selected, true); assert.equal(result.reused, false);
  for (const [file, bytes] of original) assert.deepEqual(fs.readFileSync(path.join(f.root, file)), bytes);
  await assert.rejects(f.old.read('project.abs'), { code: 'ABS_WORKSPACE_MODE_CHANGED' });
  f.write('project.abs', '# authorPlan finished partially before a crash');
  const marker = fs.statSync(path.join(f.root, '.aily/workspace-mode.json')).mtimeMs;
  const retry = await selectProjectWorkspaceMode(f.root, { ...f.input, workingRevision: 1, workingDocumentHash: hash('restored Working after restart') }, () => {});
  assert.equal(retry.reused, true); assert.equal(fs.statSync(path.join(f.root, '.aily/workspace-mode.json')).mtimeMs, marker);
  assert.equal(fs.readFileSync(path.join(f.root, 'project.abs'), 'utf8'), '# authorPlan finished partially before a crash');
});

test('native migration reads a canonical JSON archive independent of attachment key order but rejects different physical identities', async t => {
  const f = await fixture(t);
  // History content-addresses canonical JSON, which recursively sorts object
  // keys rather than retaining the insertion order of the native attachment.
  const canonical = value => value === null || typeof value !== 'object' ? value
    : Array.isArray(value) ? value.map(canonical)
      : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  const record = canonical(f.record);
  assert.notEqual(JSON.stringify(record.attachment), JSON.stringify(f.old.attachment));
  assert.deepEqual(record.attachment, f.old.attachment);
  for (const [section, field] of [['attachment', 'version'], ['attachment', 'root'],
    ['attachment', 'dev'], ['attachment', 'ino'], ['attachment', 'birthtimeNs'], ['accepted', 'ino']]) {
    const changed = structuredClone(record), attachment = section === 'accepted' ? changed.accepted.attachment : changed.attachment;
    if (field === 'version') attachment.version = 2;
    else if (field === 'root') attachment.root += '-different';
    else attachment.identity[field] += '1';
    const input = f.prepare(changed);
    await assert.rejects(selectProjectWorkspaceMode(f.root, input, () => {}), { code: 'ABS_WORKSPACE_MIGRATION_CONFLICT' });
    assert.equal(fs.existsSync(path.join(f.root, '.aily/workspace-mode.json')), false);
  }
  const input = f.prepare(record), result = await selectProjectWorkspaceMode(f.root, input, () => {});
  assert.equal(result.selected, true); assert.equal(result.reused, false);
  assert.equal(fs.readFileSync(path.join(f.root, 'project.abs'), 'utf8'), '# dirty author\n');
});

test('native migration uses the legacy default only for an absent History executionMode and rejects explicit invalid modes', async t => {
  const f = await fixture(t), file = path.join(f.root, '.workspace-history/workspace.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  const author = fs.readFileSync(path.join(f.root, 'project.abs'));
  for (const executionMode of [null, 'unknown-engine', 'project-v1']) {
    f.write('.workspace-history/workspace.json', JSON.stringify({ ...original, executionMode }));
    await assert.rejects(selectProjectWorkspaceMode(f.root, f.input, () => {}), { code: 'ABS_WORKSPACE_MIGRATION_CONFLICT' });
    assert.equal(fs.existsSync(path.join(f.root, '.aily/workspace-mode.json')), false);
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'project.abs')), author);
  }
  const legacy = { ...original }; delete legacy.executionMode;
  const bytes = JSON.stringify(legacy); f.write('.workspace-history/workspace.json', bytes);
  assert.equal(Object.hasOwn(JSON.parse(bytes), 'executionMode'), false);
  const selected = await selectProjectWorkspaceMode(f.root, f.input, () => {});
  assert.equal(selected.selected, true); assert.equal(selected.reused, false);
  assert.equal((await selectProjectWorkspaceMode(f.root, f.input, () => {})).reused, true);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'project.abs')), author);
});

test('first selection accepts an equal Working document after revision-counter restart and refuses a changed document', async t => {
  const f = await fixture(t);
  const stale = await selectProjectWorkspaceModeBridge(f.root, { ...f.input, workingDocumentHash: hash('different Working') }, () => {});
  assert.equal(stale.ok, false); assert.equal(stale.error.code, 'ABS_WORKSPACE_MIGRATION_OBSERVATION_STALE');
  assert.equal(fs.existsSync(path.join(f.root, '.aily/workspace-mode.json')), false);
  assert.equal((await selectProjectWorkspaceMode(f.root, { ...f.input, workingRevision: 1 }, () => {})).selected, true);
});

test('a competing author write during marker preparation remains intact and prevents mode selection', async t => {
  const f = await fixture(t);
  const files = Object.assign({}, fs, { promises: Object.assign({}, fs.promises, { open: async (...args) => {
    const handle = await fs.promises.open(...args);
    if (!path.basename(args[0]).startsWith('.workspace-mode-')) return handle;
    return { writeFile: (...values) => handle.writeFile(...values), close: () => handle.close(), sync: async () => {
      await handle.sync(); f.write('project.abs', '# real concurrent author');
    } };
  } }) });
  await assert.rejects(selectProjectWorkspaceMode(f.root, f.input, () => {}, { files }), { code: 'ABS_WORKSPACE_MIGRATION_CONFLICT' });
  assert.equal(fs.readFileSync(path.join(f.root, 'project.abs'), 'utf8'), '# real concurrent author');
  assert.equal(fs.existsSync(path.join(f.root, '.aily/workspace-mode.json')), false);
  assert.equal(fs.readdirSync(path.join(f.root, '.aily')).some(file => file.startsWith('.workspace-mode-')), false);
});

test('mode selection rejects a different prepared record, pending native work and physical archive links', async t => {
  const f = await fixture(t);
  const workspace = path.join(f.root, '.workspace-history/workspace.json'), before = fs.readFileSync(workspace);
  f.write('.workspace-history/workspace.json', JSON.stringify({ executionMode: 'overlay-v1', executionMigration: { ...JSON.parse(before).executionMigration, recordHash: 'f'.repeat(64) } }));
  await assert.rejects(selectProjectWorkspaceMode(f.root, f.input, () => {}), { code: 'ABS_WORKSPACE_MIGRATION_CONFLICT' });
  fs.writeFileSync(workspace, before); f.write('.aily/abs-sync/operation.json', '{"version":1,"state":"pending"}');
  await assert.rejects(selectProjectWorkspaceMode(f.root, f.input, () => {}), { code: 'ABS_WORKSPACE_MIGRATION_CONFLICT' });
  fs.unlinkSync(path.join(f.root, '.aily/abs-sync/operation.json'));
  const objects = path.join(f.root, '.workspace-history/objects'), retained = path.join(f.root, '.workspace-history/real-objects');
  fs.renameSync(objects, retained); fs.symlinkSync(retained, objects, 'junction');
  await assert.rejects(selectProjectWorkspaceMode(f.root, f.input, () => {}), { code: 'PROJECT_FILE_UNSAFE_PATH' });
  fs.unlinkSync(objects); fs.renameSync(retained, objects);
  assert.equal(fs.existsSync(path.join(f.root, '.aily/workspace-mode.json')), false);
});

test('prepared migration permits observation but blocks a program writer until its exact History settlement', async t => {
  const f = await fixture(t), before = fs.readFileSync(path.join(f.root, 'project.abs'));
  const state = await f.old.read('history-workspace.json');
  assert.equal(JSON.parse(state).executionMigration.recordHash, f.input.recordHash);
  await f.old.withLock(async storage => {
    assert.equal(await storage.read('project.abs'), before.toString());
    await assert.rejects(storage.replace('project.abs', hash(before), '# must not publish'), { code: 'ABS_WORKSPACE_MIGRATION_PENDING' });
  });
  await selectProjectWorkspaceMode(f.root, f.input, () => {});
  const current = await openProjectSyncStorage(f.root, () => {});
  await assert.rejects(current.withLock(storage => storage.replace('project.abs', hash(before), '# too early')), { code: 'ABS_WORKSPACE_MIGRATION_PENDING' });
  const workspace = JSON.parse(fs.readFileSync(path.join(f.root, '.workspace-history/workspace.json')));
  workspace.executionMode = 'project-v1'; workspace.executionMigration.phase = 'committed';
  f.write('.workspace-history/workspace.json', JSON.stringify(workspace));
  await current.withLock(async storage => {
    await assert.rejects(storage.replace('history-workspace.json', hash(JSON.stringify(workspace)), 'not allowed'), { code: 'ABS_STORAGE_WRITE_INVALID' });
    assert.equal(await storage.replace('project.abs', hash(before), '# normal author after migration'), true);
  });
});
