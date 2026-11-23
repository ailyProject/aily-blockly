'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_INPUTS = ['src', 'components', 'partitions.csv'];

function blocklyProjectBuildInputs(root) {
    // Converted audio is consumed by the toolchain. The editor's source
    // recordings under assets/audio are not compiler inputs.
    const audio = fs.lstatSync(path.join(root, 'audio'), { throwIfNoEntry: false });
    if (audio?.isSymbolicLink()) {
        throw Object.assign(new Error('BUILD_EXECUTION_INVALID: Linked project audio is not a build input.'),
            { code: 'BUILD_EXECUTION_INVALID' });
    }
    return audio?.isDirectory() ? [...SOURCE_INPUTS, 'audio'] : SOURCE_INPUTS;
}

module.exports = { blocklyProjectBuildInputs };
