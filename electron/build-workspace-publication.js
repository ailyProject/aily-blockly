const path = require('node:path');

function publisher() {
  const childRoot = process.env.AILY_CHILD_PATH || path.join(__dirname, '..', 'child');
  return require(path.join(childRoot, 'scripts/build-workspace-publication.js'));
}

module.exports = {
  captureBuildSource: (config, workspace) => {
    const childRoot = process.env.AILY_CHILD_PATH || path.join(__dirname, '..', 'child');
    return require(path.join(childRoot, 'scripts/build-source-capture.js')).captureBuildSource(config, workspace);
  },
  publishArduinoGeneratedCode: (projectPath, request) => publisher().publishArduinoGeneratedCode(projectPath, request),
  patchBuildMetadata: (projectPath, patch) => publisher().patchBuildMetadata(projectPath, patch),
};
