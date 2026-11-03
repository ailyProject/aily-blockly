const { childScriptPath } = require('./child-script-path');

function publisher() {
  return require(childScriptPath('build-workspace-publication.js'));
}

module.exports = {
  canReuseBlocklyUpload: config => {
    return require(childScriptPath('blockly-upload-state.js')).canReuseBlocklyUpload(config);
  },
  captureBuildSource: (config, workspace) => {
    return require(childScriptPath('build-source-capture.js')).captureBuildSource(config, workspace);
  },
  GENERATED_SOURCE_ARCHIVE_VERSION: 1,
  publishArduinoGeneratedCode: (projectPath, request) => {
    const implementation = publisher();
    if (request?.preserveSuperseded === true && implementation.generatedSourceArchiveVersion !== 1) {
      throw new Error('Generated source preservation bridge unavailable; restart the host to load matching scripts.');
    }
    return implementation.publishArduinoGeneratedCode(projectPath, request);
  },
  patchBuildMetadata: (projectPath, patch) => publisher().patchBuildMetadata(projectPath, patch),
};
