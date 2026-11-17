const path = require('path');
const { Arch } = require('electron-builder');
const windowsProcess = require('./build-windows-process-runtime.cjs');
const { prepareChildResources } = require('./prepare-child-resources');
const { packageBuildLockRuntime } = require('./package-build-lock-runtime.cjs');

module.exports = async function packageChildResources(context) {
  try {
    windowsProcess.verifyPackaged(context);
    const destination = path.join(context.packager.getResourcesDir(context.appOutDir), 'child');
    await packageBuildLockRuntime({ destination, platform: context.electronPlatformName, arch: Arch[context.arch] });
    await prepareChildResources({
      platform: context.electronPlatformName,
      arch: Arch[context.arch],
      destination,
      includeCoder: context.packager.config.extraMetadata?.ailyBuildProduct === 'coder',
    });
    windowsProcess.smokePackaged(context);
  } finally { windowsProcess.releasePackLease(context); }
};
