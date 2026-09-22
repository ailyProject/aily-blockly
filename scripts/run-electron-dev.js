const { spawn } = require('child_process');
const { prepareChildResources } = require('./prepare-child-resources');

function isCoderDevMode(args = []) {
  return args.includes('--coder');
}

function createElectronDevLaunchOptions(args = [], environment = {}) {
  const coderMode = isCoderDevMode(args);
  const env = {
    ...environment,
    AILY_BUILD_PRODUCT: coderMode ? 'coder' : 'blockly',
    AILY_APP_VERSION: coderMode
      ? require('../build/products/coder.json').version
      : require('../package.json').version,
  };
  delete env.ELECTRON_RUN_AS_NODE;

  return {
    coderMode,
    electronArgs: args.filter((arg) => arg !== '--coder'),
    env,
  };
}

async function main() {
  const launch = createElectronDevLaunchOptions(process.argv.slice(2), process.env);
  await prepareChildResources({ development: true, includeCoder: launch.coderMode });
  const electronPath = require('electron');

  console.log(`[electron-dev] product=${launch.env.AILY_BUILD_PRODUCT}`);
  const child = spawn(electronPath, ['./electron/main.js', ...launch.electronArgs], {
    // Let Node write Unicode to Windows terminals instead of interpreting Electron's UTF-8 as GBK.
    stdio: process.platform === 'win32' ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    env: launch.env,
  });
  child.stdout?.pipe(process.stdout, { end: false });
  child.stderr?.pipe(process.stderr, { end: false });

  child.on('close', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 0;
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[electron-dev] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  createElectronDevLaunchOptions,
  isCoderDevMode,
};
