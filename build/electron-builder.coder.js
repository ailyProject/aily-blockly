const packageJson = require('../package.json');
const coderRelease = require('./products/coder.json');
const appConfig = require('../electron/config/config.json');
const {
  createBuilderConfig,
  createBuildPlan,
} = require('../scripts/build-electron');

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
});
