const path = require('path');
const { Arch } = require('electron-builder');
const { prepareChildResources } = require('./prepare-child-resources');

module.exports = async function packageChildResources(context) {
  await prepareChildResources({
    platform: context.electronPlatformName,
    arch: Arch[context.arch],
    destination: path.join(context.packager.getResourcesDir(context.appOutDir), 'child'),
    includeCoder: context.packager.config.extraMetadata?.ailyBuildProduct === 'coder',
  });
};
