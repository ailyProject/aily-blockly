const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
// Use the compiler already installed with Angular, not a second version/dependency.
const esbuild = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
const outfile = path.join(root, '.generated/blockly-runtime/native-candidate.js');

function assertIndependentBundle(result) {
  const inputs = Object.keys(result.metafile.inputs).map(file => file.replaceAll('\\', '/'));
  const forbidden = inputs.find(file => /node_modules\/(?:@angular|electron)\//.test(file));
  if (forbidden) throw new Error(`Native candidate must not bundle framework/preload code: ${forbidden}`);
  const outputs = Object.values(result.metafile.outputs);
  if (outputs.length !== 1 || outputs[0].imports.length || outputs[0].exports.length) {
    throw new Error('Native candidate must be a self-contained bundle without external imports or exports.');
  }
  if (inputs.filter(file => file.endsWith('/blockly_compressed.js')).length !== 1) {
    throw new Error('Native candidate must contain exactly one installed Blockly core.');
  }
}

async function prepareNativeBundle({ watch = false } = {}) {
  const context = await esbuild.context({
    absWorkingDir: root,
    entryPoints: ['src/app/editors/blockly-editor/services/blockly-native-candidate.entry.ts'],
    outfile, bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
    // Pin the host-owned core's intrinsic in this module scope. Library scripts
    // execute separately: their scoped legacy macro facade must not replace
    // Blockly's own rendering Promise constructor.
    banner: { js: 'const Promise = globalThis.Promise;' },
    minify: true, legalComments: 'eof', metafile: true, write: false,
    tsconfig: 'tsconfig.json', logLevel: 'warning',
    plugins: [{ name: 'independent-native-bundle', setup(build) {
      // A failed rebuild must not leave a stale candidate asset usable by the UI.
      build.onStart(() => { fs.rmSync(outfile, { force: true }); });
      build.onEnd(result => {
        if (result.errors.length) return;
        assertIndependentBundle(result);
        fs.mkdirSync(path.dirname(outfile), { recursive: true });
        fs.writeFileSync(outfile, result.outputFiles[0].contents);
        fs.writeFileSync(path.join(path.dirname(outfile), 'manifest.json'), JSON.stringify({
          sha256: createHash('sha256').update(result.outputFiles[0].contents).digest('hex'),
        }));
      });
    } }],
  });
  try {
    const result = await context.rebuild();
    if (watch) await context.watch();
    else await context.dispose();
    return { dispose: () => context.dispose(), metafile: result.metafile };
  } catch (error) { await context.dispose(); throw error; }
}

module.exports = { prepareNativeBundle, assertIndependentBundle };
if (require.main === module) prepareNativeBundle().catch(error => { console.error(error); process.exitCode = 1; });
