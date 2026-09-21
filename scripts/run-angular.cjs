const { spawn } = require('node:child_process');
const path = require('node:path');
const { prepareNativeBundle } = require('./blockly-native-bundle.cjs');

async function main() {
  const args = process.argv.slice(2);
  const watch = args[0] === 'serve' || args.includes('--watch') || args.includes('--watch=true')
    || (args[0] === 'test' && !args.includes('--watch=false'));
  const bundle = ['build', 'serve', 'test'].includes(args[0]) ? await prepareNativeBundle({ watch }) : null;
  const child = spawn(process.execPath, [require.resolve('@angular/cli/bin/ng.js'), ...args], {
    cwd: path.resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true,
  });
  const onInterrupt = () => { child.kill('SIGTERM'); };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve(code ?? 1));
    });
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
    await bundle?.dispose();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
