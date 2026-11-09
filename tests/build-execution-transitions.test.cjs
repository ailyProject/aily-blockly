'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const execution = require('../child/scripts/build-execution-workspace');
const { tryAcquireFileLock } = require('../child/scripts/native-file-lock');
const { acquireBuildWorkspace } = require('../child/scripts/build-workspace-lease');

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-execution-transition-')));
    const project = path.join(root, 'project'), board = '@aily-project/board-transition-probe';
    fs.mkdirSync(path.join(project, 'node_modules', board), { recursive: true });
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'transition-probe', dependencies: { [board]: '1.0.0' } }));
    fs.writeFileSync(path.join(project, 'project.abi'), JSON.stringify({ pages: [{ id: 'main', opaque: 'retain' }] }));
    fs.writeFileSync(path.join(project, 'node_modules', board, 'package.json'), JSON.stringify({ name: board, version: '1.0.0' }));
    fs.writeFileSync(path.join(project, 'node_modules', board, 'board.json'), '{}');
    t.after(() => {
        assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
        assert.match(path.basename(root), /^aily-execution-transition-/);
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, project, config: { currentProjectPath: project, boardModule: board, code: 'int value = 1;\n' } };
}

test('a real background execution transition cannot reject another request admission on the same project', async t => {
    const f = fixture(t), background = execution.prepareBuildExecution({ ...f.config, buildRequestId: 'background-preprocess' }, undefined, 'preprocess');
    const folder = path.dirname(execution.recordFor(background).root);
    const childFile = path.join(f.root, 'background.js');
    fs.writeFileSync(childFile, `
      const fs = require('node:fs');
      const e = require(${JSON.stringify(path.join(__dirname, '../child/scripts/build-execution-workspace.js'))});
      const {acquireBuildWorkspace} = require(${JSON.stringify(path.join(__dirname, '../child/scripts/build-workspace-lease.js'))});
      const config = JSON.parse(fs.readFileSync(process.argv[2]));
      const lease = acquireBuildWorkspace(config.currentProjectPath, 'preprocess');
      const rename = fs.renameSync; let armed = true;
      fs.renameSync = (source, target) => {
        if (armed && target === ${JSON.stringify(path.join(folder, 'execution.json'))}) {
          armed = false; process.send({kind:'transition-held'});
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
        }
        return rename(source, target);
      };
      try { e.startBuildExecution(config, lease); e.finishBuildExecution(config, false); }
      finally { lease.release(); }
    `);
    const child = fork(childFile, [path.join(folder, 'config.json')], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
    const exited = once(child, 'exit');
    try {
        const [message] = await once(child, 'message'); assert.equal(message.kind, 'transition-held');
        const foreground = execution.prepareBuildExecution({ ...f.config, buildRequestId: 'original-foreground-request' });
        assert.equal(foreground.execution.buildRequestId, 'original-foreground-request');
        assert.equal(execution.inspectBuildExecution(f.project, 'original-foreground-request').executionId, foreground.execution.id);
        assert.equal(execution.inspectBuildExecution(f.project, 'original-foreground-request').status, 'prepared');
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(foreground.currentProjectPath, 'project.abi'))),
            JSON.parse(fs.readFileSync(path.join(f.project, 'project.abi'))));
    } finally { const [code] = await exited; assert.equal(code, 0, stderr); }
});

test('start and finish of one execution retain their exclusive metadata transition guard', t => {
    const f = fixture(t), config = execution.prepareBuildExecution({ ...f.config, buildRequestId: 'one-execution' });
    const { folder } = execution.recordFor(config), lease = acquireBuildWorkspace(config.currentProjectPath, 'compile');
    let guard = tryAcquireFileLock(path.join(folder, 'transition.guard'));
    try {
        assert.throws(() => execution.startBuildExecution(config, lease), { code: 'BUILD_WORKSPACE_BUSY' });
        guard.close(); execution.startBuildExecution(config, lease);
        guard = tryAcquireFileLock(path.join(folder, 'transition.guard'));
        assert.throws(() => execution.finishBuildExecution(config, false), { code: 'BUILD_WORKSPACE_BUSY' });
        guard.close(); execution.finishBuildExecution(config, false);
        assert.equal(execution.inspectBuildExecution(f.project, 'one-execution').status, 'failed');
    } finally { guard.close(); lease.release(); }
});

test('cancellation remains the irreversible first-writer outcome while a transition is busy', t => {
    const f = fixture(t), config = execution.prepareBuildExecution({ ...f.config, buildRequestId: 'cancelled-original' });
    const { folder } = execution.recordFor(config), lease = acquireBuildWorkspace(config.currentProjectPath, 'compile');
    execution.startBuildExecution(config, lease);
    const guard = tryAcquireFileLock(path.join(folder, 'transition.guard'));
    try {
        assert.equal(execution.cancelBuildExecution(config).status, 'cancelled');
        assert.throws(() => execution.finishBuildExecution(config, true), { code: 'BUILD_WORKSPACE_BUSY' });
    } finally { guard.close(); }
    execution.finishBuildExecution(config, true); lease.release();
    assert.equal(execution.inspectBuildExecution(f.project, 'cancelled-original').status, 'cancelled');
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'outcome.json'))).status, 'cancelled');
});

test('a real global admission owner still fails closed with the original request and no published receipt', t => {
    const f = fixture(t), previous = execution.prepareBuildExecution({ ...f.config, buildRequestId: 'existing-request' });
    const { store } = execution.recordFor(previous), pointer = fs.readFileSync(store.pointer);
    const guard = tryAcquireFileLock(store.anchor), requestId = 'blocked-original-request';
    try {
        assert.throws(() => execution.prepareBuildExecution({ ...f.config, buildRequestId: requestId }), { code: 'BUILD_WORKSPACE_BUSY' });
        assert.equal(execution.inspectBuildExecution(f.project, requestId), null);
        assert.ok(fs.readFileSync(store.pointer).equals(pointer));
        const index = createHash('sha256').update(requestId).digest('hex') + '.json';
        assert.equal(fs.existsSync(path.join(store.parent, 'requests', index)), false);
        assert.equal(JSON.parse(fs.readFileSync(path.join(store.parent, previous.execution.id, 'execution.json'))).status, 'prepared');
    } finally { guard.close(); }
});
