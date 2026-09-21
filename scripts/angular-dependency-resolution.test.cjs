const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const { architect } = require('../angular.json').projects['aily-blockly'];
const esbuild = createRequire(require.resolve('@angular/build/package.json'))('esbuild');

test('application and test builds resolve installed dependency real paths', () => {
  for (const target of ['build', 'test']) {
    assert.equal(architect[target].options.preserveSymlinks, false, target);
  }
});

test('Mermaid and its lazy diagrams bundle with the application resolution policy', async () => {
  const result = await esbuild.build({
    absWorkingDir: root,
    stdin: { contents: "import mermaid from 'mermaid'; export default mermaid;", resolveDir: root },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    preserveSymlinks: architect.build.options.preserveSymlinks,
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  assert.ok(Object.keys(result.metafile.inputs).some(file => /es-toolkit[\\/]/.test(file)));
  assert.ok(result.outputFiles[0].contents.length > 0);
});
