'use strict';

const { spawnSync } = require('node:child_process');

/** Probe once per compile. Only legacy ordinary Artifact output may use help fallback. */
function readBuilderCapabilities(command, launch = spawnSync) {
    const options = { shell: true, encoding: 'utf8', windowsHide: true, timeout: 5000 };
    try {
        const result = launch(command, ['capabilities', '--json'], options);
        if (result.status === 0) {
            const data = JSON.parse(result.stdout || '{}');
            if (data.schemaVersion === 1) {
                const c = data.capabilities || {};
                return {
                    artifact: c.simulationArtifactManifest?.schemaVersion === 1,
                    debug: c.simulationSourceDebug?.schemaVersion === 1 && c.simulationSourceDebug.cliOption === '--simulation-debug',
                    graph: c.sceneGraphProvenance?.schemaVersion === 1 && c.sceneGraphProvenance.cliOption === '--graph-semantic-revision',
                    inputs: c.buildInputRecord?.schemaVersion === 1 && c.buildInputRecord.cliOption === '--record-build-inputs'
                        && c.buildInputRecord.scope === 'build-graph-facts' && c.buildInputRecord.currentProjectFreshness === false
                        && c.buildInputRecord.defaultFileName === 'aily-build-inputs.json',
                    workspace: c.buildWorkspaceLease?.schemaVersion === 1 && c.buildWorkspaceLease.delegationEnvironment === 'AILY_BUILDER_WORKSPACE',
                };
            }
        }
    } catch { /* Older Builder can still perform ordinary compilation. */ }
    try {
        const result = launch(command, ['compile', '--help'], options);
        return { artifact: result.status === 0 && `${result.stdout || ''}\n${result.stderr || ''}`.includes('--emit-artifact-manifest'), debug: false, graph: false, inputs: false, workspace: false };
    } catch { return { artifact: false, debug: false, graph: false, inputs: false, workspace: false }; }
}

module.exports = { readBuilderCapabilities };
