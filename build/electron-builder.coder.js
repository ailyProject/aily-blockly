const packageJson = require('../package.json');
const coderRelease = require('./products/coder.json');
const appConfig = require('../electron/config/config.json');
const {
  createBuilderConfig,
  createBuildPlan,
} = require('../scripts/build-electron');

const coderIcon = 'public/icon-aci.ico';
const coderMacIcon = 'public/icon-512-coder.ico';

const plan = createBuildPlan([
  '--product',
  'coder',
  '--flavor',
  process.env.AILY_BUILD_FLAVOR || 'cn',
], appConfig);

module.exports = createBuilderConfig(plan, {
  ...packageJson.build,
  extraMetadata: {
    ...(packageJson.build.extraMetadata || {}),
    version: coderRelease.version,
  },
  extraResources: (packageJson.build.extraResources || []).map((resource) => (
    resource?.to === 'icon.ico'
      ? { ...resource, from: coderIcon }
      : resource
  )),
  win: {
    ...packageJson.build.win,
    icon: coderIcon,
  },
  mac: {
    ...packageJson.build.mac,
    icon: coderMacIcon,
  },
  linux: {
    ...packageJson.build.linux,
    icon: coderIcon,
  },
});
