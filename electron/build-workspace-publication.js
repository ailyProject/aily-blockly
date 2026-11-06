const { childScriptPath } = require('./child-script-path');

function publisher() {
  return require(childScriptPath('build-workspace-publication.js'));
}

module.exports = {
  ISOLATED_BUILD_EXECUTION_VERSION: 1,
  prepareBuildExecution: (config, workspace, operation) => new Promise((resolve, reject) => {
    // Source/library IO must not block the editor's renderer event loop.
    // Electron preload cannot create Node worker_threads. Use the same managed
    // Node distributed with the external build scripts, without a PATH lookup.
    const entry = childScriptPath('build-execution-worker.js');
    const path = require('node:path');
    const executable = process.versions.electron
      ? require('./tools/managed-npm-cli').getChildNodeExecutable(path.dirname(path.dirname(entry)))
      : process.execPath;
    if (!path.isAbsolute(executable)) throw new Error('The managed build Node runtime is unavailable.');
    const env = { ...process.env };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
    const worker = require('node:child_process').fork(entry, [], { execPath: executable, execArgv: [],
      env, windowsHide: true, serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let settled = false;
    worker.once('message', value => {
      settled = true;
      if (value.ok) resolve(value.config);
      else reject(Object.assign(new Error(value.error), { code: value.code }));
    });
    worker.once('error', reject);
    worker.once('exit', code => { if (!settled) reject(new Error(`Build input capture exited before its receipt (${code}).`)); });
    worker.send({ config, workspace, operation }, error => { if (error) reject(error); });
  }),
  resolveBuildExecution: project => require(childScriptPath('build-execution-workspace.js')).resolveBuildExecution(project),
  resolveBuildProjectPath: project => require(childScriptPath('build-execution-workspace.js')).resolveBuildProjectPath(project),
  inspectBuildExecution: (project, requestId) => require(childScriptPath('build-execution-workspace.js')).inspectBuildExecution(project, requestId),
  cancelBuildExecution: config => require(childScriptPath('build-execution-workspace.js')).cancelBuildExecution(config),
  canReuseBlocklyUpload: config => {
    const execution = require(childScriptPath('build-execution-workspace.js'));
    if (execution.resolveBuildExecution(config.currentProjectPath)) return execution.canReuseBuildExecution(config);
    // New hosts never certify old shared outputs, including after a failed or
    // cancelled private build. Only the execution receipt grants upload reuse.
    return false;
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
