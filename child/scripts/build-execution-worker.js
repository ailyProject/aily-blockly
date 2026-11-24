'use strict';
const { prepareBuildExecution, pruneTerminalPreprocessInputs, abandonPreparedPreprocess, inspectBlocklyCompileProof,
    clearSharedBuildCache, resolveBuildExecution } = require('./build-execution-workspace');
process.once('message', ({ config, workspace, operation, action, shared, projectPath, preserveSketch }) => {
    const abandoning = action === 'abandon-preprocess';
    const inspecting = action === 'inspect-compile-proof';
    const checkingCoderUpload = action === 'check-coder-upload';
    const clearing = action === 'clear-shared-build-cache';
    const resolving = action === 'resolve-build-execution';
    let result;
    try {
        if (checkingCoderUpload) result = { ok: true, reusable: require('./coder-upload-state').canReuseCoderUpload(config) };
        else if (inspecting) result = { ok: true, proof: inspectBlocklyCompileProof(config) };
        else if (abandoning) result = { ok: true, abandoned: abandonPreparedPreprocess(config) };
        else if (clearing) result = { ok: true, result: clearSharedBuildCache(projectPath, { preserveSketch }) };
        else if (resolving) result = { ok: true, execution: resolveBuildExecution(projectPath) };
        else result = { ok: true, config: prepareBuildExecution(config, workspace, operation, { shared }) };
    }
    catch (error) { result = { ok: false, error: error.message, code: error.code }; }
    process.send(result, () => {
        process.disconnect();
        // Reclaim older terminal preprocess inputs off the editor's critical path.
        if (!abandoning && !inspecting && !checkingCoderUpload && !clearing && !resolving) {
            pruneTerminalPreprocessInputs(config?.currentProjectPath, shared === true);
        }
    });
});
