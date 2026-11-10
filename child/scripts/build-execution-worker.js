'use strict';
const { prepareBuildExecution, pruneTerminalPreprocessInputs, abandonPreparedPreprocess } = require('./build-execution-workspace');
process.once('message', ({ config, workspace, operation, action }) => {
    const abandoning = action === 'abandon-preprocess';
    let result;
    try {
        result = abandoning ? { ok: true, abandoned: abandonPreparedPreprocess(config) }
            : { ok: true, config: prepareBuildExecution(config, workspace, operation) };
    }
    catch (error) { result = { ok: false, error: error.message, code: error.code }; }
    process.send(result, () => {
        process.disconnect();
        // Reclaim older terminal preprocess inputs off the editor's critical path.
        if (!abandoning) pruneTerminalPreprocessInputs(config?.currentProjectPath);
    });
});
