'use strict';
// Shared owned-project setup for real firmware acceptance. Never an application
// implementation or a way to rewrite the user's active project.
const fs = require('node:fs'), path = require('node:path');
const { captureBuildSource } = require('../../../child/scripts/build-source-capture');
const { publishArduinoGeneratedCode, patchBuildMetadata } = require('../../build-workspace-publication');

function prepareS3Project({ mode, project, appData, fixtureSource }) {
    if (!['blockly', 'coder'].includes(mode)) throw new Error('Unsupported fixture layout.');
    const boardModule = '@aily-project/board-xiao_esp32s3', libraryName = '@aily-project/lib-delivery-fixture';
    const put = (file, value) => {
        const target = path.join(project, file); fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
    };
    for (const name of ['package.json', 'board.json']) {
        put(`node_modules/${boardModule}/${name}`, fs.readFileSync(path.join(appData, 'node_modules', boardModule, name), 'utf8'));
    }
    put(`node_modules/${libraryName}/package.json`, { name: libraryName, version: '1.0.0' });
    put(`node_modules/${libraryName}/src/DeliveryLibrary/DeliveryLibrary.h`, '#pragma once\n#define DELIVERY_VALUE 17\n');
    put('package.json', { name: `delivery-${mode}`, type: mode, dependencies: { [boardModule]: '3.3.1', [libraryName]: '1.0.0' } });
    const sourceDirectory = mode === 'coder' ? 'sketch/src' : 'src';
    put(`${sourceDirectory}/delivery_helper.h`, '#pragma once\n');
    const source = (mode === 'blockly' ? '#include "variables_fixture-1234abcd.h"\n' : '')
        + '#include "delivery_helper.h"\n#include <DeliveryLibrary.h>\nstatic_assert(DELIVERY_VALUE == 17, "library projection");\n'
        + fs.readFileSync(fixtureSource, 'utf8');
    if (mode === 'coder') put(`${sourceDirectory}/main.cpp`, source);
    else publishArduinoGeneratedCode(project, { artifacts: [{ fileName: 'variables_fixture-1234abcd.h',
        content: '#pragma once\nstatic_assert(17 == 17, "generated fixture header");\n', sourceTag: 'fixture' }], sketchCode: source });
    patchBuildMetadata(project, { codeHash: 'b'.repeat(64) });
    const config = { currentProjectPath: project, boardModule, code: source, appDataPath: appData };
    const workspaceCapture = mode === 'blockly' ? { documentText: '{"fixture":"source-capture"}', revision: 1, runtimeRevision: 1, pageId: 'main' } : undefined;
    config.sourceCapture = captureBuildSource(config, workspaceCapture);
    return { config, workspaceCapture, source, sourceDirectory: path.join(project, sourceDirectory) };
}
module.exports = { prepareS3Project };
