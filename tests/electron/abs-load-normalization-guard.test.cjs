'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const test = require('node:test');
const { openProjectSyncStorage } = require('../../electron/project-sync-storage');
const { projectFileGuard } = require('../../electron/project-file-access');
const root = path.resolve(__dirname, '../..');

function evaluate(source, globals) {
  const module = { exports: {} };
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, Error, Promise, crypto, ...globals });
  return module.exports;
}
function source(relative) {
  return ts.createSourceFile(
    relative,
    fs.readFileSync(path.join(root, relative), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
}

function fixture(t, pointerHash = null, changeReadback = false) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-load-guard-'));
  t.after(() => {
    assert.equal(path.dirname(project), os.tmpdir());
    fs.rmSync(project, { recursive: true, force: true });
  });
  const calls = {
    nativeOpen: 0,
    begin: 0,
    stage: 0,
    commit: 0,
    publish: 0,
    finish: 0,
    captures: 0,
  };
  const state = { document: { value: 1 }, revision: 7 };
  const host = {
    projectSyncStorageVersion: 2,
    async openProjectSyncStorage(target, guard) {
      calls.nativeOpen++;
      return openProjectSyncStorage(target, guard);
    },
  };
  class AbsSyncError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  const storageTree = source('src/app/integrations/blockly/abs/abs-host-storage.ts');
  const openDeclaration = storageTree.statements.find(
    (item) => ts.isFunctionDeclaration(item) && item.name?.text === 'openAbsHostStorage',
  );
  const { openAbsHostStorage } = evaluate(openDeclaration.getText(storageTree), {
    window: { fs: host },
    AbsSyncError,
    projectStorageBridge: (native) => native,
  });
  class Journal {
    constructor(port) {
      this.port = port;
    }
    async begin(_input, guard) {
      guard();
      await this.port.read('operation.json');
      calls.begin++;
      return 'original-journal';
    }
    async finish(id, guard) {
      assert.equal(id, 'original-journal');
      guard();
      await this.port.read('operation.json');
      calls.finish++;
    }
  }
  const tree = source('src/app/integrations/blockly/abs/abs-workspace-sync.service.ts');
  const declaration = tree.statements.find(
    (item) => ts.isClassDeclaration(item) && item.name?.text === 'AbsWorkspaceSyncService',
  );
  const method = declaration.members.find(
    (item) =>
      ts.isMethodDeclaration(item) && item.name.getText(tree) === 'publishLoadedNormalization',
  );
  const { Subject } = evaluate(`export class Subject { ${method.getText(tree)} }`, {
    AbsSyncError,
    openAbsHostStorage,
    AbsOperationJournal: Journal,
    verifyAbsLoadNormalization: async () => true,
    matchesAbsLoadNormalizationReadback: (_input, current) => current.document.value === 1,
    deferredAbsLoadNormalization: (_path, reason) => ({ status: 'DEFERRED', reason }),
    sameAbsSavedProgram: async () => true,
    captureAbsWorkspaceState: () => ({ contracts: {} }),
    hashAbsText: async (text) => crypto.createHash('sha256').update(text).digest('hex'),
    absJson: JSON.stringify,
  });
  const subject = new Subject();
  const input = {
    projectPath: project,
    originalContent: '{}',
    persistedText: '{}',
    assertCurrent() {},
    expected: { pointerHash, disk: {} },
  };
  subject.project = {
    currentProjectPath: project,
    async prepareSave(_document, guard) {
      guard();
      return { abiText: '{}' };
    },
    rememberLoadedProject() {},
  };
  subject.editor = {
    captureProjectSnapshot() {
      calls.captures++;
      return changeReadback && calls.captures > 1
        ? { ...state, document: { value: 2 }, revision: 8 }
        : state;
    },
    normalizeProjectAbi: (value) => value,
    publishAbsContext(_projection, revision) {
      assert.equal(
        revision,
        7,
        'the snapshot-producing guard still supplies the captured revision',
      );
      calls.publish++;
    },
  };
  subject.compactDocument = async (document) => document;
  subject.projection = async () => ({ map: { generation: 'original-generation' } });
  subject.assertDisk = async (_store, _expected, guard) => {
    guard();
  };
  const store = {
    async archiveRepair() {
      return { key: 'retained', hash: 'retained-hash' };
    },
    async stage() {
      calls.stage++;
    },
    async commit(_generation, guard, write) {
      guard();
      calls.commit++;
      await write('{}', null, { replace: async () => true });
      return { status: 'COMMITTED' };
    },
  };
  subject.run = (operation) =>
    operation(
      { path: project, scope: {}, workspace: {}, assertCurrent() {}, isCurrent: () => true },
      {
        assertCurrent() {},
        quarantine() {
          throw new Error('unexpected quarantine');
        },
      },
      store,
    );
  return { subject, input, calls };
}

test('first load normalization adapts its synchronous snapshot guard to real native storage void admission', async (t) => {
  const f = fixture(t);
  const result = await f.subject.publishLoadedNormalization(f.input);
  assert.equal(result.status, 'COMMITTED');
  assert.equal(f.calls.nativeOpen, 1);
  assert.equal(f.calls.begin, 1);
  assert.equal(f.calls.finish, 1);
  assert.equal(f.calls.commit, 1);
  assert.equal(f.calls.publish, 1);
});

test('existing normalization still uses its original archive and snapshot revision', async (t) => {
  const f = fixture(t, 'existing-pointer');
  assert.equal((await f.subject.publishLoadedNormalization(f.input)).status, 'COMMITTED');
  assert.equal(f.calls.nativeOpen, 0);
  assert.equal(f.calls.begin, 0);
  assert.equal(f.calls.publish, 1);
});

test('changed native readback is still deferred before opening or staging a fresh generation', async (t) => {
  const f = fixture(t, null, true);
  const result = await f.subject.publishLoadedNormalization(f.input);
  assert.equal(result.status, 'DEFERRED');
  assert.equal(result.reason, 'ABS_LOAD_NORMALIZATION_READBACK_CHANGED');
  assert.equal(f.calls.nativeOpen, 0);
  assert.equal(f.calls.stage, 0);
  assert.equal(f.calls.commit, 0);
});

for (const [name, guard] of [
  ['async', () => Promise.resolve()],
  ['snapshot-returning', () => ({ revision: 7 })],
]) {
  test(`native storage continues to reject a raw ${name} guard`, () => {
    assert.throws(projectFileGuard(guard), { code: 'PROJECT_FILE_GUARD_REQUIRED' });
  });
}
