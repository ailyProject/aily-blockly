'use strict';
const { prepareBuildExecution, pruneTerminalPreprocessInputs } = require('./build-execution-workspace');
process.once('message', ({ config, workspace, operation }) => {
    let result;
    try { result = { ok: true, config: prepareBuildExecution(config, workspace, operation) }; }
    catch (error) { result = { ok: false, error: error.message, code: error.code }; }
    process.send(result, () => {
        process.disconnect();
        // Reclaim older terminal preprocess inputs off the editor's critical path.
        pruneTerminalPreprocessInputs(config?.currentProjectPath);
    });
});
