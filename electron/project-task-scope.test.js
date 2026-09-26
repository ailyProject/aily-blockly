const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { assertProjectTaskActive, cancelProjectTaskScope, matchesProjectTask } = require('./project-task-scope');

const scope = { projectPath: path.resolve('scope-project'), projectSessionId: 'session-a' };

test('cancelled scopes survive task cleanup and isolate owners, projects and reopen sessions', () => {
  const owner = new EventEmitter(), other = new EventEmitter();
  cancelProjectTaskScope(owner, scope);
  assert.throws(() => assertProjectTaskActive(owner, scope), /PROJECT_TASK_CANCELLED/);
  assert.doesNotThrow(() => assertProjectTaskActive(other, scope));
  assert.doesNotThrow(() => assertProjectTaskActive(owner, { ...scope, projectSessionId: 'reopened' }));
  assert.doesNotThrow(() => assertProjectTaskActive(owner, { ...scope, projectPath: path.resolve('other-project') }));
  cancelProjectTaskScope(owner, scope);
  assert.equal(owner.listenerCount('destroyed'), 1);
  owner.emit('destroyed');
  assert.doesNotThrow(() => assertProjectTaskActive(owner, scope));
});

test('explicit ownership overrides cwd and legacy commands keep their exact project matching', () => {
  const owner = {};
  const entry = { ownerWebContents: owner, cwd: path.resolve('shared-appdata'), ...scope };
  assert.equal(matchesProjectTask(entry, owner, scope.projectPath, scope.projectSessionId), true);
  assert.equal(matchesProjectTask(entry, owner, entry.cwd, scope.projectSessionId), false);
  assert.equal(matchesProjectTask(entry, {}, scope.projectPath, scope.projectSessionId), false);
  assert.equal(matchesProjectTask(entry, owner, scope.projectPath, 'other-session'), false);
  assert.equal(matchesProjectTask({ ownerWebContents: owner, cwd: scope.projectPath }, owner, scope.projectPath, scope.projectSessionId), true);
  assert.throws(() => assertProjectTaskActive(owner, { projectPath: scope.projectPath }), /Invalid project task scope/);
  assert.throws(() => assertProjectTaskActive(owner, { ...scope, projectPath: 'relative' }), /Invalid project task scope/);
});

test('main stop validates its owner, cancels admission first and waits for both executors', async () => {
  const owner = Object.assign(new EventEmitter(), { mainFrame: {} });
  let handler, finishCmd, finishNpm;
  const calls = [];
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('project-commands-stop'");
  const end = source.indexOf('ipcMain.handle("project-lock-try"', start);
  assert.ok(start !== -1 && end > start);
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_name, callback) => { handler = callback; } }, path,
    mainWindow: { webContents: owner }, isCurrentMainRenderer: sender => sender === owner,
    cancelProjectTaskScope,
    killOwnerProjectCmdProcesses: (...args) => { calls.push(args); return new Promise(resolve => { finishCmd = resolve; }); },
    killOwnerProjectNpmProcesses: (...args) => { calls.push(args); return new Promise(resolve => { finishNpm = resolve; }); },
  });
  assert.equal((await handler({ sender: {}, senderFrame: owner.mainFrame }, scope)).ok, false);
  assert.doesNotThrow(() => assertProjectTaskActive(owner, scope));
  assert.equal((await handler({ sender: owner, senderFrame: {} }, scope)).ok, false);
  let resolved = false;
  const stopped = handler({ sender: owner, senderFrame: owner.mainFrame }, scope).then(result => { resolved = true; return result; });
  assert.throws(() => assertProjectTaskActive(owner, scope), /PROJECT_TASK_CANCELLED/);
  assert.equal(calls.length, 2);
  finishCmd(true); await Promise.resolve();
  assert.equal(resolved, false);
  finishNpm(false);
  assert.equal((await stopped).ok, false);
});
