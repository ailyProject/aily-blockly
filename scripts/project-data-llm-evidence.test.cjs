const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { roundSettled, progressKey, assertRoundTools, readFreshBuild } = require('./project-data-llm-evidence.cjs');

const snapshot = () => ({ isIdle: true, phase: 'idle', snapshotRevision: 1,
  messages: [{ role: 'user' }, { role: 'assistant' }],
  toolExecutions: [{ toolCallId: 'write1', toolName: 'abs_apply', status: 'success' },
    { toolCallId: 'build1', toolName: 'project_build', status: 'success' }] });

test('a previous idle answer and successful build cannot satisfy the next round', () => {
  const previous = snapshot(), current = snapshot();
  assert.equal(roundSettled(current, previous), false);
  assert.throws(() => assertRoundTools(current, previous), /this LLM round/);
  current.messages.push({ role: 'user' });
  assert.equal(roundSettled(current, previous), false);
  current.messages.push({ role: 'assistant' });
  assert.equal(roundSettled(current, previous), true);
  current.toolExecutions.push({ toolCallId: 'write2', toolName: 'abs_import', status: 'success' });
  assert.throws(() => assertRoundTools(current, previous), /native build/);
  current.toolExecutions.push({ toolCallId: 'build2', toolName: 'project_build', status: 'success' });
  assert.equal(assertRoundTools(current, previous).length, 2);
});

test('read-only snapshot revisions do not reset the inactivity watchdog', () => {
  const before = snapshot(), after = snapshot(); after.snapshotRevision++;
  assert.equal(progressKey(before), progressKey(after));
  after.messages.push({ role: 'assistant', content: 'progress' });
  assert.notEqual(progressKey(before), progressKey(after));
});

test('fresh build metadata alone cannot disguise a stale ELF or sketch', t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-llm-evidence-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.mkdirSync(path.join(project, '.build')); fs.mkdirSync(path.join(project, '.temp/sketch'), { recursive: true });
  const started = Date.now() - 1000;
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ buildInfo: {
    lastBuildStatus: 'success', lastBuildTime: new Date().toISOString(),
    lastBuildCode: createHash('sha256').update('int counter = 9;').digest('hex') } }));
  const sketch = path.join(project, '.temp/sketch/sketch.ino'), elf = path.join(project, '.build/sketch.elf');
  fs.writeFileSync(sketch, 'int counter = 9;'); fs.writeFileSync(elf, 'linked binary');
  assert.equal(readFreshBuild(project, started).binaries.length, 1);
  fs.writeFileSync(sketch, 'int counter = 10;');
  assert.throws(() => readFreshBuild(project, started), /current generated source/);
  fs.writeFileSync(sketch, 'int counter = 9;');
  fs.utimesSync(elf, new Date(0), new Date(0));
  assert.throws(() => readFreshBuild(project, started), /Fresh linked ELF/);
  fs.utimesSync(sketch, new Date(0), new Date(0));
  assert.throws(() => readFreshBuild(project, started), /freshly prepared sketch/);
});
