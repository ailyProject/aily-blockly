'use strict';
const { prepareBuildExecution, pruneTerminalPreprocessInputs, abandonPreparedPreprocess, inspectBlocklyCompileProof } = require('./build-execution-workspace');
process.once('message', ({ config, workspace, operation, action }) => {
    const abandoning = action === 'abandon-preprocess';
    const inspecting = action === 'inspect-compile-proof';
    const checkingCoderUpload = action === 'check-coder-upload';
    let result;
    try {
        if (checkingCoderUpload) result = { ok: true, reusable: require('./coder-upload-state').canReuseCoderUpload(config) };
        else if (inspecting) result = { ok: true, proof: inspectBlocklyCompileProof(config) };
        else if (abandoning) result = { ok: true, abandoned: abandonPreparedPreprocess(config) };
        else result = { ok: true, config: prepareBuildExecution(config, workspace, operation) };
    }
    catch (error) { result = { ok: false, error: error.message, code: error.code }; }
    process.send(result, () => {
        process.disconnect();
        // Reclaim older terminal preprocess inputs off the editor's critical path.
        if (!abandoning && !inspecting && !checkingCoderUpload) pruneTerminalPreprocessInputs(config?.currentProjectPath);
    });
});
