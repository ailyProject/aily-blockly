const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const runtimeModule = path.join(repoRoot, 'electron', 'chat-runtime-lex-execution-runtime.mjs');

const args = process.argv.slice(2);
const modeIndex = args.findIndex((arg) => arg === '--mode' || arg === '-Mode');
const modeArg = modeIndex >= 0 ? args[modeIndex + 1] : 'worker';
const mode = modeArg === 'utility' ? 'utility' : 'worker';
const noCacheClean = args.includes('--no-cache-clean') || args.includes('-NoCacheClean');

if (!fs.existsSync(runtimeModule)) {
  console.error(`Missing Lex execution-host runtime module: ${runtimeModule}`);
  process.exit(1);
}

const sharpPackageJson = path.join(repoRoot, 'electron', 'node_modules', 'sharp', 'package.json');
if (!fs.existsSync(sharpPackageJson)) {
  console.error('Missing electron dependency "sharp". Run: npm install --prefix electron');
  process.exit(1);
}

if (!noCacheClean) {
  fs.rmSync(path.join(repoRoot, '.angular', 'cache'), { recursive: true, force: true });
}

const env = {
  ...process.env,
  AILY_CHAT_EXECUTION_HOST: mode,
  AILY_CHAT_EXECUTION_HOST_RUNTIME_MODULE: runtimeModule,
  AILY_CHAT_TRACE_RUNTIME_HOST: '1',
};

console.log('[AilyChat] Starting Electron with real non-renderer Lex execution host.');
console.log(`[AilyChat] AILY_CHAT_EXECUTION_HOST=${env.AILY_CHAT_EXECUTION_HOST}`);
console.log(`[AilyChat] AILY_CHAT_EXECUTION_HOST_RUNTIME_MODULE=${env.AILY_CHAT_EXECUTION_HOST_RUNTIME_MODULE}`);
console.log('');
console.log('Expected app log markers before judging performance:');
console.log('  [AilyChat][RuntimeHostBootstrapSource]');
console.log('  [AilyChat][ExecutionHostStart] {"phase":"started",...}');
console.log('  [AilyChat][ExecutionHostStart] {"phase":"ready",...}');
console.log('  [AilyChat][RuntimeOwnerRegistered] ... "kind":"worker" or "kind":"utilityProcess"');
console.log('  [AilyChat][RuntimeHostOwnerDispatch] ... "owner":{"kind":"worker" or "utilityProcess"}');
console.log('');
console.log('If those markers are absent, the run is still on the renderer fallback chain.');
console.log('');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCommand, ['run', 'electron'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 0);
