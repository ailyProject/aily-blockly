const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const hash = value => createHash('sha256').update(value).digest('hex');

function roundTools(session, previous) {
  const seen = new Set((previous?.toolExecutions ?? []).map(tool => tool.toolCallId));
  return session.toolExecutions.filter(tool => !seen.has(tool.toolCallId));
}

function roundSettled(session, previous) {
  const users = messages => messages.filter(message => message.role === 'user').length;
  const lastUser = session.messages.findLastIndex(message => message.role === 'user');
  return session.isIdle && users(session.messages) > users(previous?.messages ?? [])
    && session.messages.slice(lastUser + 1).some(message => message.role === 'assistant');
}

// snapshotRevision increases when read, even without Agent work. It is not a progress signal.
function progressKey(session) {
  return hash(JSON.stringify([session.phase, session.streamingAssistantTimestamp, session.messages, session.toolExecutions]));
}

function assertRoundTools(session, previous) {
  const tools = roundTools(session, previous);
  assert.ok(tools.some(tool => ['abs_apply', 'abs_import'].includes(tool.toolName) && tool.status === 'success'),
    'No successful ABS write in this LLM round');
  assert.ok(tools.some(tool => tool.toolName === 'project_build' && tool.status === 'success'),
    'No successful native build in this LLM round');
  return tools;
}

function readFreshBuild(project, started) {
  const { buildInfo } = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
  assert.equal(buildInfo?.lastBuildStatus, 'success');
  assert.ok(Date.parse(buildInfo.lastBuildTime) >= started, 'Stale build metadata cannot count');
  const sketch = path.join(project, '.temp/sketch/sketch.ino');
  assert.ok(fs.statSync(sketch).mtimeMs >= started, 'Build must use a freshly prepared sketch');
  const code = fs.readFileSync(sketch, 'utf8');
  assert.equal(buildInfo.lastBuildCode, hash(code), 'Build receipt must identify the current generated source');
  const binaries = fs.readdirSync(path.join(project, '.build'), { recursive: true })
    .filter(file => /\.(bin|elf|hex)$/.test(file)).map(file => {
      const absolute = path.join(project, '.build', file), bytes = fs.readFileSync(absolute);
      return { file, bytes: bytes.length, hash: hash(bytes), modifiedAt: fs.statSync(absolute).mtimeMs };
    });
  assert.ok(binaries.some(file => /\.elf$/.test(file.file) && file.bytes > 0 && file.modifiedAt >= started),
    'Fresh linked ELF must exist; a cached binary cannot count');
  return { buildInfo, code, codeHash: hash(code), binaries };
}

module.exports = { roundTools, roundSettled, progressKey, assertRoundTools, readFreshBuild };
