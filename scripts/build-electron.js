const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const flavorIndex = args.indexOf('--flavor');
const requestedFlavor = flavorIndex >= 0 ? args[flavorIndex + 1] : 'cn';
const buildFlavor = requestedFlavor === 'global' ? 'global' : 'cn';
const artifactPrefix = buildFlavor === 'cn' ? 'aily-blockly-CN' : 'aily-blockly';
const officialRegionKey = buildFlavor === 'global' ? 'eu' : 'cn';
const workspaceRoot = path.resolve(__dirname, '..');
const appConfig = require(path.join(workspaceRoot, 'electron', 'config', 'config.json'));
const updateBaseUrl = appConfig?.regions?.[officialRegionKey]?.updater;

if (!updateBaseUrl) {
  console.error(`Missing updater URL for flavor "${buildFlavor}" (region: ${officialRegionKey})`);
  process.exit(1);
}

const builderArgs = [
  'build',
  `-c.extraMetadata.ailyBuildFlavor=${buildFlavor}`,
  '-c.publish.provider=generic',
  `-c.publish.url=${updateBaseUrl}`,
  `-c.win.artifactName=${artifactPrefix}-\${version}.\${ext}`,
  `-c.nsis.artifactName=${artifactPrefix}-Setup-\${version}.\${ext}`,
  `-c.mac.artifactName=${artifactPrefix}-macos-\${version}-\${arch}.\${ext}`
];
const ngCliPath = path.join(workspaceRoot, 'node_modules', '@angular', 'cli', 'bin', 'ng.js');
const electronBuilderCliPath = path.join(workspaceRoot, 'node_modules', 'electron-builder', 'cli.js');

function run(commandArgs, extraEnv = {}) {
  const result = spawnSync(process.execPath, commandArgs, {
    stdio: 'inherit',
    cwd: workspaceRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      AILY_BUILD_FLAVOR: buildFlavor,
      AILY_BUILD_ARTIFACT_PREFIX: artifactPrefix,
      AILY_BUILD_UPDATER_URL: updateBaseUrl,
      ...extraEnv
    }
  });

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

run([ngCliPath, 'build', '--base-href', './']);
run([electronBuilderCliPath, ...builderArgs]);