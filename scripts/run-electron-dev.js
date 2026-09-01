const { spawn } = require('child_process');

function isCoderDevMode(args = []) {
  return args.includes('--coder');
}

function createElectronDevLaunchOptions(args = [], environment = {}) {
  const coderMode = isCoderDevMode(args);
  const env = {
    ...environment,
    AILY_BUILD_PRODUCT: coderMode ? 'coder' : 'blockly',
  };
  delete env.ELECTRON_RUN_AS_NODE;

  return {
    coderMode,
    electronArgs: args.filter((arg) => arg !== '--coder'),
    env,
  };
}

function main() {
  const electronPath = require('electron');
  const launch = createElectronDevLaunchOptions(process.argv.slice(2), process.env);

  console.log(`[electron-dev] product=${launch.env.AILY_BUILD_PRODUCT}`);
  const child = spawn(electronPath, ['./electron/main.js', ...launch.electronArgs], {
    stdio: 'inherit',
    env: launch.env,
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  createElectronDevLaunchOptions,
  isCoderDevMode,
};
