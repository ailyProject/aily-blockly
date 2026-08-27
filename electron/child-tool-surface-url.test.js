const assert = require('node:assert/strict');
const test = require('node:test');
const esbuild = require('esbuild');

const utilityPromise = loadUtility();

test('maps package-relative Surface entries to the Runtime UI web root', async () => {
  const { resolveRuntimeSurfaceEntry } = await utilityPromise;

  assert.equal(resolveRuntimeSurfaceEntry('ui/index.html', 'ui/index.html'), '');
  assert.equal(
    resolveRuntimeSurfaceEntry('dist/fixture/ui/index.html', 'dist/fixture/ui/index.html'),
    '',
  );
  assert.equal(
    resolveRuntimeSurfaceEntry('ui/compact/index.html', 'ui/index.html'),
    'compact/index.html',
  );
  assert.equal(
    resolveRuntimeSurfaceEntry('dist/fixture/ui/compact.html', 'dist/fixture/ui/index.html'),
    'compact.html',
  );
  assert.equal(
    resolveRuntimeSurfaceEntry('other/compact.html', 'ui/index.html'),
    'other/compact.html',
  );
  assert.equal(
    resolveRuntimeSurfaceEntry('ui\\compact.html', 'ui\\index.html'),
    'compact.html',
  );
});

async function loadUtility() {
  const result = await esbuild.build({
    stdin: {
      contents: "export { resolveRuntimeSurfaceEntry } from './src/app/tools/child-tool-surface-host/child-tool-surface-url.ts';",
      resolveDir: process.cwd(),
      sourcefile: 'child-tool-surface-url-test-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  });
  const moduleRecord = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(
    require,
    moduleRecord,
    moduleRecord.exports,
  );
  return moduleRecord.exports;
}
