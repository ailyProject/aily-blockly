const path = require('path');
const { Arch } = require('electron-builder');
const { prepareChildResources } = require('./prepare-child-resources');
const { packageBuildLockRuntime } = require('./package-build-lock-runtime.cjs');

module.exports = async function packageChildResources(context) {
  if (context.electronPlatformName === 'win32') require('./build-windows-process-runtime.cjs').verify(Arch[context.arch]);
  const destination = path.join(context.packager.getResourcesDir(context.appOutDir), 'child');
  await packageBuildLockRuntime({ destination, platform: context.electronPlatformName, arch: Arch[context.arch] });
  await prepareChildResources({
    platform: context.electronPlatformName,
    arch: Arch[context.arch],
    destination,
    includeCoder: context.packager.config.extraMetadata?.ailyBuildProduct === 'coder',
  });
};
