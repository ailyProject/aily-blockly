const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertLinkedAgentResourcesCurrent } = require('./project-data-linked-chat-smoke.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-chat-rules-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = path.join(root, 'aily-agent'), chat = path.join(root, 'aily-chat');
  const source = path.join(agent, 'src/skills/aily-blockly-project');
  const bundled = path.join(chat, 'dist/aily-chat/runtime/resources/skills/aily-blockly-project');
  fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(bundled, { recursive: true });
  fs.writeFileSync(path.join(chat, 'dist/aily-chat/package.json'), '{}');
  fs.writeFileSync(path.join(source, 'SKILL.md'), 'same rules');
  fs.writeFileSync(path.join(bundled, 'SKILL.md'), 'same rules');
  return { agent, chat, source, bundled };
}

test('linked portable Chat must use the current Agent rule resources', t => {
  const f = fixture(t);
  assert.deepEqual(assertLinkedAgentResourcesCurrent(f.agent, f.chat), { portable: true, comparedRules: 1 });
  fs.writeFileSync(path.join(f.bundled, 'SKILL.md'), 'old rules');
  assert.throws(() => assertLinkedAgentResourcesCurrent(f.agent, f.chat), /stale Agent rules/);
});

test('missing, extra and changed references cannot masquerade as current rules', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.source, 'references'));
  fs.writeFileSync(path.join(f.source, 'references/variables.md'), 'variable contract');
  assert.throws(() => assertLinkedAgentResourcesCurrent(f.agent, f.chat), /stale Agent rules/);
  fs.mkdirSync(path.join(f.bundled, 'references'));
  fs.copyFileSync(path.join(f.source, 'references/variables.md'), path.join(f.bundled, 'references/variables.md'));
  assert.equal(assertLinkedAgentResourcesCurrent(f.agent, f.chat).comparedRules, 2);
  fs.writeFileSync(path.join(f.bundled, 'obsolete.md'), 'removed');
  assert.throws(() => assertLinkedAgentResourcesCurrent(f.agent, f.chat), /stale Agent rules/);
});
