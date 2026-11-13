'use strict';
const { prepareBuildExecution, pruneTerminalPreprocessInputs, abandonPreparedPreprocess, inspectBlocklyCompileProof } = require('./build-execution-workspace');
process.once('message', ({ config, workspace, operation, action }) => {
    const abandoning = action === 'abandon-preprocess';
    const inspecting = action === 'inspect-compile-proof';
    let result;
    try {
        result = inspecting ? { ok: true, proof: inspectBlocklyCompileProof(config) }
            : abandoning ? { ok: true, abandoned: abandonPreparedPreprocess(config) }
            : { ok: true, config: prepareBuildExecution(config, workspace, operation) };
    }
    catch (error) { result = { ok: false, error: error.message, code: error.code }; }
    process.send(result, () => {
        process.disconnect();
        // Reclaim older terminal preprocess inputs off the editor's critical path.
        if (!abandoning && !inspecting) pruneTerminalPreprocessInputs(config?.currentProjectPath);
    });
});
