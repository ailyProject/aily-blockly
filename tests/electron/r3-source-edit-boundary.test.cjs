const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'tests/test-results', `r3-source-edit-boundary-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const source = path.join(root, 'src/app/integrations/blockly/abs/abs-edit-provenance.ts');
fs.copyFileSync(source, path.join(output, 'abs-edit-provenance.ts'));
const bundle = path.join(output, 'edits.cjs');
buildSync({ absWorkingDir: root, stdin: { contents: "export * from './src/app/integrations/blockly/abs/abs-edit-provenance'; export * from './src/app/integrations/blockly/abs/abs-syntax';",
  resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent', alias: {
    '@domain/project/public-api': path.join(__dirname, 'fixtures/r0-publication-domain-exports.ts'),
    '@domain/project/project-data/public-api': path.join(__dirname, 'fixtures/r0-publication-domain-exports.ts'),
  } });
const kernel = require(bundle);
console.log('R3_ARTIFACTS ' + output);
const header = '# ABS Schema: 2\n';
const before = header + 'thing(N=0)\n'.repeat(1100);
const edits = Array.from({ length: 1100 }, (_, i) => ({ start: header.length + i * 11 + 8, end: header.length + i * 11 + 9, text: '1' }));
const after = header + 'thing(N=1)\n'.repeat(1100);
test('external legacy wire keeps its bounded edit payload admission', () => {
  assert.throws(() => kernel.assertAbsSourceEdits([edits]), { code: 'ABS_SOURCE_EDITS_INVALID' });
});
test('internal immutable candidate replay has no legacy payload-count identity gate', () => {
  const result = kernel.inspectAbsSourceEdits(before, after, kernel.parseAbsSyntax(before), kernel.parseAbsSyntax(after), [edits]);
  assert.equal(result.matches.size, 1100); assert.equal(result.replaced.size, 0);
});
test('internal replay still rejects overlapping ranges and mismatched final source bytes', () => {
  assert.throws(() => kernel.inspectAbsSourceEdits('thing(N=0)', 'thing(N=1)', [], [], [[
    { start: 0, end: 3, text: 'x' }, { start: 2, end: 5, text: 'y' },
  ]]), { code: 'ABS_SOURCE_EDITS_INVALID' });
  assert.throws(() => kernel.inspectAbsSourceEdits('thing(N=0)', 'thing(N=2)', [], [], [[
    { start: 8, end: 9, text: '1' },
  ]]), { code: 'ABS_SOURCE_EDITS_STALE' });
});
